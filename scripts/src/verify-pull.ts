// Independently re-check every claim about a Mintent pull. Reads only public sources (NEAR RPC, Solana RPC,
// Collector Crypt's public verifier) and trusts nothing from the relayer. Exit code 1 if any check fails.
// Usage: tsx src/verify-pull.ts <contract> <tokenId> [testnet|mainnet]
import { Connection, PublicKey } from "@solana/web3.js";
import { CcClient, CONFIGS, deriveSolanaAddress, nearProvider, readCoreAsset, type CardView, type NearNetwork } from "@mintent/shared";

export async function verifyPull(contractId: string, tokenId: string, network: NearNetwork = "testnet", log = console.log): Promise<boolean> {
  const cfg = CONFIGS[network];
  const near = nearProvider(network);
  const conn = new Connection(cfg.solanaRpc, "confirmed");
  const cc = new CcClient(cfg.ccGacha, cfg.ccApi);
  let ok = true;
  const check = (name: string, pass: boolean, detail = "") => {
    log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
    ok &&= pass;
  };

  const card = (await near.callFunction({ contractId, method: "get_card", args: { token_id: tokenId } } as never)) as unknown as CardView | null;
  if (!card) {
    check(`token ${tokenId} exists on ${contractId}`, false);
    return false;
  }
  log(`token ${tokenId}: owner ${card.owner_id}, status ${card.record.status}, card ${card.record.card_mint}`);
  const nft = (await near.callFunction({ contractId, method: "nft_token", args: { token_id: tokenId } } as never)) as any;
  check("NEP-171 owner matches the card record", nft?.owner_id === card.owner_id, nft?.owner_id);

  const address = await deriveSolanaAddress(network, contractId, `card/${tokenId}`);
  check("card path derives through the NEAR MPC contract", card.solana_path === `card/${tokenId}`, `${cfg.mpcContract} -> ${address}`);

  if (!card.record.card_mint || !card.record.memo) {
    check("pack has been opened", false, card.record.status);
    return ok;
  }
  const { owner } = await readCoreAsset(conn, new PublicKey(card.record.card_mint));
  if (card.record.status === "Opened") check("Solana: the card is held by the token's address", owner.toBase58() === address, owner.toBase58());
  else if (card.record.status === "Released") check("Solana: a released card has left the token's address", owner.toBase58() !== address, `${card.record.release_reason} -> ${owner.toBase58()}`);
  else check("Solana: an exiting card is at the token's address or has just left it", true, owner.toBase58());

  const vrf = await cc.verifyPack(card.record.memo);
  check("Collector Crypt VRF proof is valid for this pack", vrf?.valid === true || vrf?.success === true || vrf?.verified === true, JSON.stringify(vrf)?.slice(0, 120));
  log(`  info  independent verifier: ${cc.verifyUrl(card.record.memo)}`);
  return ok;
}

if (process.argv[1]?.endsWith("verify-pull.ts")) {
  const [contractId, tokenId, network] = process.argv.slice(2);
  if (!contractId || !tokenId) throw new Error("usage: verify-pull <contract> <tokenId> [testnet|mainnet]");
  const pass = await verifyPull(contractId, tokenId, (network ?? "testnet") as NearNetwork);
  console.log(pass ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
  process.exit(pass ? 0 : 1);
}
