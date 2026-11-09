// The session's NEAR account: an implicit account, created and funded by the relayer at the first paid order.
// Its key is either held by Privy (email or passkey sign-in, the only option on mainnet) or, on testnet, generated in this browser.
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner, keyToImplicitAddress, PublicKey, Signer } from "near-api-js";
import type { Health } from "./api";

const STORE = "mintent.testnet.key";
const TGAS = 1_000_000_000_000n;

export interface Wallet {
  accountId: string;
  /** Ask the contract for a signature over a Solana message. Locks the NFT for 5 minutes. Slow: 12 to 60 seconds. */
  signForCard(tokenId: string, messageHex: string): Promise<string>;
  transfer(tokenId: string, receiver: string): Promise<void>;
}

// Failover wraps errors, which stops near-api-js recovering from a stale nonce and hides the real reason from the user.
// (Same as packages/shared, which also pulls in Node-only code.)
function realRpcError(e: unknown): unknown {
  const errors = (e as { errors?: unknown[] })?.errors;
  if (!Array.isArray(errors) || !errors.length) return e;
  return errors.find((x) => !/\b429\b|rate limit|failed to fetch|timed? ?out|\b5\d\d\b/i.test(String(x))) ?? errors[0];
}

function withRealErrors<P extends object>(provider: P): P {
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

function storedKey(): string | null {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

export function hasStoredWallet(): boolean {
  return storedKey() !== null;
}

/** The test account's secret key, for the user's own backup file. */
export function exportKey(): string | null {
  return storedKey();
}

/** The reason a contract refused, in plain words. */
export function refusal(e: unknown): string {
  // The failover provider wraps the real errors. Use them, never its own summary.
  const inner = (e as { errors?: unknown[] })?.errors?.map(String).join("; ");
  const text = inner || String(e instanceof Error ? e.message : e);
  console.error("wallet error:", text);
  const known = text.match(/token is locked[^"\\]*|only the token owner[^"\\]*|card has already left[^"\\]*|pack is not opened yet/)?.[0];
  if (known) return known;
  if (/does not exist|AccessKeyDoesNotExist|not enough balance|NotEnoughBalance/i.test(text)) return "Your NEAR account isn't ready yet. Wait a few seconds and try again.";
  if (/429|rate limit|timeout|fetch/i.test(text)) return "The NEAR network is busy. Check this page in a minute before trying again.";
  return "That didn't go through. Check this page in a minute before trying again.";
}

/** Privy's raw-hash signing call. The key never reaches this page; Privy signs inside its own isolated frame. */
export type SignRawHash = (input: { address: string; chainType: "near"; hash: `0x${string}` }) => Promise<{ signature: string }>;

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

export class PrivySigner extends Signer {
  private readonly accountId: string;
  private readonly signRawHash: SignRawHash;

  constructor(accountId: string, signRawHash: SignRawHash) {
    super();
    // The relayer's gas sponsorship creates accounts by sending to them, which only works for implicit addresses.
    if (!/^[a-f0-9]{64}$/.test(accountId)) throw new Error(`Expected an implicit NEAR account from Privy, got ${accountId}`);
    this.accountId = accountId;
    this.signRawHash = signRawHash;
  }

  async getPublicKey(): Promise<PublicKey> {
    return new PublicKey({ keyType: 0, data: fromHex(this.accountId) });
  }

  protected async signBytes(bytes: Uint8Array): Promise<Uint8Array> {
    const { signature } = await this.signRawHash({ address: this.accountId, chainType: "near", hash: `0x${toHex(bytes)}` });
    return fromHex(signature.replace(/^0x/, ""));
  }
}

function walletFrom(accountId: string, signer: Signer, health: Health): Wallet {
  const provider = withRealErrors(new FailoverRpcProvider(health.nearRpcs.map((url) => new JsonRpcProvider({ url }, { retries: 2, wait: 800, backoff: 1.6 }))));
  const account = new Account(accountId, provider, signer);
  return {
    accountId,
    async signForCard(tokenId, messageHex) {
      const res = (await account.callFunction({ contractId: health.contract, methodName: "sign_for_card", args: { token_id: tokenId, payload_hex: messageHex }, deposit: 1n, gas: 50n * TGAS })) as { signature?: number[] };
      if (!res?.signature || res.signature.length !== 64) throw new Error("The signing network returned no signature. Try again.");
      return res.signature.map((b) => b.toString(16).padStart(2, "0")).join("");
    },
    async transfer(tokenId, receiver) {
      await account.callFunction({ contractId: health.contract, methodName: "nft_transfer", args: { receiver_id: receiver, token_id: tokenId }, deposit: 1n, gas: 30n * TGAS });
    },
  };
}

/** The account whose key Privy holds for this user. */
export function privyWallet(health: Health, address: string, signRawHash: SignRawHash): Wallet {
  return walletFrom(address, new PrivySigner(address, signRawHash), health);
}

/** Testnet only: an account whose key lives in this browser. */
export function openWallet(health: Health): Wallet {
  if (health.network !== "testnet") throw new Error("Browser-held keys are for the test network only.");
  let secret = storedKey();
  if (!secret) {
    secret = KeyPair.fromRandom("ed25519").toString();
    try {
      localStorage.setItem(STORE, secret);
    } catch {
      /* private window: the wallet lasts for this session */
    }
  }
  const publicKey = KeyPair.fromString(secret as never).getPublicKey();
  return walletFrom(keyToImplicitAddress(publicKey), KeyPairSigner.fromSecretKey(secret as never), health);
}
