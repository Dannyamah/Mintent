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
//! - The contract does not interpret Solana transactions; it authorises *who* may sign for *which* path.

use near_contract_standards::non_fungible_token::core::{NonFungibleTokenCore, NonFungibleTokenResolver};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{NonFungibleToken, Token, TokenId};
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
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

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NftOwners,
    NftMetadata,
    NftEnumeration,
    Cards,
    Orders,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum CardStatus {
    /// Pack bought, not opened yet.
    Sealed,
    /// Card delivered to the token's Solana address.
    Opened,
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

    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        json!({
            "owner_id": self.owner_id,
            "relayer_id": self.relayer_id,
            "mpc_contract_id": self.mpc_contract_id,
            "next_token_id": self.next_token_id,
            "treasury_path": TREASURY_PATH,
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
        require!(record.status == CardStatus::Opened, "card is not held");
        record.status = CardStatus::Released;
        record.release_reason = Some(reason.clone());
        self.cards.insert(token_id.clone(), record);
        emit("card_released", json!({ "token_id": token_id, "reason": reason }));
    }

    // ---------- signing ----------

    /// The current token owner asks the MPC network to sign `payload_hex` (a serialized Solana
    /// message, or a raw sign-in message) with the key at `card/<token_id>`.
    /// Requires an attached deposit of at least 1 yoctoNEAR so function-call access keys cannot use it.
    /// Attach >= 50 Tgas. Returns the MPC response (Ed25519 signature).
    #[payable]
    pub fn sign_for_card(&mut self, token_id: TokenId, payload_hex: String) -> Promise {
        require!(env::attached_deposit() >= NearToken::from_yoctonear(1), "attach at least 1 yoctoNEAR");
        let owner = self.tokens.owner_by_id.get(&token_id).unwrap_or_else(|| env::panic_str("unknown token"));
        require!(env::predecessor_account_id() == owner, "only the token owner can sign for this card");
        let path = card_path_for(&token_id);
        emit("sign_requested", json!({ "token_id": token_id, "path": path, "by": owner, "payload_bytes": payload_hex.len() / 2 }));
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

    pub fn card_path(&self, token_id: TokenId) -> String {
        card_path_for(&token_id)
    }

    pub fn get_card(&self, token_id: TokenId) -> Option<CardView> {
        let record = self.cards.get(&token_id)?.clone();
        let owner_id = self.tokens.owner_by_id.get(&token_id)?;
        Some(CardView { solana_path: card_path_for(&token_id), token_id, owner_id, record })
    }

    // ---------- internals ----------

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
