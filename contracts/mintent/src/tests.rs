use super::*;
use near_sdk::test_utils::{accounts, get_created_receipts, VMContextBuilder};
use near_sdk::testing_env;

const MPC: &str = "v1.signer-prod.testnet";

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

fn ctx(predecessor: AccountId, deposit_yocto: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("mintent.testnet".parse().unwrap())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
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

fn payload(len: usize) -> String {
    "ab".repeat(len)
}

/// Contract with one sealed pack (token "0") owned by alice.
fn setup() -> Contract {
    ctx(owner(), 0);
    let mut c = Contract::new(owner(), relayer(), MPC.parse().unwrap());
    ctx(relayer(), 0);
    let id = c.mint_pack("order-0".into(), alice(), "pokemon_25".into());
    assert_eq!(id, "0");
    c
}

#[test]
fn mint_creates_sealed_card_with_path() {
    let c = setup();
    let card = c.get_card("0".into()).unwrap();
    assert_eq!(card.owner_id, alice());
    assert_eq!(card.solana_path, "card/0");
    assert_eq!(card.record.status, CardStatus::Sealed);
}

#[test]
#[should_panic(expected = "only the relayer")]
fn only_relayer_can_mint() {
    let mut c = setup();
    ctx(alice(), 0);
    c.mint_pack("order-x".into(), alice(), "pokemon_25".into());
}

#[test]
fn owner_can_sign_and_request_goes_to_mpc_with_card_path() {
    let mut c = setup();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), payload(378));
    let (receiver, args) = scheduled_sign_args();
    assert_eq!(receiver, MPC);
    assert_eq!(args["request"]["path"], "card/0");
    assert_eq!(args["request"]["domain_id"], 1);
    assert_eq!(args["request"]["payload_v2"]["Eddsa"].as_str().unwrap().len(), 378 * 2);
}

#[test]
#[should_panic(expected = "only the token owner")]
fn non_owner_cannot_sign() {
    let mut c = setup();
    ctx(bob(), 1);
    let _ = c.sign_for_card("0".into(), payload(64));
}

#[test]
#[should_panic(expected = "attach at least 1 yoctoNEAR")]
fn sign_requires_deposit() {
    let mut c = setup();
    ctx(alice(), 0);
    let _ = c.sign_for_card("0".into(), payload(64));
}

#[test]
fn transfer_moves_signing_rights() {
    let mut c = setup();
    ctx(alice(), 1);
    c.nft_transfer(bob(), "0".into(), None, None);
    ctx(bob(), 1);
    let _ = c.sign_for_card("0".into(), payload(64)); // new owner can sign
    assert_eq!(c.get_card("0".into()).unwrap().owner_id, bob());
}

#[test]
#[should_panic(expected = "only the token owner")]
fn previous_owner_loses_signing_rights_after_transfer() {
    let mut c = setup();
    ctx(alice(), 1);
    c.nft_transfer(bob(), "0".into(), None, None);
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), payload(64));
}

#[test]
#[should_panic(expected = "payload must be 32..=1232 bytes")]
fn payload_too_short() {
    let mut c = setup();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), payload(31));
}

#[test]
#[should_panic(expected = "payload must be 32..=1232 bytes")]
fn payload_too_long() {
    let mut c = setup();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), payload(1233));
}

#[test]
#[should_panic(expected = "payload_hex is not valid hex")]
fn payload_must_be_hex() {
    let mut c = setup();
    ctx(alice(), 1);
    let _ = c.sign_for_card("0".into(), "zz".repeat(64));
}

#[test]
fn record_open_updates_record_and_metadata() {
    let mut c = setup();
    ctx(relayer(), 0);
    c.record_open(
        "0".into(),
        "cc-memo".into(),
        "MintAddr111".into(),
        "Test Card PSA 10".into(),
        "Rare".into(),
        U64(4120),
        U64(12000),
        Some("https://example.invalid/front.png".into()),
    );
    let card = c.get_card("0".into()).unwrap();
    assert_eq!(card.record.status, CardStatus::Opened);
    assert_eq!(card.record.card_mint.as_deref(), Some("MintAddr111"));
    let token = c.nft_token("0".into()).unwrap();
    assert_eq!(token.metadata.unwrap().title.as_deref(), Some("Test Card PSA 10"));
}

#[test]
#[should_panic(expected = "pack is not sealed")]
fn cannot_open_twice() {
    let mut c = setup();
    ctx(relayer(), 0);
    for _ in 0..2 {
        c.record_open("0".into(), "m".into(), "x".into(), "n".into(), "Common".into(), U64(1), U64(1), None);
    }
}

#[test]
fn release_after_open() {
    let mut c = setup();
    ctx(relayer(), 0);
    c.record_open("0".into(), "m".into(), "x".into(), "n".into(), "Common".into(), U64(1), U64(1), None);
    c.record_release("0".into(), "bought_back".into());
    assert_eq!(c.get_card("0".into()).unwrap().record.status, CardStatus::Released);
}

#[test]
fn relayer_can_sign_for_treasury() {
    let mut c = setup();
    ctx(relayer(), 1);
    let _ = c.sign_for_treasury(payload(378));
    let (_, args) = scheduled_sign_args();
    assert_eq!(args["request"]["path"], "treasury");
}

#[test]
#[should_panic(expected = "only the relayer")]
fn users_cannot_sign_for_treasury() {
    let mut c = setup();
    ctx(alice(), 1);
    let _ = c.sign_for_treasury(payload(64));
}

#[test]
#[should_panic(expected = "only the contract owner")]
fn only_owner_sets_relayer() {
    let mut c = setup();
    ctx(alice(), 0);
    c.set_relayer(alice());
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
