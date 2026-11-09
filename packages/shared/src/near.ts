// Minimal Chain Signatures (NEAR MPC) helpers for Ed25519 / Solana.
// Contract reference: https://github.com/near/mpc/blob/main/crates/contract/README.md
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPairSigner, type KeyPairString } from "near-api-js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicKey, verify as nodeVerify } from "node:crypto";
import bs58 from "bs58";

// rpc.*.near.org is deprecated and answers 429, and free endpoints rate-limit per IP (seen 8 Nov 2026), so no single
// provider can be relied on. NEAR_RPC_URLS (comma-separated) puts your own endpoints first.
export const NETWORKS = {
  testnet: { rpc: "https://testnet-rpc.intea.rs", rpcFallbacks: ["https://near-testnet.drpc.org", "https://test.rpc.fastnear.com", "https://api.zan.top/near-testnet"], mpc: "v1.signer-prod.testnet" },
  mainnet: { rpc: "https://free.rpc.fastnear.com", rpcFallbacks: ["https://near.drpc.org", "https://rpc.mainnet.fastnear.com"], mpc: "v1.signer" },
} as const;
export type NearNetwork = keyof typeof NETWORKS;

export const ED25519_DOMAIN = 1;

/** A NEAR provider that fails over between RPC endpoints. */
/**
 * The most useful error behind a failover: the first that isn't just a provider being busy or unreachable.
 * Failover wraps everything in FailoverRpcError, which hides the real error from near-api-js. In particular, its
 * automatic recovery from a stale nonce only fires on InvalidNonceError, so without this a stale nonce never recovers.
 */
export function realRpcError(e: unknown): unknown {
  const errors = (e as { errors?: unknown[] })?.errors;
  if (!Array.isArray(errors) || !errors.length) return e;
  return errors.find((x) => !/\b429\b|rate limit|fetch failed|timed? ?out|ECONN|ENOTFOUND|socket|\b5\d\d\b/i.test(String(x))) ?? errors[0];
}

/** Wrap a provider so every call throws the real error instead of a FailoverRpcError. */
export function withRealErrors<P extends object>(provider: P): P {
  return new Proxy(provider, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out instanceof Promise ? out.catch((e) => { throw realRpcError(e); }) : out;
      };
    },
  });
}

export function nearProvider(network: NearNetwork, rpc?: string): FailoverRpcProvider {
  const own = (process.env.NEAR_RPC_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const urls = [...own, ...(rpc ? [rpc] : []), NETWORKS[network].rpc, ...NETWORKS[network].rpcFallbacks];
  return withRealErrors(new FailoverRpcProvider([...new Set(urls)].map((url) => new JsonRpcProvider({ url }, { retries: 3, wait: 800, backoff: 1.6 }))));
}

export function accountFromKey(network: NearNetwork, accountId: string, privateKey: string, rpc?: string): Account {
  return new Account(accountId, nearProvider(network, rpc), KeyPairSigner.fromSecretKey(privateKey as KeyPairString));
}

export function loadAccount(network: NearNetwork, accountId: string): Account {
  const file = join(homedir(), ".near-credentials", network, `${accountId}.json`);
  const { private_key } = JSON.parse(readFileSync(file, "utf8")) as { private_key: KeyPairString };
  return new Account(accountId, nearProvider(network), KeyPairSigner.fromSecretKey(private_key));
}

/** Solana address (base58 Ed25519 pubkey) that `predecessor` controls at `path`. */
export async function deriveSolanaAddress(network: NearNetwork, predecessor: string, path: string): Promise<string> {
  const provider = nearProvider(network);
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

/** Create a throwaway testnet account from NEAR's public faucet helper. Its key goes to ~/.near-credentials, never the repo. */
export async function createTestnetAccount(accountId: string): Promise<void> {
  const { KeyPair } = await import("near-api-js");
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  const dir = join(homedir(), ".near-credentials", "testnet");
  const file = join(dir, `${accountId}.json`);
  if (existsSync(file)) return;
  const kp = KeyPair.fromRandom("ed25519");
  const res = await fetch("https://helper.nearprotocol.com/account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet helper ${res.status}: ${(await res.text()).slice(0, 300)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
}
