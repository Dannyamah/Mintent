// Spike S1a: can the NEAR testnet MPC sign a Collector Crypt devnet pack transaction
// for a Chain-Signatures-derived Solana address fast enough (~30 s blockhash window)?
// Does NOT broadcast anything. Usage: tsx src/spike-s1-sign.ts <testnet-account> [runs]
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { deriveSolanaAddress, loadAccount, mpcSignEd25519, verifyEd25519 } from "./lib/mpc.js";

const NEAR_ACCOUNT = process.argv[2];
const RUNS = Number(process.argv[3] ?? 3);
if (!NEAR_ACCOUNT) throw new Error("usage: spike-s1-sign <testnet-account> [runs]");

const GACHA = "https://dev-gacha.collectorcrypt.com";
const sol = new Connection("https://api.devnet.solana.com", "confirmed");
const account = loadAccount("testnet", NEAR_ACCOUNT);
const treasury = await deriveSolanaAddress("testnet", NEAR_ACCOUNT, "treasury/test");
const card = await deriveSolanaAddress("testnet", NEAR_ACCOUNT, "card/test-1");
console.log({ treasury, card });

const results: Record<string, unknown>[] = [];
for (let i = 0; i < RUNS; i++) {
  const t0 = Date.now();
  const r = await fetch(`${GACHA}/api/generatePack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ playerAddress: treasury, packType: "pokemon_25", altPlayerAddress: card }),
  });
  const body = (await r.json()) as { memo?: string; transaction?: string; error?: string };
  if (!body.transaction) throw new Error(`generatePack ${r.status}: ${JSON.stringify(body)}`);
  const tGen = Date.now();
  const tx = VersionedTransaction.deserialize(Buffer.from(body.transaction, "base64"));
  const msg = tx.message.serialize();

  const sig = await mpcSignEd25519(account, "testnet", "treasury/test", msg);
  const tSig = Date.now();
  const valid = verifyEd25519(treasury, msg, sig);
  tx.addSignature(new PublicKey(treasury), sig);
  const blockhashStillValid = (await sol.isBlockhashValid(tx.message.recentBlockhash, { commitment: "processed" })).value;

  const row = {
    memo: body.memo,
    msgBytes: msg.length,
    generatePackMs: tGen - t0,
    mpcSignMs: tSig - tGen,
    totalMs: tSig - t0,
    sigValid: valid,
    blockhashStillValidAfterSigning: blockhashStillValid,
  };
  console.log(row);
  results.push(row);
}
const mpc = results.map((r) => r.mpcSignMs as number).sort((a, b) => a - b);
console.log({ runs: RUNS, mpcSignMsMedian: mpc[Math.floor(mpc.length / 2)], mpcSignMsMax: mpc.at(-1), allValid: results.every((r) => r.sigValid), allInWindow: results.every((r) => r.blockhashStillValidAfterSigning) });
