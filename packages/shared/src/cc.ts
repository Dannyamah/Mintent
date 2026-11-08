// Collector Crypt API client (gacha + marketplace reads). No API key is needed for these endpoints.
export interface CcMachine {
  code: string;
  name: string;
  price: number;
  instantBuyback: number;
  ev: number | null;
  odds: Record<string, number>;
}

export interface BuybackQuote {
  memo: string;
  refundAmount: number;
  quote: {
    ed25519Instruction: { programId: string; data: string };
    quoteMarker: string;
    quoteId: string;
    price: string;
    expiresAt: number;
    paymentMint: string;
    destinationOwner: string;
    treasury: string;
    rentVault: string;
    ccProgram: string;
    memoProgram: string;
    tokenProgram: string;
    standard: string;
    computeUnitLimit: number;
    memo: string;
  };
}

export interface OpenedPack {
  nftAddress: string;
  rarity: string;
  roll: number;
  cardName: string;
  deliveryTx: string;
}

export interface CardCatalog {
  insuredValue?: string;
  nftStandard?: string;
  itemName?: string;
  grade?: string;
  gradingCompany?: string;
  frontImage?: string;
}

export class CcClient {
  constructor(private gacha: string, private api: string, private fetchImpl: typeof fetch = fetch) {}

  private async json(url: string, body?: unknown): Promise<{ status: number; data: any }> {
    const r = await this.fetchImpl(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await r.text();
    try {
      return { status: r.status, data: JSON.parse(text) };
    } catch {
      return { status: r.status, data: text };
    }
  }

  async machines(): Promise<CcMachine[]> {
    const { status, data } = await this.json(`${this.gacha}/api/machines`);
    const list = Array.isArray(data) ? data : data?.machines;
    if (!Array.isArray(list)) throw new Error(`machines ${status}: unexpected response`);
    return list;
  }

  async machine(code: string): Promise<CcMachine> {
    const m = (await this.machines()).find((x) => x.code === code);
    if (!m) throw new Error(`unknown pack ${code}`);
    return m;
  }

  /** Returns a transaction partially signed by CC; `playerAddress` pays USDC and the card goes to `cardAddress`. */
  async generatePack(playerAddress: string, packType: string, cardAddress: string): Promise<{ memo: string; transaction: string }> {
    const { status, data } = await this.json(`${this.gacha}/api/generatePack`, { playerAddress, packType, altPlayerAddress: cardAddress });
    if (!data?.transaction || !data?.memo) throw new Error(`generatePack ${status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  /** null while CC has not seen the payment yet. Idempotent: never sends a second card. */
  async openPack(memo: string): Promise<OpenedPack | null> {
    const { status, data } = await this.json(`${this.gacha}/api/openPack`, { memo });
    if (data?.nft_address) {
      return { nftAddress: data.nft_address, rarity: String(data.rarity), roll: Number(data.roll ?? 0), cardName: data.nftWon?.content?.metadata?.name ?? "Card", deliveryTx: data.transactionSignature };
    }
    if (data?.code === "WAITING_FOR_WEBHOOK" || status === 404 || status === 503) return null;
    throw new Error(`openPack ${status}: ${JSON.stringify(data).slice(0, 300)}`);
  }

  async buybackQuote(seller: string, nftAddress: string): Promise<BuybackQuote> {
    const { status, data } = await this.json(`${this.gacha}/api/buyback`, { playerAddress: seller, nftAddress, sellerProgram: "mintent" });
    if (!data?.quote) throw new Error(`buyback quote ${status}: ${JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  async buybackAvailable(nft: string): Promise<{ available: boolean; expiresAt?: string; raw: unknown }> {
    const { data } = await this.json(`${this.gacha}/api/buyback/available?nft=${nft}`);
    return { available: Boolean(data?.available ?? data?.eligible), expiresAt: data?.buybackExpiresAt, raw: data };
  }

  async card(mint: string): Promise<CardCatalog> {
    const { data } = await this.json(`${this.api}/cards/publicNft/${mint}`);
    return typeof data === "object" && data ? data : {};
  }

  /** CC's own verifier for a pack's randomness. */
  verifyUrl(memo: string): string {
    return `${this.gacha}/verify-selection/${memo}`;
  }

  async verifyPack(memo: string): Promise<any> {
    return (await this.json(`${this.gacha}/api/vrf/verify?memo=${encodeURIComponent(memo)}`)).data;
  }
}
