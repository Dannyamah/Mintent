use super::solana::*;
use super::*;
use near_sdk::bs58;
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;

const MPC: &str = "v1.signer-prod.testnet";
const NONCE: &str = "8faHKnvoQibuqYtd6BRSa6LYXtx69bHJ4FooWvxwz3H";
const USDC: &str = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const T0_MS: u64 = 1_800_000_000_000;

fn owner() -> AccountId {
    accounts(0)
}
fn relayer() -> AccountId {
    accounts(1)
}
fn alice() -> AccountId {
    accounts(2)
}
fn bob() -> AccountId {
    accounts(3)
}

fn ctx_at(predecessor: AccountId, deposit_yocto: u128, now_ms: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("mintent.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .block_timestamp(now_ms * 1_000_000)
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}

fn ctx(predecessor: AccountId, deposit_yocto: u128) {
    ctx_at(predecessor, deposit_yocto, T0_MS);
}

// ---------- Solana message builder ----------

fn key(s: &str) -> Pubkey {
    bs58::decode(s).into_vec().unwrap().try_into().unwrap()
}
fn fake(n: u8) -> Pubkey {
    [n; 32]
}

struct Ix {
    program: Pubkey,
    accounts: Vec<Pubkey>,
    data: Vec<u8>,
}

fn compact(n: usize, out: &mut Vec<u8>) {
    let mut v = n;
    loop {
        let mut b = (v & 0x7f) as u8;
        v >>= 7;
        if v > 0 {
            b |= 0x80;
        }
        out.push(b);
        if v == 0 {
            break;
        }
    }
}

fn build(ixs: &[Ix], v0: bool) -> Vec<u8> {
    let mut keys: Vec<Pubkey> = vec![fake(1), fake(2)]; // fee payer, card
    for ix in ixs {
        for k in ix.accounts.iter().chain([&ix.program]) {
            if !keys.contains(k) {
                keys.push(*k);
            }
        }
    }
    let idx = |k: &Pubkey| keys.iter().position(|x| x == k).unwrap() as u8;
    let mut m = Vec::new();
    if v0 {
        m.push(0x80);
    }
    m.extend_from_slice(&[2, 0, 0]);
    compact(keys.len(), &mut m);
    for k in &keys {
        m.extend_from_slice(k);
    }
    m.extend_from_slice(&[9u8; 32]); // blockhash
    compact(ixs.len(), &mut m);
    for ix in ixs {
        m.push(idx(&ix.program));
        compact(ix.accounts.len(), &mut m);
        for a in &ix.accounts {
            m.push(idx(a));
        }
        compact(ix.data.len(), &mut m);
        m.extend_from_slice(&ix.data);
    }
    if v0 {
        compact(0, &mut m); // no lookup tables
    }
    m
}

fn hx(m: Vec<u8>) -> String {
    hex::encode(m)
}
fn core_transfer() -> Ix {
    Ix { program: key(MPL_CORE_PROGRAM), accounts: vec![fake(5), fake(1), fake(2), fake(7)], data: vec![14, 0] }
}
fn usdc_transfer() -> Ix {
    Ix { program: key(TOKEN_PROGRAM), accounts: vec![fake(5), key(USDC), fake(6), fake(2)], data: vec![12, 1, 0, 0, 0, 0, 0, 0, 0, 6] }
}
fn advance_nonce(nonce: Pubkey) -> Ix {
    Ix { program: key(SYSTEM_PROGRAM), accounts: vec![nonce, fake(8), fake(1)], data: vec![4, 0, 0, 0] }
}
fn memo() -> Ix {
    Ix { program: key(MEMO_PROGRAM), accounts: vec![], data: b"hello".to_vec() }
}

// ---------- fixtures ----------

/// One sealed pack (token "0") owned by alice, with Mintent's nonce account and USDC configured.
fn setup() -> Contract {
    ctx(owner(), 0);
    let mut c = Contract::new(owner(), relayer(), MPC.parse().unwrap());
    c.add_nonce_account(NONCE.into());
    c.add_payment_mint(USDC.into());
    ctx(relayer(), 0);
    let id = c.mint_pack("order-0".into(), alice(), "pokemon_25".into());
    assert_eq!(id, "0");
    c
}

fn open(c: &mut Contract) {
    ctx(relayer(), 0);
    c.record_open("0".into(), "m".into(), "x".into(), "n".into(), "Common".into(), U64(1), U64(1), None);
}

fn opened() -> Contract {
    let mut c = setup();
    open(&mut c);
    c
}

/// JSON args of the single function call the contract scheduled (to the MPC signer).
fn scheduled_sign_args() -> (String, near_sdk::serde_json::Value) {
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 1, "expected exactly one outgoing receipt");
    match &receipts[0].actions[0] {
        near_sdk::mock::MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
            assert_eq!(method_name.as_slice(), b"sign");
            assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
            (receipts[0].receiver_id.to_string(), near_sdk::serde_json::from_slice(args).unwrap())
        }
        other => panic!("unexpected action {other:?}"),
    }
}

// ---------- lifecycle and roles ----------

#[test]
fn mint_creates_sealed_card_with_path() {
    let c = setup();
    let card = c.get_card("0".into()).unwrap();
    assert_eq!(card.owner_id, alice());
    assert_eq!(card.solana_path, "card/0");
    assert_eq!(card.record.status, CardStatus::Sealed);
    assert!(card.transferable);
}

#[test]
#[should_panic(expected = "only the relayer")]
fn only_relayer_can_mint() {
    let mut c = setup();
    ctx(alice(), 0);
    c.mint_pack("order-x".into(), alice(), "pokemon_25".into());
}

#[test]
#[should_panic(expected = "order already minted")]
fn same_order_cannot_mint_twice() {
    let mut c = setup();
    ctx(relayer(), 0);
    c.mint_pack("order-0".into(), bob(), "pokemon_25".into());
}

#[test]
fn order_maps_to_token() {
    let c = setup();
    assert_eq!(c.get_order_token("order-0".into()).as_deref(), Some("0"));
    assert_eq!(c.get_order_token("nope".into()), None);
}

#[test]
fn record_open_updates_record_and_metadata() {
    let mut c = setup();
    ctx(relayer(), 0);
    c.record_open("0".into(), "cc-memo".into(), "MintAddr111".into(), "Test Card PSA 10".into(), "Rare".into(), U64(4120), U64(12000), Some("https://example.invalid/front.png".into()));
    let card = c.get_card("0".into()).unwrap();
    assert_eq!(card.record.status, CardStatus::Opened);
    assert_eq!(card.record.card_mint.as_deref(), Some("MintAddr111"));
    assert_eq!(c.nft_token("0".into()).unwrap().metadata.unwrap().title.as_deref(), Some("Test Card PSA 10"));
}

#[test]
#[should_panic(expected = "pack is not sealed")]
fn cannot_open_twice() {
    let mut c = opened();
    open(&mut c);
}

#[test]
fn relayer_can_sign_for_treasury() {
    let mut c = setup();
    ctx(relayer(), 1);
    let _ = c.sign_for_treasury("ab".repeat(378));
    assert_eq!(scheduled_sign_args().1["request"]["path"], "treasury");
}

#[test]
#[should_panic(expected = "only the relayer")]
fn users_cannot_sign_for_treasury() {
    let mut c = setup();
    ctx(alice(), 1);
    let _ = c.sign_for_treasury("ab".repeat(64));
}

#[test]
#[should_panic(expected = "only the contract owner")]
fn only_owner_sets_relayer() {
    let mut c = setup();
    ctx(alice(), 0);
    c.set_relayer(alice());
}

#[test]
#[should_panic(expected = "only the contract owner")]
fn only_owner_adds_nonce_accounts() {
    let mut c = setup();
    ctx(alice(), 0);
    c.add_nonce_account(NONCE.into());
}

// ---------- who can sign ----------

#[test]
fn owner_signs_and_request_goes_to_mpc_with_card_path() {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[core_transfer()], true)));
    let (receiver, args) = scheduled_sign_args();
    assert_eq!(receiver, MPC);
    assert_eq!(args["request"]["path"], "card/0");
    assert_eq!(args["request"]["domain_id"], 1);
}

#[test]
#[should_panic(expected = "only the token owner")]
fn non_owner_cannot_sign() {
    let mut c = opened();
    ctx(bob(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[memo()], false)));
}

#[test]
#[should_panic(expected = "attach at least 1 yoctoNEAR")]
fn sign_requires_deposit() {
    let mut c = opened();
    ctx(alice(), 0);
    let _ = c.sign_for_card("0".into(), hx(build(&[memo()], false)));
}

#[test]
#[should_panic(expected = "pack is not opened yet")]
fn sealed_pack_cannot_sign() {
    let mut c = setup();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[memo()], false)));
}

#[test]
fn transfer_moves_signing_rights() {
    let mut c = opened();
    ctx(alice(), 1);
    c.nft_transfer(bob(), "0".into(), None, None);
    ctx(bob(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[memo()], false)));
    assert_eq!(c.get_card("0".into()).unwrap().owner_id, bob());
}

#[test]
#[should_panic(expected = "only the token owner")]
fn previous_owner_loses_signing_rights_after_transfer() {
    let mut c = opened();
    ctx(alice(), 1);
    c.nft_transfer(bob(), "0".into(), None, None);
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[memo()], false)));
}

// ---------- attack: sign first, sell second, broadcast third ----------

#[test]
#[should_panic(expected = "token is locked")]
fn attack_presign_then_sell_is_blocked_by_exiting() {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[core_transfer()], true)));
    ctx(alice(), 1);
    c.nft_transfer(bob(), "0".into(), None, None);
}

#[test]
#[should_panic(expected = "token is locked")]
fn attack_presign_then_sell_via_transfer_call_is_blocked() {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[core_transfer()], true)));
    ctx(alice(), 1);
    let _ = c.nft_transfer_call(bob(), "0".into(), None, None, "".into());
}

#[test]
#[should_panic(expected = "token is locked: a recent card signature")]
fn attack_presign_proceeds_then_sell_is_blocked_by_time_lock() {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[usdc_transfer()], true)));
    ctx_at(alice(), 1, T0_MS + SIGN_LOCK_MS - 1);
    c.nft_transfer(bob(), "0".into(), None, None);
}

#[test]
fn time_lock_ends_after_sign_lock_ms() {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[usdc_transfer()], true)));
    assert!(!c.get_card("0".into()).unwrap().transferable);
    ctx_at(alice(), 1, T0_MS + SIGN_LOCK_MS);
    assert!(c.get_card("0".into()).unwrap().transferable);
    c.nft_transfer(bob(), "0".into(), None, None);
    assert_eq!(c.get_card("0".into()).unwrap().owner_id, bob());
}

#[test]
#[should_panic(expected = "the card is leaving this address")]
fn exiting_stays_locked_after_the_time_lock() {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[core_transfer()], true)));
    assert_eq!(c.get_card("0".into()).unwrap().record.status, CardStatus::Exiting);
    ctx_at(alice(), 1, T0_MS + SIGN_LOCK_MS * 100);
    c.nft_transfer(bob(), "0".into(), None, None);
}

#[test]
fn failed_exit_restores_the_token_after_the_lock() {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[core_transfer()], true)));
    ctx_at(relayer(), 0, T0_MS + SIGN_LOCK_MS);
    c.record_exit_failed("0".into());
    assert_eq!(c.get_card("0".into()).unwrap().record.status, CardStatus::Opened);
    ctx_at(alice(), 1, T0_MS + SIGN_LOCK_MS);
    c.nft_transfer(bob(), "0".into(), None, None);
    assert_eq!(c.get_card("0".into()).unwrap().owner_id, bob());
}

#[test]
#[should_panic(expected = "only the relayer")]
fn owner_cannot_clear_their_own_exit() {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[core_transfer()], true)));
    ctx(alice(), 0);
    c.record_exit_failed("0".into());
}

#[test]
fn released_token_can_still_withdraw_proceeds_and_be_sold_after_the_lock() {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[core_transfer()], true)));
    ctx(relayer(), 0);
    c.record_release("0".into(), "bought_back".into());
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[usdc_transfer()], true)));
    ctx_at(alice(), 1, T0_MS + SIGN_LOCK_MS);
    c.nft_transfer(bob(), "0".into(), None, None);
    assert_eq!(c.get_card("0".into()).unwrap().owner_id, bob());
}

#[test]
#[should_panic(expected = "card has already left this address")]
fn released_token_cannot_move_a_card() {
    let mut c = opened();
    ctx(relayer(), 0);
    c.record_release("0".into(), "bought_back".into());
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[core_transfer()], true)));
}

// ---------- attack: lingering rights and expiry-free signatures ----------

fn refuse(msg: Vec<u8>) {
    let mut c = opened();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(msg));
}

#[test]
#[should_panic(expected = "durable nonce account not allowed")]
fn attack_own_durable_nonce_is_refused() {
    refuse(build(&[advance_nonce(fake(66)), core_transfer()], true));
}

#[test]
fn mintent_durable_nonce_is_allowed() {
    let c = opened();
    let r = c.check_card_message(hx(build(&[advance_nonce(key(NONCE)), core_transfer()], true)));
    assert_eq!(r["uses_durable_nonce"], true);
    assert_eq!(r["moves_card"], true);
}

#[test]
#[should_panic(expected = "system instruction not allowed")]
fn nonce_advance_must_be_first() {
    refuse(build(&[memo(), advance_nonce(key(NONCE))], true));
}

#[test]
#[should_panic(expected = "system instruction not allowed")]
fn attack_system_transfer_is_refused() {
    refuse(build(&[Ix { program: key(SYSTEM_PROGRAM), accounts: vec![fake(2), fake(7)], data: vec![2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] }], true));
}

#[test]
#[should_panic(expected = "only Core TransferV1 is allowed")]
fn attack_core_delegate_plugin_is_refused() {
    // AddPluginV1 (discriminator 2) would install a TransferDelegate that survives the NFT sale.
    refuse(build(&[Ix { program: key(MPL_CORE_PROGRAM), accounts: vec![fake(5), fake(1), fake(2)], data: vec![2, 3, 0] }], true));
}

#[test]
#[should_panic(expected = "only SPL TransferChecked is allowed")]
fn attack_spl_approve_is_refused() {
    refuse(build(&[Ix { program: key(TOKEN_PROGRAM), accounts: vec![fake(5), fake(7), fake(2)], data: vec![4, 1, 0, 0, 0, 0, 0, 0, 0] }], true));
}

#[test]
#[should_panic(expected = "only SPL TransferChecked is allowed")]
fn attack_spl_set_authority_is_refused() {
    refuse(build(&[Ix { program: key(TOKEN_PROGRAM), accounts: vec![fake(5), fake(2)], data: vec![6, 2, 1] }], true));
}

#[test]
#[should_panic(expected = "token mint not allowed")]
fn spl_transfer_of_a_non_payment_mint_is_refused() {
    refuse(build(&[Ix { program: key(TOKEN_PROGRAM), accounts: vec![fake(5), fake(44), fake(6), fake(2)], data: vec![12, 1, 0, 0, 0, 0, 0, 0, 0, 0] }], true));
}

#[test]
#[should_panic(expected = "program not allowed")]
fn attack_unknown_program_is_refused() {
    // For example the CC marketplace: a cheap listing to an alt account survives the NFT sale.
    refuse(build(&[Ix { program: fake(77), accounts: vec![fake(2)], data: vec![1, 2, 3] }], true));
}

#[test]
#[should_panic(expected = "only cc_buyback authorize_and_pay is allowed")]
fn other_cc_buyback_instructions_are_refused() {
    refuse(build(&[Ix { program: key(CC_BUYBACK_PROGRAM), accounts: vec![fake(2)], data: vec![1; 8] }], true));
}

#[test]
fn cc_buyback_sellback_shape_is_allowed() {
    let c = opened();
    let ed = Ix { program: key(ED25519_PROGRAM), accounts: vec![], data: vec![1; 40] };
    let budget = Ix { program: key(COMPUTE_BUDGET_PROGRAM), accounts: vec![], data: vec![2, 0x90, 0xd0, 3, 0] };
    let ata = Ix { program: key(ATA_PROGRAM), accounts: vec![fake(1), fake(6), fake(2), key(USDC)], data: vec![1] };
    let pay = Ix { program: key(CC_BUYBACK_PROGRAM), accounts: vec![fake(2)], data: vec![196, 1, 233, 204, 98, 232, 22, 54, 0, 0] };
    let r = c.check_card_message(hx(build(&[advance_nonce(key(NONCE)), budget, ed, ata, core_transfer(), pay], true)));
    assert_eq!(r["moves_card"], true);
}

// ---------- parser ----------

#[test]
fn legacy_and_v0_both_parse() {
    let c = opened();
    assert_eq!(c.check_card_message(hx(build(&[core_transfer()], false)))["moves_card"], true);
    assert_eq!(c.check_card_message(hx(build(&[core_transfer()], true)))["moves_card"], true);
}

#[test]
#[should_panic(expected = "payload must be 32..=1232 bytes")]
fn payload_too_short() {
    let c = opened();
    c.check_card_message("ab".repeat(31));
}

#[test]
#[should_panic(expected = "payload must be 32..=1232 bytes")]
fn payload_too_long() {
    let c = opened();
    c.check_card_message("ab".repeat(1233));
}

#[test]
#[should_panic(expected = "payload_hex is not valid hex")]
fn payload_must_be_hex() {
    let c = opened();
    c.check_card_message("zz".repeat(64));
}

#[test]
#[should_panic(expected = "trailing bytes")]
fn trailing_bytes_are_refused() {
    let mut m = build(&[memo()], true);
    m.push(0);
    let c = opened();
    c.check_card_message(hx(m));
}

#[test]
#[should_panic(expected = "address lookup tables are not allowed")]
fn lookup_tables_are_refused() {
    let mut m = build(&[memo()], true);
    let n = m.len();
    m[n - 1] = 1; // claim one lookup table
    m.extend_from_slice(&[7u8; 32]);
    m.extend_from_slice(&[0, 0]);
    let c = opened();
    c.check_card_message(hx(m));
}

#[test]
#[should_panic(expected = "unsupported message version")]
fn unknown_version_is_refused() {
    let mut m = build(&[memo()], true);
    m[0] = 0x81;
    let c = opened();
    c.check_card_message(hx(m));
}

#[test]
#[should_panic(expected = "message has no instructions")]
fn empty_message_is_refused() {
    let c = opened();
    c.check_card_message(hx(build(&[], true)));
}

#[test]
#[should_panic(expected = "program index out of range")]
fn out_of_range_program_index_is_refused() {
    // A program index beyond the static keys would be resolved from a lookup table.
    let mut m = build(&[memo()], false);
    let pos = 3 + 1 + 32 * 3 + 32 + 1; // header, key count, 3 keys, blockhash, ix count
    m[pos] = 200;
    let c = opened();
    c.check_card_message(hx(m));
}

#[test]
#[should_panic(expected = "non-canonical compact-u16")]
fn non_canonical_lengths_are_refused() {
    parse_message(&[1, 0, 0, 0x81, 0x00]).unwrap_or_else(|e| panic!("{e}"));
}

// ---------- keeper ----------
// In these messages fake(2) is the card's address (the second signer), fake(5) the card, fake(7) Collector Crypt's
// destination and fake(9) the card address's USDC account.

fn keeper() -> AccountId {
    accounts(4)
}
const FLOOR: u64 = 15_000_000;

fn ata_create(owner: Pubkey, account: Pubkey, mint: Pubkey) -> Ix {
    Ix { program: key(ATA_PROGRAM), accounts: vec![fake(1), account, owner, mint, key(SYSTEM_PROGRAM), key(TOKEN_PROGRAM)], data: vec![1] }
}
fn core_move(asset: Pubkey, authority: Pubkey, to: Pubkey) -> Ix {
    Ix { program: key(MPL_CORE_PROGRAM), accounts: vec![asset, fake(11), fake(1), authority, to, key(SYSTEM_PROGRAM), fake(12)], data: vec![14, 0] }
}
fn cc_pay(seller: Pubkey, asset: Pubkey, dest: Pubkey, proceeds: Pubkey, mint: Pubkey, price: u64) -> Ix {
    let mut data = vec![196, 1, 233, 204, 98, 232, 22, 54];
    data.extend_from_slice(&price.to_le_bytes());
    data.extend_from_slice(&[0u8; 20]);
    Ix {
        program: key(CC_BUYBACK_PROGRAM),
        accounts: vec![fake(13), seller, asset, dest, fake(10), proceeds, mint, fake(14), fake(15), fake(16), key(SYSTEM_PROGRAM), key(TOKEN_PROGRAM), key(MEMO_PROGRAM)],
        data,
    }
}
fn ed25519_quote() -> Ix {
    Ix { program: key(ED25519_PROGRAM), accounts: vec![], data: vec![1, 0, 48, 0] }
}

/// The sell-back the relayer builds, with each part replaceable to tamper with it.
fn sellback_with(price: u64, f: impl FnOnce(&mut Vec<Ix>)) -> String {
    let mut ixs = vec![
        advance_nonce(key(NONCE)),
        ed25519_quote(),
        ata_create(fake(2), fake(9), key(USDC)),
        core_move(fake(5), fake(2), fake(7)),
        cc_pay(fake(2), fake(5), fake(7), fake(9), key(USDC), price),
    ];
    f(&mut ixs);
    hx(build(&ixs, true))
}
fn sellback(price: u64) -> String {
    sellback_with(price, |_| {})
}

/// Token "0" holds card fake(5), and alice has given keeper() a permission with a 15 USDC floor for an hour.
fn kept() -> Contract {
    let mut c = setup();
    ctx(relayer(), 0);
    c.record_open("0".into(), "m".into(), bs58::encode(fake(5)).into_string(), "n".into(), "Common".into(), U64(1), U64(1), None);
    ctx(alice(), 1);
    c.grant_keeper("0".into(), keeper(), U64(FLOOR), U64(T0_MS + 3_600_000), None, None);
    c
}

#[test]
fn keeper_sells_back_at_or_above_the_floor_and_the_card_exits() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback(15_300_000));
    let (receiver, args) = scheduled_sign_args();
    assert_eq!(receiver, MPC);
    assert_eq!(args["request"]["path"], "card/0");
    let view = c.get_card("0".into()).unwrap();
    assert_eq!(view.record.status, CardStatus::Exiting);
    assert!(!view.transferable);
    assert_eq!(view.keeper.unwrap().agent, keeper());
}

/// The Keeper signs with a function-call access key, which can't attach a deposit: both of its methods must work without one.
#[test]
fn keeper_needs_no_deposit_so_a_function_call_key_works() {
    let mut c = kept();
    ctx(keeper(), 0);
    let _ = c.keeper_sign("0".into(), sellback(15_300_000));
    let (receiver, _) = scheduled_sign_args();
    assert_eq!(receiver, MPC);
}

#[test]
fn keeper_payout_needs_no_deposit_either() {
    let mut c = sold_with_payout();
    ctx(keeper(), 0);
    let _ = c.keeper_payout("0".into(), payout_with(15_050_000, 250_000, |_| {}));
    let (receiver, _) = scheduled_sign_args();
    assert_eq!(receiver, MPC);
}

/// Without a deposit, someone other than the Keeper still gets nothing.
#[test]
#[should_panic(expected = "only this token's keeper can sign")]
fn without_a_deposit_only_the_keeper_can_call() {
    let mut c = kept();
    ctx(bob(), 0);
    let _ = c.keeper_sign("0".into(), sellback(15_300_000));
}

#[test]
fn keeper_can_sell_at_exactly_the_floor() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback(FLOOR));
}

#[test]
#[should_panic(expected = "below the owner's minimum")]
fn keeper_cannot_sell_below_the_floor() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback(FLOOR - 1));
}

#[test]
#[should_panic(expected = "only this token's keeper")]
fn only_the_named_agent_can_use_the_permission() {
    let mut c = kept();
    ctx(bob(), 1);
    let _ = c.keeper_sign("0".into(), sellback(20_000_000));
}

#[test]
#[should_panic(expected = "permission has ended")]
fn the_permission_ends_on_time() {
    let mut c = kept();
    ctx_at(keeper(), 1, T0_MS + 3_600_000);
    let _ = c.keeper_sign("0".into(), sellback(20_000_000));
}

#[test]
#[should_panic(expected = "has no keeper")]
fn the_owner_can_revoke() {
    let mut c = kept();
    ctx(alice(), 1);
    c.revoke_keeper("0".into());
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback(20_000_000));
}

#[test]
fn selling_the_nft_clears_the_permission() {
    let mut c = kept();
    ctx(alice(), 1);
    c.nft_transfer(bob(), "0".into(), None, None);
    assert!(c.get_keeper("0".into()).is_none());
    assert!(c.get_card("0".into()).unwrap().keeper.is_none());
}

#[test]
#[should_panic(expected = "only the token owner can set a keeper")]
fn only_the_owner_can_grant() {
    let mut c = kept();
    ctx(bob(), 1);
    c.grant_keeper("0".into(), bob(), U64(1), U64(T0_MS + 1000), None, None);
}

#[test]
#[should_panic(expected = "attach at least 1 yoctoNEAR")]
fn granting_needs_a_deposit_so_function_call_keys_cannot() {
    let mut c = kept();
    ctx(alice(), 0);
    c.grant_keeper("0".into(), bob(), U64(1), U64(T0_MS + 1000), None, None);
}

#[test]
#[should_panic(expected = "in the next 90 days")]
fn a_permission_cannot_be_endless() {
    let mut c = kept();
    ctx(alice(), 1);
    c.grant_keeper("0".into(), keeper(), U64(1), U64(T0_MS + MAX_KEEPER_MS + 1), None, None);
}

#[test]
#[should_panic(expected = "may only sign a sell-back")]
fn attack_keeper_withdraws_the_card_to_itself() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), hx(build(&[advance_nonce(key(NONCE)), core_move(fake(5), fake(2), fake(66))], true)));
}

#[test]
#[should_panic(expected = "may only sign a sell-back")]
fn attack_keeper_drains_the_usdc() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback_with(20_000_000, |ixs| ixs.push(usdc_transfer())));
}

#[test]
#[should_panic(expected = "doesn't go to the card's own address")]
fn attack_keeper_sends_the_proceeds_elsewhere() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback_with(20_000_000, |ixs| {
        ixs[2] = ata_create(fake(66), fake(67), key(USDC));
        ixs[4] = cc_pay(fake(2), fake(5), fake(7), fake(67), key(USDC), 20_000_000);
    }));
}

#[test]
#[should_panic(expected = "doesn't go to the card's own address")]
fn attack_keeper_creates_the_right_account_but_pays_another() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback_with(20_000_000, |ixs| ixs[4] = cc_pay(fake(2), fake(5), fake(7), fake(67), key(USDC), 20_000_000)));
}

#[test]
#[should_panic(expected = "different destinations")]
fn attack_keeper_sends_the_card_somewhere_else() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback_with(20_000_000, |ixs| ixs[3] = core_move(fake(5), fake(2), fake(66))));
}

#[test]
#[should_panic(expected = "different card")]
fn attack_keeper_sells_a_different_card() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback_with(20_000_000, |ixs| {
        ixs[3] = core_move(fake(55), fake(2), fake(7));
        ixs[4] = cc_pay(fake(2), fake(55), fake(7), fake(9), key(USDC), 20_000_000);
    }));
}

#[test]
#[should_panic(expected = "isn't the card's holder")]
fn attack_keeper_names_itself_as_seller() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback_with(20_000_000, |ixs| ixs[4] = cc_pay(fake(66), fake(5), fake(7), fake(9), key(USDC), 20_000_000)));
}

#[test]
#[should_panic(expected = "one step of each kind")]
fn attack_keeper_hides_a_second_card_transfer() {
    let mut c = kept();
    ctx(keeper(), 1);
    let _ = c.keeper_sign("0".into(), sellback_with(20_000_000, |ixs| ixs.push(core_move(fake(5), fake(2), fake(66)))));
}

#[test]
fn the_owner_keeps_full_control_while_a_keeper_is_set() {
    let mut c = kept();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), hx(build(&[advance_nonce(key(NONCE)), core_move(fake(5), fake(2), fake(66))], true)));
    assert_eq!(c.get_card("0".into()).unwrap().record.status, CardStatus::Exiting);
}

// ---------- keeper payout ----------
// fake(20) is the owner's payout address, fake(21) the treasury; fake(22) and fake(23) are their USDC accounts.

fn spl_transfer(to: Pubkey, amount: u64) -> Ix {
    let mut data = vec![12];
    data.extend_from_slice(&amount.to_le_bytes());
    data.push(6);
    Ix { program: key(TOKEN_PROGRAM), accounts: vec![fake(9), key(USDC), to, fake(2)], data }
}
fn payout_with(net: u64, fee: u64, f: impl FnOnce(&mut Vec<Ix>)) -> String {
    let mut ixs = vec![
        advance_nonce(key(NONCE)),
        ata_create(fake(20), fake(22), key(USDC)),
        spl_transfer(fake(22), net),
        ata_create(fake(21), fake(23), key(USDC)),
        spl_transfer(fake(23), fee),
    ];
    f(&mut ixs);
    hx(build(&ixs, true))
}

/// Token "0" was sold back by its Keeper, which may pay out to fake(20). The treasury is fake(21).
fn sold_with_payout() -> Contract {
    let mut c = setup();
    ctx(owner(), 0);
    c.set_treasury_address(bs58::encode(fake(21)).into_string());
    ctx(relayer(), 0);
    c.record_open("0".into(), "m".into(), bs58::encode(fake(5)).into_string(), "Card".into(), "Common".into(), U64(1), U64(1), None);
    ctx(alice(), 1);
    c.grant_keeper("0".into(), keeper(), U64(FLOOR), U64(T0_MS + 3_600_000), Some(bs58::encode(fake(20)).into_string()), Some(true));
    ctx(relayer(), 0);
    c.record_release("0".into(), "bought_back".into());
    c
}

#[test]
fn exit_fee_matches_the_app_and_relayer() {
    assert_eq!(exit_fee(15_300_000), 250_000);
    assert_eq!(exit_fee(100_000_000), 1_000_000);
    assert_eq!(exit_fee(100_000_001), 1_000_001);
    assert_eq!(exit_fee(1), 250_000);
}

#[test]
fn keeper_pays_out_the_owner_less_the_exact_fee() {
    let mut c = sold_with_payout();
    let grant = c.get_keeper("0".into()).unwrap();
    assert!(grant.hold);
    ctx(keeper(), 1);
    let _ = c.keeper_payout("0".into(), payout_with(15_050_000, 250_000, |_| {}));
    let (_, args) = scheduled_sign_args();
    assert_eq!(args["request"]["path"], "card/0");
}

#[test]
fn a_permission_with_a_payout_outlasts_the_sale() {
    let c = sold_with_payout();
    assert!(c.get_keeper("0".into()).is_some());
}

#[test]
fn a_permission_without_a_payout_ends_with_the_sale() {
    let mut c = kept();
    ctx(relayer(), 0);
    c.record_release("0".into(), "bought_back".into());
    assert!(c.get_keeper("0".into()).is_none());
}

#[test]
fn a_sold_back_nft_says_so_in_wallets() {
    let c = sold_with_payout();
    let meta = c.nft_token("0".into()).unwrap().metadata.unwrap();
    assert!(meta.title.unwrap().starts_with("Sold back: "));
    assert!(meta.description.unwrap().contains("no longer holds its card"));
    assert!(c.nft_metadata().icon.unwrap().starts_with("data:image/svg+xml"));
}

#[test]
#[should_panic(expected = "the fee isn't Mintent's exit fee")]
fn attack_keeper_takes_a_bigger_fee() {
    let mut c = sold_with_payout();
    ctx(keeper(), 1);
    let _ = c.keeper_payout("0".into(), payout_with(15_000_000, 300_000, |_| {}));
}

#[test]
#[should_panic(expected = "an address the owner didn't choose")]
fn attack_keeper_pays_itself_instead_of_the_owner() {
    let mut c = sold_with_payout();
    ctx(keeper(), 1);
    let _ = c.keeper_payout("0".into(), payout_with(15_050_000, 250_000, |ixs| {
        ixs[1] = ata_create(fake(66), fake(67), key(USDC));
        ixs[2] = spl_transfer(fake(67), 15_050_000);
    }));
}

#[test]
#[should_panic(expected = "account the message doesn't create")]
fn attack_keeper_creates_the_owners_account_but_pays_another() {
    let mut c = sold_with_payout();
    ctx(keeper(), 1);
    let _ = c.keeper_payout("0".into(), payout_with(15_050_000, 250_000, |ixs| ixs[2] = spl_transfer(fake(67), 15_050_000)));
}

#[test]
#[should_panic(expected = "one transfer to the owner and one fee")]
fn attack_keeper_adds_a_third_transfer() {
    let mut c = sold_with_payout();
    ctx(keeper(), 1);
    let _ = c.keeper_payout("0".into(), payout_with(15_050_000, 250_000, |ixs| ixs.push(spl_transfer(fake(22), 1))));
}

#[test]
#[should_panic(expected = "can't move the card")]
fn attack_keeper_moves_the_card_in_a_payout() {
    let mut c = sold_with_payout();
    ctx(keeper(), 1);
    let _ = c.keeper_payout("0".into(), payout_with(15_050_000, 250_000, |ixs| ixs.push(core_move(fake(5), fake(2), fake(66)))));
}

#[test]
#[should_panic(expected = "didn't allow a payout")]
fn no_payout_unless_the_owner_named_an_address() {
    let mut c = kept();
    ctx(owner(), 0);
    c.set_treasury_address(bs58::encode(fake(21)).into_string());
    ctx(keeper(), 1);
    let _ = c.keeper_payout("0".into(), payout_with(15_050_000, 250_000, |_| {}));
}

#[test]
#[should_panic(expected = "only the contract owner")]
fn only_the_owner_sets_the_treasury_address() {
    let mut c = setup();
    ctx(alice(), 0);
    c.set_treasury_address(bs58::encode(fake(21)).into_string());
}

#[test]
#[should_panic(expected = "has no keeper")]
fn selling_the_nft_after_a_sale_ends_the_payout_permission() {
    let mut c = sold_with_payout();
    ctx(alice(), 1);
    c.nft_transfer(bob(), "0".into(), None, None);
    ctx(keeper(), 1);
    let _ = c.keeper_payout("0".into(), payout_with(15_050_000, 250_000, |_| {}));
}

