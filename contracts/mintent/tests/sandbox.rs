//! End-to-end sandbox test: mintent + mock MPC signer deployed in a local NEAR sandbox.
//! Proves on a real runtime that (1) the token owner's sign request reaches the signer with
//! predecessor = the mintent contract and path = card/<id>, (2) the signer's response is returned
//! to the caller, and (3) transferring the NEP-171 token moves signing rights.
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

const HEX_378: fn() -> String = || "ab".repeat(378);

#[tokio::test]
async fn owner_signs_transfer_moves_rights() -> anyhow::Result<()> {
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

    // Relayer mints a sealed pack to alice.
    let token_id: String = relayer
        .call(mintent.id(), "mint_pack")
        .args_json(json!({ "receiver_id": alice.id(), "pack_type": "pokemon_25" }))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(token_id, "0");

    // Alice (owner) signs: the mock signer's response comes back to her.
    let resp: Value = alice
        .call(mintent.id(), "sign_for_card")
        .args_json(json!({ "token_id": "0", "payload_hex": HEX_378() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(resp["scheme"], "Ed25519");
    assert_eq!(resp["signature"].as_array().unwrap().len(), 64);

    let reqs: Value = signer.view("get_requests").await?.json()?;
    assert_eq!(reqs[0]["predecessor"], mintent.id().to_string(), "MPC sees the contract as predecessor");
    assert_eq!(reqs[0]["path"], "card/0");
    assert_eq!(reqs[0]["domain_id"], 1);

    // Bob cannot sign for alice's card.
    let denied = bob
        .call(mintent.id(), "sign_for_card")
        .args_json(json!({ "token_id": "0", "payload_hex": HEX_378() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(denied.is_failure(), "non-owner must be rejected");

    // Alice transfers the NFT to bob; now bob can sign and alice cannot.
    alice
        .call(mintent.id(), "nft_transfer")
        .args_json(json!({ "receiver_id": bob.id(), "token_id": "0" }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await?
        .into_result()?;

    bob.call(mintent.id(), "sign_for_card")
        .args_json(json!({ "token_id": "0", "payload_hex": HEX_378() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?
        .into_result()?;

    let alice_after = alice
        .call(mintent.id(), "sign_for_card")
        .args_json(json!({ "token_id": "0", "payload_hex": HEX_378() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    assert!(alice_after.is_failure(), "previous owner must lose signing rights");

    let card: Value = mintent.view("get_card").args_json(json!({ "token_id": "0" })).await?.json()?;
    assert_eq!(card["owner_id"], bob.id().to_string());
    Ok(())
}
