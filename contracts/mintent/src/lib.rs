//! Mintent contract.
//!
//! Every pack bought through Mintent is a NEP-171 token. Each token has its own Solana address,
//! derived by the NEAR MPC network (Chain Signatures) from this contract's account id and the path
//! `card/<token_id>`. The real Collector Crypt card is delivered to that address.
//!
//! Trust model (what this contract enforces):
//! - Only the **current NEP-171 owner** of a token can ask this contract to sign for `card/<token_id>`.
//!   Transferring the token on NEAR therefore transfers control of the Solana card; the previous owner
//!   loses the ability to sign the moment the transfer executes.
//! - Only the **relayer** can mint sealed packs, record what a pack contained, and sign for the
//!   Mintent treasury path (`treasury`), which pays Collector Crypt for packs.
//! - A Solana signature outlives the NEAR state that authorised it, so ownership alone is not enough. Before
//!   signing for a card the contract parses the Solana message and allows only known-safe instructions
//!   (`solana.rs`), and it locks the token against NEP-171 transfer:
//!   * every card signature locks the token for `SIGN_LOCK_MS`, longer than any blockhash can live, so a seller
//!     cannot sell the NFT while still holding a usable signature;
//!   * a signature that moves the card puts the token in `Exiting`, which blocks transfer until the relayer
//!     records what happened (`record_release`, or `record_exit_failed` if it never landed);
//!   * durable nonces are allowed only on Mintent's nonce accounts, whose authority is the treasury, so such a
//!     transaction can't land without the relayer's signature.
//! - The treasury path is not parsed: it is the relayer's money and a documented trust assumption.

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableSet, LookupMap};
pub mod solana;

use near_sdk::{
    env, ext_contract, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};
use std::collections::HashMap;

/// Ed25519 domain of the NEAR MPC network (Solana signatures).
pub const ED25519_DOMAIN_ID: u64 = 1;
/// Solana caps a serialized transaction at 1232 bytes; the MPC accepts EdDSA payloads of 32..=1232 bytes.
pub const MIN_PAYLOAD_BYTES: usize = 32;
pub const MAX_PAYLOAD_BYTES: usize = 1232;
/// Gas forwarded to the MPC `sign` call (contract requires >= 10 Tgas).
pub const GAS_FOR_MPC_SIGN: Gas = Gas::from_tgas(15);
pub const TREASURY_PATH: &str = "treasury";
/// How long a token can't be transferred after a card signature. A Solana blockhash is valid for at most 150
/// blocks (about 36 s on devnet and 60-90 s on mainnet), so 5 minutes leaves a wide margin.
pub const SIGN_LOCK_MS: u64 = 5 * 60 * 1000;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NftOwners,
    NftMetadata,
    NftEnumeration,
    Cards,
    Orders,
    SignLocks,
    NonceAccounts,
    PaymentMints,
    Keepers,
}

/// An owner's permission for one agent to sell this token's card back to Collector Crypt, at no less than `min_price`
/// (USDC base units), until `expires_ms`. The money goes to the card's own address, so it stays with the NFT. The agent can't
/// withdraw the card, move USDC or transfer the NFT. Cleared when the NFT changes hands.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeeperGrant {
    pub agent: AccountId,
    pub min_price: U64,
    pub expires_ms: U64,
}

/// Longest permission an owner can give at once.
pub const MAX_KEEPER_MS: u64 = 90 * 24 * 60 * 60 * 1000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CardStatus {
    /// Pack bought, not opened yet.
    Sealed,
    /// Card delivered to the token's Solana address.
    Opened,
    /// A signature that moves the card was issued. The token can't be transferred until the outcome is recorded.
    Exiting,
    /// Card has left the token's address (bought back, withdrawn or redeemed).
    Released,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug)]
pub struct CardRecord {
    pub status: CardStatus,
    pub pack_type: String,
    /// Collector Crypt pack memo (links to CC's VRF proof).
    pub memo: Option<String>,
    /// Solana mint address of the card.
    pub card_mint: Option<String>,
    pub rarity: Option<String>,
    pub roll: Option<U64>,
    /// Collector Crypt insured value at pull time, in US cents.
    pub insured_value_usd_cents: Option<U64>,
    pub release_reason: Option<String>,
}

#[near(serializers = [json])]
pub struct CardView {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub solana_path: String,
    pub record: CardRecord,
    /// Unix ms until which the token can't be transferred because of a recent card signature (0 if never).
    pub locked_until_ms: U64,
    pub transferable: bool,
    /// The owner's Keeper permission, if any.
    pub keeper: Option<KeeperGrant>,
}

/// Mirrors the MPC contract's `payload_v2` enum: `{"Eddsa": "<hex>"}`.
#[near(serializers = [json])]
pub enum SignPayload {
    Eddsa(String),
}

#[near(serializers = [json])]
pub struct SignRequestArgs {
    pub payload_v2: SignPayload,
    pub path: String,
    pub domain_id: u64,
}

#[ext_contract(ext_mpc)]
#[allow(dead_code)]
trait MpcSigner {
    fn sign(&mut self, request: SignRequestArgs);
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    relayer_id: AccountId,
    mpc_contract_id: AccountId,
    tokens: NonFungibleToken,
    cards: LookupMap<TokenId, CardRecord>,
    /// Settled checkout order id (1Click deposit address) -> token minted for it. Prevents double mints.
    orders: LookupMap<String, TokenId>,
    /// Token -> unix ms until which NEP-171 transfers are blocked.
    sign_locks: LookupMap<TokenId, u64>,
    /// Durable nonce accounts a card signature may use. Their authority must be the treasury.
    nonce_accounts: IterableSet<String>,
    /// SPL mints a card address may send (payment tokens such as USDC).
    payment_mints: IterableSet<String>,
    next_token_id: u64,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner_id: AccountId, relayer_id: AccountId, mpc_contract_id: AccountId) -> Self {
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NftOwners,
                env::current_account_id(),
                Some(StorageKey::NftMetadata),
                Some(StorageKey::NftEnumeration),
                None::<StorageKey>,
            ),
            cards: LookupMap::new(StorageKey::Cards),
            orders: LookupMap::new(StorageKey::Orders),
            sign_locks: LookupMap::new(StorageKey::SignLocks),
            nonce_accounts: IterableSet::new(StorageKey::NonceAccounts),
            payment_mints: IterableSet::new(StorageKey::PaymentMints),
            owner_id,
            relayer_id,
            mpc_contract_id,
            next_token_id: 0,
        }
    }

    // ---------- admin ----------

    pub fn set_relayer(&mut self, relayer_id: AccountId) {
        self.assert_owner();
        self.relayer_id = relayer_id;
    }

    /// Allow a durable nonce account for card signatures. Its authority must be the treasury address.
    pub fn add_nonce_account(&mut self, address: String) {
        self.assert_owner();
        solana::decode_pubkey(&address).unwrap_or_else(|e| env::panic_str(e));
        self.nonce_accounts.insert(address);
    }

    pub fn remove_nonce_account(&mut self, address: String) {
        self.assert_owner();
        self.nonce_accounts.remove(&address);
    }

    /// Allow an SPL mint (a payment token, never a card) to be sent from card addresses.
    pub fn add_payment_mint(&mut self, address: String) {
        self.assert_owner();
        solana::decode_pubkey(&address).unwrap_or_else(|e| env::panic_str(e));
        self.payment_mints.insert(address);
    }

    pub fn remove_payment_mint(&mut self, address: String) {
        self.assert_owner();
        self.payment_mints.remove(&address);
    }

    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({
            "owner_id": self.owner_id,
            "relayer_id": self.relayer_id,
            "mpc_contract_id": self.mpc_contract_id,
            "next_token_id": self.next_token_id,
            "treasury_path": TREASURY_PATH,
            "sign_lock_ms": SIGN_LOCK_MS,
            "nonce_accounts": self.nonce_accounts.iter().collect::<Vec<_>>(),
            "payment_mints": self.payment_mints.iter().collect::<Vec<_>>(),
        })
    }

    // ---------- pack lifecycle (relayer) ----------

    /// Record a settled checkout order and mint its sealed pack token to `receiver_id`.
    /// `order_id` is the 1Click deposit address of the paid quote; each order mints exactly once.
    /// Storage is paid by the contract.
    pub fn mint_pack(&mut self, order_id: String, receiver_id: AccountId, pack_type: String) -> TokenId {
        self.assert_relayer();
        require!(!order_id.is_empty() && order_id.len() <= 128, "invalid order_id");
        require!(!self.orders.contains_key(&order_id), "order already minted");
        let token_id = self.next_token_id.to_string();
        self.next_token_id += 1;
        let metadata = TokenMetadata {
            title: Some(format!("Mintent pack #{token_id} (sealed)")),
            description: Some(format!(
                "Sealed {pack_type} pack. Its card will be held at the Solana address this contract derives for path {}.",
                card_path_for(&token_id)
            )),
            ..empty_metadata()
        };
        self.tokens.internal_mint_with_refund(token_id.clone(), receiver_id.clone(), Some(metadata), None);
        self.orders.insert(order_id.clone(), token_id.clone());
        self.cards.insert(
            token_id.clone(),
            CardRecord {
                status: CardStatus::Sealed,
                pack_type: pack_type.clone(),
                memo: None,
                card_mint: None,
                rarity: None,
                roll: None,
                insured_value_usd_cents: None,
                release_reason: None,
            },
        );
        emit("pack_minted", json!({ "token_id": token_id, "order_id": order_id, "owner_id": receiver_id, "pack_type": pack_type, "solana_path": card_path_for(&token_id) }));
        token_id
    }

    /// Record the card a pack produced. Updates the token's metadata (dynamic NFT).
    #[allow(clippy::too_many_arguments)]
    pub fn record_open(
        &mut self,
        token_id: TokenId,
        memo: String,
        card_mint: String,
        card_name: String,
        rarity: String,
        roll: U64,
        insured_value_usd_cents: U64,
        media: Option<String>,
    ) {
        self.assert_relayer();
        let mut record = self.cards.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("unknown token"));
        require!(record.status == CardStatus::Sealed, "pack is not sealed");
        record.status = CardStatus::Opened;
        record.memo = Some(memo.clone());
        record.card_mint = Some(card_mint.clone());
        record.rarity = Some(rarity.clone());
        record.roll = Some(roll);
        record.insured_value_usd_cents = Some(insured_value_usd_cents);
        self.cards.insert(token_id.clone(), record);

        if let Some(meta_by_id) = self.tokens.token_metadata_by_id.as_mut() {
            let mut meta = meta_by_id.get(&token_id).unwrap_or_else(empty_metadata);
            meta.title = Some(card_name);
            meta.description = Some(format!(
                "{rarity} pull. Card mint {card_mint} on Solana, held at this token's Chain Signatures address ({}). Collector Crypt memo {memo}.",
                card_path_for(&token_id)
            ));
            meta.media = media;
            meta.extra = Some(json!({ "card_mint": card_mint, "memo": memo, "rarity": rarity }).to_string());
            meta.updated_at = Some(env::block_timestamp_ms().to_string());
            meta_by_id.insert(&token_id, &meta);
        }
        emit("card_opened", json!({ "token_id": token_id, "memo": memo, "card_mint": card_mint, "rarity": rarity, "roll": roll, "insured_value_usd_cents": insured_value_usd_cents }));
    }

    /// Record that the card left the token's Solana address (buyback, withdrawal, redemption).
    pub fn record_release(&mut self, token_id: TokenId, reason: String) {
        self.assert_relayer();
        let mut record = self.cards.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("unknown token"));
        require!(
            record.status == CardStatus::Opened || record.status == CardStatus::Exiting,
            "card is not held"
        );
        record.status = CardStatus::Released;
        record.release_reason = Some(reason.clone());
        Self::keepers().remove(&token_id);
        self.cards.insert(token_id.clone(), record);
        emit("card_released", json!({ "token_id": token_id, "reason": reason }));
    }

    /// A card-moving signature was issued but the transaction can no longer land (it expired or failed).
    /// Clears `Exiting` so the token can be transferred again once its sign lock ends.
    pub fn record_exit_failed(&mut self, token_id: TokenId) {
        self.assert_relayer();
        let mut record = self.cards.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("unknown token"));
        require!(record.status == CardStatus::Exiting, "card is not exiting");
        record.status = CardStatus::Opened;
        self.cards.insert(token_id.clone(), record);
        emit("exit_failed", json!({ "token_id": token_id }));
    }

    // ---------- signing ----------

    /// The current token owner asks the MPC network to sign `payload_hex`, a serialized Solana message, with
    /// the key at `card/<token_id>`. The message must pass the signing policy (`solana.rs`). Every signature
    /// locks the token for `SIGN_LOCK_MS`, and a signature that moves the card puts it in `Exiting`.
    /// Requires an attached deposit of at least 1 yoctoNEAR so function-call access keys cannot use it.
    /// Attach >= 50 Tgas. Returns the MPC response (Ed25519 signature).
    #[payable]
    pub fn sign_for_card(&mut self, token_id: TokenId, payload_hex: String) -> Promise {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown token"));
        require!(env::predecessor_account_id() == owner, "only the token owner can sign for this card");
        let classified = self.classify(&payload_hex);
        self.issue_card_signature(token_id, payload_hex, owner, classified, false)
    }

    // ---------- keeper ----------

    /// The owner lets `agent_id` sell this card back for at least `min_price` USDC base units until `expires_ms`.
    /// Replaces any earlier permission. Requires 1 yoctoNEAR, so a function-call key can't grant one.
    #[payable]
    pub fn grant_keeper(&mut self, token_id: TokenId, agent_id: AccountId, min_price: U64, expires_ms: U64) {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown token"));
        require!(env::predecessor_account_id() == owner, "only the token owner can set a keeper");
        let record = self.cards.get(&token_id).unwrap_or_else(|| env::panic_str("unknown token"));
        require!(record.status == CardStatus::Opened, "the card isn't held by this token");
        let now = env::block_timestamp_ms();
        require!(expires_ms.0 > now && expires_ms.0 <= now + MAX_KEEPER_MS, "the keeper's end must be in the next 90 days");
        require!(min_price.0 > 0, "set a minimum price");
        let grant = KeeperGrant { agent: agent_id, min_price, expires_ms };
        Self::keepers().insert(&token_id, &grant);
        emit("keeper_granted", json!({ "token_id": token_id, "owner": owner, "agent": grant.agent, "min_price": grant.min_price, "expires_ms": grant.expires_ms }));
    }

    #[payable]
    pub fn revoke_keeper(&mut self, token_id: TokenId) {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown token"));
        require!(env::predecessor_account_id() == owner, "only the token owner can remove a keeper");
        if Self::keepers().remove(&token_id).is_some() {
            emit("keeper_revoked", json!({ "token_id": token_id, "by": owner }));
        }
    }

    /// The keeper asks for a signature on a sell-back. The base signing policy applies, and the message must be a Collector
    /// Crypt sell-back of this card into its own address at or above the owner's floor (`solana::check_keeper_sellback`).
    #[payable]
    pub fn keeper_sign(&mut self, token_id: TokenId, payload_hex: String) -> Promise {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        let grant = Self::keepers().get(&token_id).unwrap_or_else(|| env::panic_str("this token has no keeper"));
        require!(env::predecessor_account_id() == grant.agent, "only this token's keeper can sign");
        require!(env::block_timestamp_ms() < grant.expires_ms.0, "the keeper's permission has ended");
        let record = self.cards.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("unknown token"));
        require!(record.status == CardStatus::Opened, "the card isn't held by this token");
        let asset = record.card_mint.as_deref().and_then(|m| solana::decode_pubkey(m).ok()).unwrap_or_else(|| env::panic_str("the card has no address"));

        let classified = self.classify(&payload_hex);
        require!(classified.moves_card && classified.uses_durable_nonce, "a keeper may only sign a sell-back");
        let bytes = hex::decode(&payload_hex).unwrap_or_else(|_| env::panic_str("payload_hex is not valid hex"));
        let msg = solana::parse_message(&bytes).unwrap_or_else(|e| env::panic_str(e));
        let mints: Vec<solana::Pubkey> = self.payment_mints.iter().filter_map(|a| solana::decode_pubkey(a).ok()).collect();
        let price = solana::check_keeper_sellback(&msg, &asset, &mints).unwrap_or_else(|e| env::panic_str(e));
        require!(price >= grant.min_price.0, "the price is below the owner's minimum");
        self.issue_card_signature(token_id, payload_hex, grant.agent, classified, true)
    }

    pub fn get_keeper(&self, token_id: TokenId) -> Option<KeeperGrant> {
        Self::keepers().get(&token_id)
    }

    fn keepers() -> near_sdk::collections::LookupMap<TokenId, KeeperGrant> {
        near_sdk::collections::LookupMap::new(StorageKey::Keepers)
    }

    /// Lock the token and ask the MPC network to sign for `card/<token_id>`. Callers have already checked who may ask.
    fn issue_card_signature(&mut self, token_id: TokenId, payload_hex: String, by: AccountId, classified: solana::Classified, keeper: bool) -> Promise {
        let mut record = self.cards.get(&token_id).cloned().unwrap_or_else(|| env::panic_str("unknown token"));
        require!(record.status != CardStatus::Sealed, "pack is not opened yet");
        if classified.moves_card {
            require!(record.status != CardStatus::Released, "card has already left this address");
            record.status = CardStatus::Exiting;
            self.cards.insert(token_id.clone(), record);
        }
        let locked_until = env::block_timestamp_ms() + SIGN_LOCK_MS;
        self.sign_locks.insert(token_id.clone(), locked_until);

        let path = card_path_for(&token_id);
        emit("sign_requested", json!({ "token_id": token_id, "path": path, "by": by, "keeper": keeper, "payload_bytes": payload_hex.len() / 2, "moves_card": classified.moves_card, "uses_durable_nonce": classified.uses_durable_nonce, "locked_until_ms": U64(locked_until) }));
        self.mpc_sign(path, payload_hex)
    }

    /// The relayer asks the MPC network to sign with the Mintent treasury key (pays for packs).
    #[payable]
    pub fn sign_for_treasury(&mut self, payload_hex: String) -> Promise {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        self.assert_relayer();
        emit("sign_requested", json!({ "path": TREASURY_PATH, "by": self.relayer_id, "payload_bytes": payload_hex.len() / 2 }));
        self.mpc_sign(TREASURY_PATH.to_string(), payload_hex)
    }

    // ---------- views ----------

    pub fn get_order_token(&self, order_id: String) -> Option<TokenId> {
        self.orders.get(&order_id).cloned()
    }

    /// Dry-run the signing policy on a message. Panics with the reason if `sign_for_card` would refuse it.
    pub fn check_card_message(&self, payload_hex: String) -> near_sdk::serde_json::Value {
        let c = self.classify(&payload_hex);
        json!({ "moves_card": c.moves_card, "uses_durable_nonce": c.uses_durable_nonce })
    }

    pub fn card_path(&self, token_id: TokenId) -> String {
        card_path_for(&token_id)
    }

    pub fn get_card(&self, token_id: TokenId) -> Option<CardView> {
        let record = self.cards.get(&token_id)?.clone();
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        let locked_until_ms = self.sign_locks.get(&token_id).copied().unwrap_or(0);
        let transferable = record.status != CardStatus::Exiting && env::block_timestamp_ms() >= locked_until_ms;
        let keeper = Self::keepers().get(&token_id);
        Some(CardView { solana_path: card_path_for(&token_id), token_id, owner_id, record, locked_until_ms: U64(locked_until_ms), transferable, keeper })
    }

    // ---------- internals ----------

    fn classify(&self, payload_hex: &str) -> solana::Classified {
        let bytes = hex::decode(payload_hex).unwrap_or_else(|_| env::panic_str("payload_hex is not valid hex"));
        require!(
            (MIN_PAYLOAD_BYTES..=MAX_PAYLOAD_BYTES).contains(&bytes.len()),
            "payload must be 32..=1232 bytes"
        );
        let msg = solana::parse_message(&bytes).unwrap_or_else(|e| env::panic_str(e));
        let nonces: Vec<solana::Pubkey> = self.nonce_accounts.iter().filter_map(|a| solana::decode_pubkey(a).ok()).collect();
        let mints: Vec<solana::Pubkey> = self.payment_mints.iter().filter_map(|a| solana::decode_pubkey(a).ok()).collect();
        solana::classify_card_message(&msg, &nonces, &mints).unwrap_or_else(|e| env::panic_str(e))
    }

    /// NEP-171 transfers are blocked while a signature might still land.
    fn assert_transferable(&self, token_id: &TokenId) {
        if let Some(record) = self.cards.get(token_id) {
            require!(record.status != CardStatus::Exiting, "token is locked: the card is leaving this address");
        }
        let until = self.sign_locks.get(token_id).copied().unwrap_or(0);
        require!(env::block_timestamp_ms() >= until, "token is locked: a recent card signature may still be usable");
    }

    fn mpc_sign(&self, path: String, payload_hex: String) -> Promise {
        let bytes = hex::decode(&payload_hex).unwrap_or_else(|_| env::panic_str("payload_hex is not valid hex"));
        require!(
            (MIN_PAYLOAD_BYTES..=MAX_PAYLOAD_BYTES).contains(&bytes.len()),
            "payload must be 32..=1232 bytes"
        );
        ext_mpc::ext(self.mpc_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(GAS_FOR_MPC_SIGN)
            .sign(SignRequestArgs {
                payload_v2: SignPayload::Eddsa(payload_hex.to_lowercase()),
                path,
                domain_id: ED25519_DOMAIN_ID,
            })
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "only the contract owner");
    }

    fn assert_relayer(&self) {
        require!(env::predecessor_account_id() == self.relayer_id, "only the relayer");
    }
}

pub fn card_path_for(token_id: &str) -> String {
    format!("card/{token_id}")
}

fn empty_metadata() -> TokenMetadata {
    TokenMetadata {
        title: None,
        description: None,
        media: None,
        media_hash: None,
        copies: Some(1),
        issued_at: Some(env::block_timestamp_ms().to_string()),
        expires_at: None,
        starts_at: None,
        updated_at: None,
        extra: None,
        reference: None,
        reference_hash: None,
    }
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "mintent", "version": "0.1.0", "event": event, "data": [data] })
    ));
}

// ---------- NEP-171 / NEP-177 / NEP-181 ----------

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: TokenId, approval_id: Option<u64>, memo: Option<String>) {
        self.assert_transferable(&token_id);
        // A permission is the owner's choice, so it never passes to the next owner.
        Self::keepers().remove(&token_id);
        self.tokens.nft_transfer(receiver_id, token_id, approval_id, memo)
    }

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.assert_transferable(&token_id);
        Self::keepers().remove(&token_id);
        self.tokens.nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        self.tokens.nft_resolve_transfer(previous_owner_id, receiver_id, token_id, approved_account_ids)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> near_sdk::json_types::U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<near_sdk::json_types::U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> near_sdk::json_types::U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<near_sdk::json_types::U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens.nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        NFTContractMetadata {
            spec: NFT_METADATA_SPEC.to_string(),
            name: "Mintent Cards".to_string(),
            symbol: "MINTENT".to_string(),
            icon: None,
            base_uri: None,
            reference: None,
            reference_hash: None,
        }
    }
}

#[cfg(test)]
mod tests;
