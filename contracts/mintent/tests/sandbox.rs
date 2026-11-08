//! End-to-end sandbox test: mintent + mock MPC signer deployed in a local NEAR sandbox.
//! Proves on a real runtime that:
//! 1. the token owner's sign request reaches the signer with predecessor = contract and path = card/<id>;
//! 2. the signer's response is returned to the caller;
//! 3. transferring the NEP-171 token moves signing rights;
//! 4. the pre-sign attack is blocked: a signature locks the token, so it can't be sold while still usable;
//! 5. messages outside the policy are refused.
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

/// A minimal legacy Solana message containing one instruction for `program` (base58) with `data`.
fn message(program: &str, data: &[u8]) -> String {
    let program: Vec<u8> = bs58_decode(program);
    let mut m = vec![2u8, 0, 1, 3];
    m.extend_from_slice(&[1u8; 32]);
    m.extend_from_slice(&[2u8; 32]);
    m.extend_from_slice(&program);
    m.extend_from_slice(&[9u8; 32]);
    m.push(1);
    m.push(2); // program index
    m.push(1); // one account
    m.push(1);
    m.push(data.len() as u8);
    m.extend_from_slice(data);
    m.iter().map(|b| format!("{b:02x}")).collect()
}

fn bs58_decode(s: &str) -> Vec<u8> {
    const A: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut out = vec![0u8; 32];
    for c in s.chars() {
        let mut carry = A.find(c).unwrap() as u32;
        for b in out.iter_mut().rev() {
            carry += (*b as u32) * 58;
            *b = carry as u8;
            carry >>= 8;
        }
    }
    out
}

const CORE: &str = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const MEMO: &str = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

#[tokio::test]
async fn ownership_and_attack_paths() -> anyhow::Result<()> {
    let worker = near_workspaces::sandbox().await?;
    let mintent_wasm = near_workspaces::compile_project("./").await?;
    let signer_wasm = near_workspaces::compile_project("../mock-signer").await?;

    let signer = worker.dev_deploy(&signer_wasm).await?;
    signer.call("new").transact().await?.into_result()?;
    let mintent = worker.dev_deploy(&mintent_wasm).await?;
    let root = worker.root_account()?;
    let relayer = root.create_subaccount("relayer").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let alice = root.create_subaccount("alice").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let bob = root.create_subaccount("bob").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;

    mintent
        .call("new")
        .args_json(json!({ "owner_id": root.id(), "relayer_id": relayer.id(), "mpc_contract_id": signer.id() }))
        .transact()
        .await?
        .into_result()?;

    let mint_and_open = |order: &'static str| {
        let (relayer, mintent, alice) = (relayer.clone(), mintent.clone(), alice.clone());
        async move {
            let id: String = relayer
                .call(mintent.id(), "mint_pack")
                .args_json(json!({ "order_id": order, "receiver_id": alice.id(), "pack_type": "pokemon_25" }))
                .max_gas()
                .transact()
                .await?
                .into_result()?
                .json()?;
            relayer
                .call(mintent.id(), "record_open")
                .args_json(json!({ "token_id": id, "memo": "m", "card_mint": "x", "card_name": "n", "rarity": "Common", "roll": "1", "insured_value_usd_cents": "100", "media": null }))
                .max_gas()
                .transact()
                .await?
                .into_result()?;
            anyhow::Ok(id)
        }
    };
    let sign = |who: &near_workspaces::Account, id: &str, hex: String| {
        who.call(mintent.id(), "sign_for_card").args_json(json!({ "token_id": id, "payload_hex": hex })).deposit(NearToken::from_yoctonear(1)).max_gas().transact()
    };
    let transfer = |who: &near_workspaces::Account, to: &near_workspaces::Account, id: &str| {
        who.call(mintent.id(), "nft_transfer").args_json(json!({ "receiver_id": to.id(), "token_id": id })).deposit(NearToken::from_yoctonear(1)).max_gas().transact()
    };

    // Token 0: ownership moves with the NFT.
    let t0 = mint_and_open("order-0").await?;
    assert!(sign(&bob, &t0, message(MEMO, b"hi")).await?.is_failure(), "non-owner must be rejected");
    transfer(&alice, &bob, &t0).await?.into_result()?;
    let resp: Value = sign(&bob, &t0, message(MEMO, b"hi")).await?.into_result()?.json()?;
    assert_eq!(resp["scheme"], "Ed25519");
    assert_eq!(resp["signature"].as_array().unwrap().len(), 64);
    let reqs: Value = signer.view("get_requests").await?.json()?;
    assert_eq!(reqs[0]["predecessor"], mintent.id().to_string(), "MPC sees the contract as predecessor");
    assert_eq!(reqs[0]["path"], "card/0");
    assert_eq!(reqs[0]["domain_id"], 1);
    assert!(sign(&alice, &t0, message(MEMO, b"hi")).await?.is_failure(), "previous owner must lose signing rights");

    // Token 1: the pre-sign attack. Alice gets the transfer signed, then tries to sell.
    let t1 = mint_and_open("order-1").await?;
    sign(&alice, &t1, message(CORE, &[14, 0])).await?.into_result()?;
    let attack = transfer(&alice, &bob, &t1).await?;
    assert!(attack.is_failure(), "a token with a live card signature must not be sellable");
    assert!(format!("{attack:?}").contains("token is locked"));
    let card: Value = mintent.view("get_card").args_json(json!({ "token_id": t1 })).await?.json()?;
    assert_eq!(card["owner_id"], alice.id().to_string());
    assert_eq!(card["record"]["status"], "Exiting");
    assert_eq!(card["transferable"], false);

    // Token 2: a message that moves nothing still locks the token.
    let t2 = mint_and_open("order-2").await?;
    sign(&alice, &t2, message(MEMO, b"hi")).await?.into_result()?;
    assert!(transfer(&alice, &bob, &t2).await?.is_failure(), "any card signature locks the token");

    // Token 3: lingering-right attack. A Core plugin instruction is refused outright, with no lock taken.
    let t3 = mint_and_open("order-3").await?;
    let refused = sign(&alice, &t3, message(CORE, &[2, 3, 0])).await?;
    assert!(refused.is_failure());
    assert!(format!("{refused:?}").contains("only Core TransferV1 is allowed"));
    transfer(&alice, &bob, &t3).await?.into_result()?;

    // Relayer records what happened to token 1.
    relayer.call(mintent.id(), "record_release").args_json(json!({ "token_id": t1, "reason": "withdrawn" })).max_gas().transact().await?.into_result()?;
    let card: Value = mintent.view("get_card").args_json(json!({ "token_id": t1 })).await?.json()?;
    assert_eq!(card["record"]["status"], "Released");
    Ok(())
}
