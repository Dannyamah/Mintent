// Minimal Chain Signatures (NEAR MPC) helpers for Ed25519 / Solana.
// Contract reference: https://github.com/near/mpc/blob/main/crates/contract/README.md
import { Account, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import bs58 from "bs58";

export const NETWORKS = {
  testnet: { rpc: "https://rpc.testnet.near.org", mpc: "v1.signer-prod.testnet" },
  mainnet: { rpc: "https://rpc.mainnet.near.org", mpc: "v1.signer" },
} as const;
export type NearNetwork = keyof typeof NETWORKS;

export const ED25519_DOMAIN = 1;

export function loadAccount(network: NearNetwork, accountId: string): Account {
  const file = join(homedir(), ".near-credentials", network, `${accountId}.json`);
  const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: KeyPairString };
  const provider = new JsonRpcProvider({ url: NETWORKS[network].rpc });
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(private_key));
}

/** Solana address (base58 Ed25519 pubkey) that `predecessor` controls at `path`. */
export async function deriveSolanaAddress(network: NearNetwork, predecessor: string, path: string): Promise<string> {
  const provider = new JsonRpcProvider({ url: NETWORKS[network].rpc });
  const pk = await provider.callFunction<string>({
    contractId: NETWORKS[network].mpc,
    method: "derived_public_key",
    args: { path, predecessor, domain_id: ED25519_DOMAIN },
  } as never);
  if (typeof pk !== "string" || !pk.startsWith("ed25519:")) throw new Error(`unexpected derived key: ${JSON.stringify(pk)}`);
  return pk.slice("ed25519:".length);
}

/** Ask the MPC network to sign `message` (raw bytes, 32..1232) with the key at `path`. Returns the 64-byte signature. */
export async function mpcSignEd25519(account: Account, network: NearNetwork, path: string, message: Uint8Array): Promise<Uint8Array> {
  if (message.length < 32 || message.length > 1232) throw new Error(`EdDSA payload must be 32..1232 bytes, got ${message.length}`);
  const res = await account.callFunction<Record<string, unknown>>({
    contractId: NETWORKS[network].mpc,
    methodName: "sign",
    args: { request: { payload_v2: { Eddsa: Buffer.from(message).toString("hex") }, path, domain_id: ED25519_DOMAIN } },
    deposit: 1n, // 1 yoctoNEAR, required
    gas: 50_000_000_000_000n, // 50 Tgas (contract requires >= 10 Tgas)
  });
  return extractSignature(res);
}

function extractSignature(res: unknown): Uint8Array {
  // Expected Ed25519 response shape: { scheme: "Ed25519", signature: number[64] }. Be tolerant of variants.
  const r = res as Record<string, unknown>;
  const sig = (r?.signature ?? (r?.Ed25519 as Record<string, unknown>)?.signature) as unknown;
  if (Array.isArray(sig) && sig.length === 64) return Uint8Array.from(sig as number[]);
  if (typeof sig === "string") {
    const b = /^[0-9a-f]{128}$/i.test(sig) ? Buffer.from(sig, "hex") : Buffer.from(bs58.decode(sig.replace(/^ed25519:/, "")));
    if (b.length === 64) return Uint8Array.from(b);
  }
  throw new Error(`unrecognised MPC sign response: ${JSON.stringify(res).slice(0, 400)}`);
}

export function verifyEd25519(pubkeyBase58: string, message: Uint8Array, signature: Uint8Array): boolean {
  const raw = Buffer.from(bs58.decode(pubkeyBase58));
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]);
  return nodeVerify(null, Buffer.from(message), createPublicKey({ key: spki, format: "der", type: "spki" }), Buffer.from(signature));
}
