// Spike S1b: same as S1a but through the deployed mintent contract (real testnet MPC).
// - relayer mints a sealed pack (token) to the dev account
// - CC devnet pack tx for the contract's treasury address (altPlayerAddress = token's card address)
// - sign_for_treasury via the contract; verify signature; check blockhash still valid
// - sign_for_card (as token owner) over a Solana-sized payload; verify against the card address
// Does NOT broadcast anything to Solana. Usage: tsx src/spike-s1-contract.ts <dev.testnet> <contract.testnet>
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveSolanaAddress, loadAccount, verifyEd25519 } from "./lib/mpc.js";

const [dev, contractId] = process.argv.slice(2);
if (!dev || !contractId) throw new Error("usage: spike-s1-contract <dev.testnet> <contract.testnet>");
const account = loadAccount("testnet", dev);
const sol = new Connection("https://api.devnet.solana.com", "confirmed");

function sigFrom(res: unknown): Uint8Array {
  const r = res as { signature?: number[] };
  if (!Array.isArray(r?.signature) || r.signature.length !== 64) throw new Error(`bad MPC response ${JSON.stringify(res)}`);
  return Uint8Array.from(r.signature);
}

const tokenId = await account.callFunction<string>({ contractId, methodName: "mint_pack", args: { order_id: `spike-${Date.now()}`, receiver_id: dev, pack_type: "pokemon_25" }, gas: 100_000_000_000_000n });
const treasury = await deriveSolanaAddress("testnet", contractId, "treasury");
const card = await deriveSolanaAddress("testnet", contractId, `card/${tokenId}`);
console.log({ tokenId, treasury, card });

// 1) treasury signs a real CC devnet pack transaction
const t0 = Date.now();
const r = await fetch("https://dev-gacha.collectorcrypt.com/api/generatePack", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ playerAddress: treasury, packType: "pokemon_25", altPlayerAddress: card }),
});
const gp = (await r.json()) as { memo?: string; transaction?: string };
if (!gp.transaction) throw new Error(`generatePack ${r.status} ${JSON.stringify(gp)}`);
const t1 = Date.now();
const tx = VersionedTransaction.deserialize(Buffer.from(gp.transaction, "base64"));
const msg = tx.message.serialize();
const treasurySig = sigFrom(
  await account.callFunction({ contractId, methodName: "sign_for_treasury", args: { payload_hex: Buffer.from(msg).toString("hex") }, deposit: 1n, gas: 100_000_000_000_000n }),
);
const t2 = Date.now();
tx.addSignature(new PublicKey(treasury), treasurySig);
const inWindow = (await sol.isBlockhashValid(tx.message.recentBlockhash, { commitment: "processed" })).value;
console.log({ step: "treasury via contract", memo: gp.memo, generatePackMs: t1 - t0, contractMpcSignMs: t2 - t1, totalMs: t2 - t0, sigValid: verifyEd25519(treasury, msg, treasurySig), blockhashStillValid: inWindow });

// 2) token owner signs for the card address (payload = the same message bytes, just to prove the key)
const t3 = Date.now();
const cardSig = sigFrom(
  await account.callFunction({ contractId, methodName: "sign_for_card", args: { token_id: tokenId, payload_hex: Buffer.from(msg).toString("hex") }, deposit: 1n, gas: 100_000_000_000_000n }),
);
console.log({ step: "card via contract", contractMpcSignMs: Date.now() - t3, sigValidForCardAddress: verifyEd25519(card, msg, cardSig) });
