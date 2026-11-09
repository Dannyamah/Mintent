// The relayer's view of the outside world, as interfaces so the state machine can be tested offline.
import { Connection, PublicKey, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import { ata, buildNonceTx, CcClient, deriveSolanaAddress, nonceAccountFor, readCoreAsset, type CardView, type MintentConfig, type NearNetwork } from "@mintent/shared";
import bs58 from "bs58";
import type { CheckoutBackend } from "@mintent/checkout";
import type { Db } from "./db.js";

export type SigStatus = "confirmed" | "failed" | "unknown";

/** Testnet only: refill the treasury from the devnet faucet when it runs low. Never present on mainnet. */
export type TopUpTestTreasury = () => Promise<void>;

export interface Chain {
  treasury: PublicKey;
  cardAddress(tokenId: string): Promise<string>;
  assetOwner(mint: string): Promise<{ owner: string; collection: PublicKey | null }>;
  signatureStatus(sig: string): Promise<SigStatus>;
  blockhashValid(blockhash: string): Promise<boolean>;
  send(tx: VersionedTransaction): Promise<string>;
  tokenBalance(owner: string, mint: string): Promise<bigint>;
  /** The treasury's SOL, which pays Solana fees and rent. */
  treasurySol(): Promise<bigint>;
  /** Recent successful transactions touching `owner`'s account for `mint`, oldest first. */
  recentTokenTxs(owner: string, mint: string): Promise<{ sig: string; atMs: number }[]>;
  /** How much `owner`'s balance of `mint` rose in a confirmed transaction, or null if it isn't confirmed. */
  tokenDeltaInTx(sig: string, owner: string, mint: string): Promise<bigint | null>;
  buildNonceTx(nonceIndex: number, instructions: TransactionInstruction[]): Promise<VersionedTransaction>;
}

export interface ContractApi {
  getCard(tokenId: string): Promise<CardView | null>;
  getOrderToken(orderId: string): Promise<string | null>;
  tokensOf(accountId: string): Promise<string[]>;
  checkCardMessage(hex: string): Promise<{ moves_card: boolean; uses_durable_nonce: boolean }>;
  mintPack(orderId: string, receiver: string, packType: string): Promise<string>;
  recordOpen(a: { tokenId: string; memo: string; cardMint: string; cardName: string; rarity: string; roll: number; insuredValueUsdCents: number; media: string | null }): Promise<void>;
  recordRelease(tokenId: string, reason: string): Promise<void>;
  recordExitFailed(tokenId: string): Promise<void>;
  signForTreasury(message: Uint8Array): Promise<Uint8Array>;
  /** Only the Keeper uses this, with its own account. */
  keeperSign?(keeper: import("near-api-js").Account, tokenId: string, message: Uint8Array): Promise<Uint8Array>;
  keeperPayout?(keeper: import("near-api-js").Account, tokenId: string, message: Uint8Array): Promise<Uint8Array>;
}

export type CcApi = Pick<CcClient, "machines" | "machine" | "recentPulls" | "imageUrl" | "buybackAvailable" | "generatePack" | "openPack" | "buybackQuote" | "card" | "verifyUrl">;

export interface Sponsor {
  /** Make sure the customer can pay NEAR gas for their own card signatures. */
  ensureFunded(account: string): Promise<void>;
}

export interface Deps {
  config: Pick<MintentConfig, "network" | "ccPaymentMint" | "checkoutDestinationAsset" | "checkoutMint" | "serviceFeeBps" | "nonceAccounts">;
  db: Db;
  checkout: CheckoutBackend;
  cc: CcApi;
  contract: ContractApi;
  chain: Chain;
  sponsor: Sponsor;
  /** Testnet only: fund a cash-out deposit in the token Tidepool accepts, which sell-back money on devnet isn't. Returns the transaction. */
  fundTestCashOut?: (depositAddress: string, amount: bigint) => Promise<string>;
  /** Ask the image service to prepare a resized copy now, so the customer doesn't wait for it. Never throws. */
  warmImages?: (urls: string[]) => Promise<void>;
  topUpTestTreasury?: TopUpTestTreasury;
  log: (msg: string, extra?: unknown) => void;
}

export function isSolanaSignature(s: string): boolean {
  try {
    return bs58.decode(s).length === 64;
  } catch {
    return false;
  }
}

export class SolanaChain implements Chain {
  private cards = new Map<string, string>();

  constructor(public conn: Connection, public treasury: PublicKey, private network: NearNetwork, private contractId: string) {}

  static async create(conn: Connection, network: NearNetwork, contractId: string): Promise<SolanaChain> {
    return new SolanaChain(conn, new PublicKey(await deriveSolanaAddress(network, contractId, "treasury")), network, contractId);
  }

  async cardAddress(tokenId: string): Promise<string> {
    let a = this.cards.get(tokenId);
    if (!a) {
      a = await deriveSolanaAddress(this.network, this.contractId, `card/${tokenId}`);
      this.cards.set(tokenId, a);
    }
    return a;
  }

  async assetOwner(mint: string) {
    const { owner, collection } = await readCoreAsset(this.conn, new PublicKey(mint));
    return { owner: owner.toBase58(), collection };
  }

  async recentTokenTxs(owner: string, mint: string): Promise<{ sig: string; atMs: number }[]> {
    const sigs = await this.conn.getSignaturesForAddress(await ata(new PublicKey(owner), new PublicKey(mint)), { limit: 50 });
    return sigs.filter((s) => !s.err && s.blockTime).map((s) => ({ sig: s.signature, atMs: Number(s.blockTime) * 1000 })).reverse();
  }

  async treasurySol(): Promise<bigint> {
    return BigInt(await this.conn.getBalance(this.treasury));
  }

  async signatureStatus(sig: string): Promise<SigStatus> {
    const st = (await this.conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
    if (!st) return "unknown";
    if (st.err) return "failed";
    return st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized" ? "confirmed" : "unknown";
  }

  async blockhashValid(blockhash: string): Promise<boolean> {
    return (await this.conn.isBlockhashValid(blockhash as never, { commitment: "processed" })).value;
  }

  send(tx: VersionedTransaction): Promise<string> {
    return this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5n });
  }

  async tokenBalance(owner: string, mint: string): Promise<bigint> {
    try {
      return BigInt((await this.conn.getTokenAccountBalance(await ata(new PublicKey(owner), new PublicKey(mint)))).value.amount);
    } catch {
      return 0n;
    }
  }

  async tokenDeltaInTx(sig: string, owner: string, mint: string): Promise<bigint | null> {
    // Destination lists can mix chains: a NEAR hash is 32 bytes, a Solana signature 64.
    if (!isSolanaSignature(sig)) return null;
    const tx = await this.conn.getTransaction(sig as never, { maxSupportedTransactionVersion: 0, commitment: "confirmed" } as never);
    if (!tx?.meta || tx.meta.err) return null;
    const pick = (list: readonly any[] | null | undefined) => BigInt(list?.find((b) => b.owner === owner && b.mint === mint)?.uiTokenAmount.amount ?? 0);
    return pick(tx.meta.postTokenBalances) - pick(tx.meta.preTokenBalances);
  }

  async buildNonceTx(nonceIndex: number, instructions: TransactionInstruction[]): Promise<VersionedTransaction> {
    return buildNonceTx({ conn: this.conn, treasury: this.treasury, nonceAccount: await nonceAccountFor(this.treasury, nonceIndex), instructions });
  }
}
