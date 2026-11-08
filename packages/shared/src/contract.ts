// Typed access to the mintent NEAR contract.
import type { Account } from "near-api-js";

export type CardStatus = "Sealed" | "Opened" | "Exiting" | "Released";

export interface CardView {
  token_id: string;
  owner_id: string;
  solana_path: string;
  locked_until_ms: string;
  transferable: boolean;
  record: {
    status: CardStatus;
    pack_type: string;
    memo: string | null;
    card_mint: string | null;
    rarity: string | null;
    roll: string | null;
    insured_value_usd_cents: string | null;
    release_reason: string | null;
  };
}

const TGAS = 1_000_000_000_000n;

function signatureFrom(res: unknown): Uint8Array {
  const sig = (res as { signature?: number[] })?.signature;
  if (!Array.isArray(sig) || sig.length !== 64) throw new Error(`bad MPC response ${JSON.stringify(res).slice(0, 200)}`);
  return Uint8Array.from(sig);
}

export class MintentContract {
  /** `relayer` signs relayer-only calls and pays for views. */
  constructor(public readonly contractId: string, private relayer: Account) {}

  private async view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    try {
      return (await this.relayer.provider.callFunction<any>({ contractId: this.contractId, method, args } as never)) as T;
    } catch (e: any) {
      // The failover provider wraps errors. Surface the contract's own reason, such as a policy refusal.
      const inner = (e?.errors as unknown[] | undefined)?.map(String).join("; ");
      const panic = inner?.match(/panic_msg: "([^"]*)"/)?.[1];
      throw new Error(panic ?? inner ?? String(e));
    }
  }

  getCard(tokenId: string): Promise<CardView | null> {
    return this.view("get_card", { token_id: tokenId });
  }

  getOrderToken(orderId: string): Promise<string | null> {
    return this.view("get_order_token", { order_id: orderId });
  }

  /** Dry-run the signing policy. Rejects with the contract's reason if the message would be refused. */
  checkCardMessage(payloadHex: string): Promise<{ moves_card: boolean; uses_durable_nonce: boolean }> {
    return this.view("check_card_message", { payload_hex: payloadHex });
  }

  async mintPack(orderId: string, receiver: string, packType: string): Promise<string> {
    return (await this.relayer.callFunction({ contractId: this.contractId, methodName: "mint_pack", args: { order_id: orderId, receiver_id: receiver, pack_type: packType }, gas: 100n * TGAS })) as string;
  }

  async recordOpen(a: { tokenId: string; memo: string; cardMint: string; cardName: string; rarity: string; roll: number; insuredValueUsdCents: number; media: string | null }): Promise<void> {
    await this.relayer.callFunction({
      contractId: this.contractId,
      methodName: "record_open",
      gas: 100n * TGAS,
      args: { token_id: a.tokenId, memo: a.memo, card_mint: a.cardMint, card_name: a.cardName, rarity: a.rarity, roll: String(a.roll), insured_value_usd_cents: String(a.insuredValueUsdCents), media: a.media },
    });
  }

  async recordRelease(tokenId: string, reason: string): Promise<void> {
    await this.relayer.callFunction({ contractId: this.contractId, methodName: "record_release", args: { token_id: tokenId, reason }, gas: 30n * TGAS });
  }

  async recordExitFailed(tokenId: string): Promise<void> {
    await this.relayer.callFunction({ contractId: this.contractId, methodName: "record_exit_failed", args: { token_id: tokenId }, gas: 30n * TGAS });
  }

  async signForTreasury(message: Uint8Array): Promise<Uint8Array> {
    return signatureFrom(await this.relayer.callFunction({ contractId: this.contractId, methodName: "sign_for_treasury", args: { payload_hex: Buffer.from(message).toString("hex") }, deposit: 1n, gas: 100n * TGAS }));
  }

  /** The token owner's call. In the app this runs in the user's own session, signed by the user's key. */
  async signForCard(owner: Account, tokenId: string, message: Uint8Array): Promise<Uint8Array> {
    return signatureFrom(await owner.callFunction({ contractId: this.contractId, methodName: "sign_for_card", args: { token_id: tokenId, payload_hex: Buffer.from(message).toString("hex") }, deposit: 1n, gas: 100n * TGAS }));
  }

  async transfer(owner: Account, receiver: string, tokenId: string): Promise<void> {
    await owner.callFunction({ contractId: this.contractId, methodName: "nft_transfer", args: { receiver_id: receiver, token_id: tokenId }, deposit: 1n, gas: 30n * TGAS });
  }
}
