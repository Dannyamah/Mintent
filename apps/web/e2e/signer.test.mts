// Offline proof that PrivySigner produces the signature NEAR expects. Privy is stood in for by a local key: it receives only
// a hash, as Privy does, and the result must equal what near-api-js's own key signer produces for the same transaction.
// Run: node --test e2e/signer.test.mts
import assert from "node:assert/strict";
import { test } from "node:test";
import { actions, createTransaction, KeyPair, KeyPairSigner, keyToImplicitAddress } from "near-api-js";
import { PrivySigner, type SignRawHash } from "../src/wallet.ts";

const key = KeyPair.fromRandom("ed25519");
const address = keyToImplicitAddress(key.getPublicKey());
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const signRawHash: SignRawHash = async ({ address: a, chainType, hash }) => {
  assert.equal(a, address);
  assert.equal(chainType, "near");
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  return { signature: `0x${hex(key.sign(Buffer.from(hash.slice(2), "hex")).signature)}` };
};

test("the public key comes from the implicit address", async () => {
  const signer = new PrivySigner(address, signRawHash);
  assert.equal((await signer.getPublicKey()).toString(), key.getPublicKey().toString());
});

test("a transaction signed through Privy's hash call matches a local key's signature", async () => {
  const tx = createTransaction(address, key.getPublicKey(), "mintent.testnet", 7n, [actions.functionCall("nft_transfer", { token_id: "1", receiver_id: "bob.testnet" }, 30_000_000_000_000n, 1n)], new Uint8Array(32).fill(9));
  const viaPrivy = await new PrivySigner(address, signRawHash).signTransaction(tx);
  const viaKey = await new KeyPairSigner(key).signTransaction(tx);
  assert.equal(hex(viaPrivy.txHash), hex(viaKey.txHash));
  const signature = viaPrivy.signedTransaction.signature.ed25519Signature!.data;
  assert.equal(hex(signature), hex(viaKey.signedTransaction.signature.ed25519Signature!.data));
  assert.ok(key.getPublicKey().verify(viaPrivy.txHash, signature));
});

test("named accounts are refused, because gas sponsorship can't create them", () => {
  assert.throws(() => new PrivySigner("alice.near", signRawHash), /implicit/);
});
