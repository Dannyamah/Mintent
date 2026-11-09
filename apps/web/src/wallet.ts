// The session's NEAR account: an implicit account, created and funded by the relayer at the first paid order.
// Its key is either held by Privy (email sign-in, the only option on mainnet) or, on testnet, generated in this browser.
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner, keyToImplicitAddress, PublicKey, Signer } from "near-api-js";
import type { Health } from "./api";
import { PINS, trustedDeployment } from "./pins";
import { checkCashOutQuote, checkMessage, exitFee, MessageRefused, type MessageContext } from "./verifyMessage";

const STORE = "mintent.testnet.key";
const TGAS = 1_000_000_000_000n;

/** What the owner asked for, from their own input. The message is checked against this before anything is signed. */
export type SigningIntent =
  | { kind: "sellback"; price: string }
  | { kind: "withdrawCard"; destination: string }
  /** `total` is everything the NFT holds. The app works out the fee itself. */
  | { kind: "withdrawUsdc"; destination: string; total: string }
  | { kind: "cashOut"; recipient: string; destinationAsset: string; total: string; depositAddress: string; quote: unknown };

export interface Wallet {
  accountId: string;
  /** Ask the contract for a signature over a Solana message, if it matches the intent. Locks the NFT for 5 minutes. Slow: 12 to 60 seconds. */
  signForCard(tokenId: string, messageHex: string, intent: SigningIntent): Promise<string>;
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

// Signing out of a test account must keep its key: it's the only copy, and the account may hold cards.
const SIGNED_OUT = "mintent.testnet.signedOut";

export function isTestSessionActive(): boolean {
  try {
    return hasStoredWallet() && localStorage.getItem(SIGNED_OUT) === null;
  } catch {
    return false;
  }
}

export function endTestSession(): void {
  try {
    localStorage.setItem(SIGNED_OUT, "1");
  } catch {
    /* private window: nothing was stored to remember */
  }
}

/** The test account's secret key, for the user's own backup file. */
export function exportKey(): string | null {
  return storedKey();
}

/** The reason a contract refused, in plain words. */
export function refusal(e: unknown): string {
  if (e instanceof MessageRefused) return e.message;
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

// 1Click's SDK rejects its own BTC quotes (see packages/checkout). For BTC, the quote is only compared with what the owner chose.
const SIGNATURE_FALSE_NEGATIVES = new Set(["nep141:btc.omft.near"]);

function walletFrom(accountId: string, signer: Signer, health: Health): Wallet {
  const { contract, network } = trustedDeployment(health);
  const pins = PINS[network];
  // Read from pinned RPCs, because the signing check depends on what these return.
  const provider = withRealErrors(new FailoverRpcProvider(pins.nearRpcs.map((url) => new JsonRpcProvider({ url }, { retries: 2, wait: 800, backoff: 1.6 }))));
  const account = new Account(accountId, provider, signer);
  const view = <T,>(contractId: string, method: string, args: Record<string, unknown>) => provider.callFunction({ contractId, method, args } as never) as Promise<T>;
  const derive = async (path: string) => {
    const key = await view<string>(pins.mpc, "derived_public_key", { path, predecessor: contract, domain_id: 1 });
    if (typeof key !== "string" || !key.startsWith("ed25519:")) throw new Error("the signing network returned no address");
    return key.slice("ed25519:".length);
  };

  /** Everything the check needs, read from NEAR and not from the relayer. */
  const signingContext = async (tokenId: string): Promise<MessageContext> => {
    const [config, token] = await Promise.all([
      view<{ mpc_contract_id: string; treasury_path: string; nonce_accounts: string[] }>(contract, "get_config", {}),
      view<{ owner_id: string; solana_path: string; record: { card_mint: string | null } } | null>(contract, "get_card", { token_id: tokenId }),
    ]);
    if (config.mpc_contract_id !== pins.mpc) throw new MessageRefused("This contract uses a signing network the app doesn't recognise. Nothing was signed.");
    if (!token) throw new MessageRefused("This NFT doesn't exist on the contract. Nothing was signed.");
    if (token.owner_id !== accountId) throw new MessageRefused("You don't own this NFT any more. Nothing was signed.");
    const [card, treasury] = await Promise.all([derive(token.solana_path), derive(config.treasury_path)]);
    return { card, treasury, nonceAccounts: config.nonce_accounts, usdcMint: pins.usdcMint, asset: token.record.card_mint };
  };

  const verify = async (tokenId: string, messageHex: string, intent: SigningIntent) => {
    const ctx = await signingContext(tokenId);
    if (intent.kind === "cashOut") {
      // Testnet: sell-back money is a token Tidepool doesn't take, so it goes to the treasury, which funds the swap.
      const isTest = network === "testnet";
      const total = BigInt(intent.total);
      checkCashOutQuote(intent.quote, { depositAddress: intent.depositAddress, recipient: intent.recipient, destinationAsset: intent.destinationAsset, originAsset: pins.swapOrigin, amountIn: (total - exitFee(total)).toString(), refundTo: isTest ? ctx.treasury : ctx.card });
      if (!isTest && !SIGNATURE_FALSE_NEGATIVES.has(intent.destinationAsset)) {
        const { verifyQuoteSignature } = await import("@defuse-protocol/one-click-sdk-typescript");
        if (!verifyQuoteSignature(intent.quote as never)) throw new MessageRefused("We stopped this before signing, because the swap quote isn't signed by 1Click. Nothing was signed.");
      }
      checkMessage(messageHex, ctx, { kind: "sendUsdc", destination: isTest ? ctx.treasury : intent.depositAddress, total: intent.total });
    } else if (intent.kind === "withdrawUsdc") {
      checkMessage(messageHex, ctx, { kind: "sendUsdc", destination: intent.destination, total: intent.total });
    } else {
      checkMessage(messageHex, ctx, intent);
    }
  };

  return {
    accountId,
    async signForCard(tokenId, messageHex, intent) {
      await verify(tokenId, messageHex, intent);
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
  try {
    localStorage.removeItem(SIGNED_OUT);
  } catch {
    /* private window */
  }
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
