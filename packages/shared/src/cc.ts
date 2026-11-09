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

/** One recent pull from CC's public feed. No names: our UI identifies a card by grade and value only. */
export interface RecentPull {
  mint: string;
  image: string;
  /** A small copy for the wall, about a quarter of the size. Falls back to `image`. */
  thumb: string;
  grader: string | null;
  grade: string | null;
  insuredValue: number;
  url: string | null;
  packType: string | null;
  rarityTier: number | null;
  at: string | null;
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

  /** CC's real offer for a card: what it pays and until when. Use this, not a percentage of insured value. */
  async buybackAvailable(nft: string): Promise<{ available: boolean; amountUnits: number; expiresAt: string | null }> {
    const { data } = await this.json(`${this.gacha}/api/buyback/available?nft=${nft}`);
    return { available: data?.available === true, amountUnits: Number(data?.amount ?? 0), expiresAt: data?.buybackExpiresAt ?? null };
  }

  /** A resized card image from CC's public metadata service. */
  imageUrl(mint: string, width: number): string {
    return `https://${this.gacha.includes("//dev-") ? "nft-dev" : "nft"}.collectorcrypt.com/front/${mint}?width=${width}`;
  }

  /** Recent real pulls on CC's machines, for the gallery wall. */
  async recentPulls(count = 50): Promise<RecentPull[]> {
    const { data } = await this.json(`${this.gacha}/api/getAllWinners?count=${count}`);
    const list: any[] = Array.isArray(data) ? data : (data?.data ?? []);
    const seen = new Set<string>();
    const out: RecentPull[] = [];
    for (const w of list) {
      const content = w?.nft?.content ?? {};
      const image = content.files?.[0]?.cc_cdn ?? content.links?.image;
      const mint = w?.nft_address ?? w?.nft?.id;
      if (!image || !mint || seen.has(mint)) continue;
      seen.add(mint);
      const traits: Record<string, string> = Object.fromEntries((content.metadata?.attributes ?? []).map((a: any) => [a.trait_type, String(a.value)]));
      out.push({ mint, image, thumb: this.imageUrl(mint, 320), grader: traits["Grading Company"] ?? null, grade: traits["The Grade"] ?? traits["GradeNum"] ?? traits["Grade"] ?? null, insuredValue: Number(w.insuredValue ?? 0), url: content.links?.external_url ?? null, packType: w.pack_type ?? null, rarityTier: w.prize_tier ?? null, at: w.created_at ?? null });
    }
    return out;
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

/**
 * Collector Crypt's standard graded-card machines, the only packs Mintent offers. Its other machines include sealed product,
 * watches and comics, which aren't graded cards and haven't been tested through our purchase and sell-back flow.
 */
export function isStandardCardPack(code: string | null | undefined): boolean {
  return typeof code === "string" && /^pokemon_\d+$/.test(code);
}
