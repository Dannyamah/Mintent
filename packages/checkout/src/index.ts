// A merchant checkout on top of NEAR Intents 1Click: "I need exactly X of asset Y at address Z; the customer pays
// from any supported asset." Works against mainnet 1Click, Tidepool (a community testnet with the same API), or an
// in-process mock. Contains nothing specific to Mintent, so any app can reuse it.

export type SwapState = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";
export const TERMINAL_STATES: SwapState[] = ["SUCCESS", "REFUNDED", "FAILED"];

export interface OneClickToken {
  assetId: string;
  symbol: string;
  blockchain: string;
  decimals: number;
  price?: number;
  contractAddress?: string;
}

export interface CheckoutRequest {
  /** Asset the customer pays with (1Click asset id). */
  originAsset: string;
  /** Asset the merchant receives. */
  destinationAsset: string;
  /** Exact amount the merchant receives, in base units. */
  amountOut: string;
  /** Merchant address on the destination chain. */
  recipient: string;
  /** Where a failed or partial payment goes back to. */
  refundTo: string;
  depositType?: "ORIGIN_CHAIN" | "INTENTS";
  refundType?: "ORIGIN_CHAIN" | "INTENTS";
  depositMode?: "SIMPLE" | "MEMO";
  deadlineMs?: number;
  slippageBps?: number;
  dry?: boolean;
  /** Tidepool only: force a failure path in tests. Ignored and never sent to mainnet. */
  simulate?: "STUCK" | "FAILED";
}

/** The opposite of a checkout: spend exactly this much, and pay out in another asset on another chain. */
export interface PayoutRequest {
  originAsset: string;
  destinationAsset: string;
  /** Exact amount going in, in base units. */
  amountIn: string;
  recipient: string;
  refundTo: string;
  deadlineMs?: number;
  slippageBps?: number;
  dry?: boolean;
}

export interface PayoutQuote {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountOut: string;
  amountOutFormatted?: string;
  minAmountOut?: string;
  deadline: string;
  timeEstimateSeconds?: number;
  /** 1Click's signed response, so the customer's own app can check it. */
  raw: unknown;
}

const EVM_CHAINS = new Set(["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "bera", "scroll", "plasma", "hood", "abs", "monad", "xlayer", "adi"]);
const ADDRESS_FORMATS: Record<string, RegExp> = {
  sol: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  near: /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/,
  btc: /^(bc1|tb1)[a-z0-9]{20,87}$|^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/,
  doge: /^[DA9n2m][1-9A-HJ-NP-Za-km-z]{25,34}$/,
  ltc: /^(ltc1|tltc1)[a-z0-9]{20,87}$|^[LM3mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/,
  xrp: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/,
  tron: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  sui: /^0x[0-9a-fA-F]{64}$/,
  aptos: /^0x[0-9a-fA-F]{1,64}$/,
  stellar: /^G[A-Z2-7]{55}$/,
  ton: /^[A-Za-z0-9_-]{48}$|^-?[0-9]:[0-9a-fA-F]{64}$/,
};

/**
 * Catch the wrong kind of address before any money moves, such as an Ethereum address for a Bitcoin refund. It checks the
 * format only, and accepts chains it doesn't know, because 1Click validates those itself when quoting.
 */
export function looksLikeAddress(chain: string, address: string): boolean {
  if (EVM_CHAINS.has(chain)) return /^0x[0-9a-fA-F]{40}$/.test(address);
  return ADDRESS_FORMATS[chain]?.test(address) ?? address.trim().length > 0;
}

/** What a customer can read when 1Click won't quote. Anything else stays in the logs. */
export function quoteErrorForCustomer(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const said = raw.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? "";
  if (/too low|too small|minimum/i.test(said)) return "This amount is too small for that coin. Try another one.";
  if (/recipient|refund|address/i.test(said)) return "That address wasn't accepted. Please check it and try again.";
  return "We couldn't get a quote for that coin right now. Try again, or choose another one.";
}

export interface CheckoutQuote {
  depositAddress: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted?: string;
  minAmountIn?: string;
  amountOut: string;
  deadline: string;
  timeEstimateSeconds?: number;
  request: CheckoutRequest;
  raw: unknown;
}

export interface CheckoutStatus {
  status: SwapState;
  updatedAt?: string;
  swapDetails: {
    amountIn?: string;
    amountOut?: string;
    refundedAmount?: string;
    refundReason?: string;
    nearTxHashes?: string[];
    originChainTxHashes?: { hash: string; explorerUrl?: string }[];
    destinationChainTxHashes?: { hash: string; explorerUrl?: string }[];
    [k: string]: unknown;
  };
  quoteResponse: { quote?: Record<string, any>; quoteRequest?: Record<string, any>; signature?: string; [k: string]: unknown };
}

export interface CheckoutBackend {
  readonly name: string;
  readonly verifiesSignatures: boolean;
  tokens(): Promise<OneClickToken[]>;
  quote(req: CheckoutRequest): Promise<CheckoutQuote>;
  payoutQuote(req: PayoutRequest): Promise<PayoutQuote>;
  submitDeposit(txHash: string, depositAddress: string, memo?: string): Promise<void>;
  status(depositAddress: string, memo?: string): Promise<CheckoutStatus>;
}

const OFFICIAL_HOST = "1click.chaindefuser.com";

// The official SDK's verifyQuoteSignature returns false for 1Click's own BTC quotes, live and dry, with
// SOL and ETH verifying fine (SDK 0.1.26, checked 8 Nov 2026). A known false negative must not block BTC checkouts.
// Settlement is proven on the destination chain anyway, which doesn't depend on any signature.
// Cash-out quotes paying out in BTC fail the same way (checked 9 Nov 2026), and are still checked against the request.
const SIGNATURE_FALSE_NEGATIVE_ORIGINS = new Set(["nep141:btc.omft.near"]);

export class HttpBackend implements CheckoutBackend {
  readonly name: string;
  readonly verifiesSignatures: boolean;
  private jwt?: string;

  constructor(private base: string, jwt?: string, private fetchImpl: typeof fetch = fetch) {
    const official = new URL(base).host === OFFICIAL_HOST;
    this.name = official ? "1click" : new URL(base).host;
    // Only 1Click's own quotes can be checked against 1Click's signing key. And a partner JWT must never leave for
    // another host: community sandboxes accept any key, so there's no reason to risk it.
    this.verifiesSignatures = official;
    this.jwt = official ? jwt : undefined;
  }

  private async call<T>(path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.jwt) headers.authorization = `Bearer ${this.jwt}`;
    const r = await this.fetchImpl(`${this.base}${path}`, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`1Click ${path} ${r.status}: ${text.slice(0, 400)}`);
    return JSON.parse(text) as T;
  }

  tokens(): Promise<OneClickToken[]> {
    return this.call("/v0/tokens");
  }

  async quote(req: CheckoutRequest): Promise<CheckoutQuote> {
    const body: Record<string, unknown> = {
      dry: req.dry ?? false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: req.slippageBps ?? 100,
      originAsset: req.originAsset,
      depositType: req.depositType ?? "ORIGIN_CHAIN",
      destinationAsset: req.destinationAsset,
      amount: req.amountOut,
      recipient: req.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: req.refundTo,
      refundType: req.refundType ?? "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + (req.deadlineMs ?? 30 * 60_000)).toISOString(),
    };
    if (req.depositMode) body.depositMode = req.depositMode;
    if (req.simulate && this.name !== "1click") body.simulate = req.simulate;
    const raw = await this.call<any>("/v0/quote", body);
    const q = raw.quote ?? {};
    if (this.verifiesSignatures && !SIGNATURE_FALSE_NEGATIVE_ORIGINS.has(req.originAsset) && !(await verifySignature(raw))) throw new Error("1Click quote signature is invalid");
    if (!req.dry && !q.depositAddress) throw new Error("quote has no deposit address");
    return { depositAddress: q.depositAddress, depositMemo: q.depositMemo, amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, minAmountIn: q.minAmountIn, amountOut: q.amountOut, deadline: q.deadline ?? (body.deadline as string), timeEstimateSeconds: q.timeEstimate, request: req, raw };
  }

  async payoutQuote(req: PayoutRequest): Promise<PayoutQuote> {
    const deadline = new Date(Date.now() + (req.deadlineMs ?? 30 * 60_000)).toISOString();
    const raw = await this.call<any>("/v0/quote", {
      dry: req.dry ?? false,
      swapType: "EXACT_INPUT",
      slippageTolerance: req.slippageBps ?? 100,
      originAsset: req.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: req.destinationAsset,
      amount: req.amountIn,
      recipient: req.recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo: req.refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline,
    });
    const q = raw.quote ?? {};
    if (this.verifiesSignatures && !SIGNATURE_FALSE_NEGATIVE_ORIGINS.has(req.destinationAsset) && !(await verifySignature(raw))) throw new Error("1Click quote signature is invalid");
    if (!req.dry && !q.depositAddress) throw new Error("quote has no deposit address");
    // The quote is what the money follows, so it must name what was asked for.
    const asked = raw.quoteRequest;
    if (asked && (asked.recipient !== req.recipient || asked.destinationAsset !== req.destinationAsset || asked.amount !== req.amountIn)) throw new Error("1Click quote doesn't match the request");
    return { depositAddress: q.depositAddress, depositMemo: q.depositMemo, amountIn: q.amountIn, amountOut: q.amountOut, amountOutFormatted: q.amountOutFormatted, minAmountOut: q.minAmountOut, deadline: q.deadline ?? deadline, timeEstimateSeconds: q.timeEstimate, raw };
  }

  async submitDeposit(txHash: string, depositAddress: string, memo?: string): Promise<void> {
    await this.call("/v0/deposit/submit", memo ? { txHash, depositAddress, memo } : { txHash, depositAddress });
  }

  status(depositAddress: string, memo?: string): Promise<CheckoutStatus> {
    const q = new URLSearchParams({ depositAddress });
    if (memo) q.set("depositMemo", memo);
    return this.call(`/v0/status?${q}`);
  }
}

async function verifySignature(raw: unknown): Promise<boolean> {
  const { verifyQuoteSignature } = (await import("@defuse-protocol/one-click-sdk-typescript")) as any;
  return Boolean(verifyQuoteSignature(raw));
}

export interface ExpectedSettlement {
  recipient: string;
  destinationAsset: string;
  /** Minimum the merchant must have received, in base units. */
  minAmountOut: bigint;
}

export interface SettlementResult {
  ok: boolean;
  reason?: string;
  amountOut?: bigint;
}

/**
 * Decide whether a payment really settled to us. A "SUCCESS" string alone is not enough: the quote behind this deposit
 * address must name our recipient, our asset and at least our amount, and on mainnet carry a valid 1Click signature.
 */
export async function verifySettlement(backend: CheckoutBackend, status: CheckoutStatus, expected: ExpectedSettlement): Promise<SettlementResult> {
  if (status.status !== "SUCCESS") return { ok: false, reason: `status is ${status.status}` };
  const req = status.quoteResponse?.quoteRequest;
  if (!req) return { ok: false, reason: "status has no quote request" };
  if (req.recipient !== expected.recipient) return { ok: false, reason: `recipient is ${req.recipient}` };
  if (req.destinationAsset !== expected.destinationAsset) return { ok: false, reason: `destination asset is ${req.destinationAsset}` };
  if (req.recipientType !== "DESTINATION_CHAIN") return { ok: false, reason: `recipient type is ${req.recipientType}` };
  const settled = status.swapDetails?.amountOut ?? status.quoteResponse?.quote?.amountOut;
  if (settled === undefined || settled === null) return { ok: false, reason: "no settled amount" };
  const amountOut = BigInt(settled);
  if (amountOut < expected.minAmountOut) return { ok: false, reason: `settled ${amountOut}, expected at least ${expected.minAmountOut}` };
  if (backend.verifiesSignatures && !SIGNATURE_FALSE_NEGATIVE_ORIGINS.has(req.originAsset) && !(await verifySignature(status.quoteResponse))) return { ok: false, reason: "quote signature is invalid" };
  return { ok: true, amountOut };
}

/** Add a service fee in basis points, rounding up. Pack price 50_000_000 at 100 bps = 50_500_000. */
export function withServiceFee(amount: bigint, bps: number): bigint {
  return amount + (amount * BigInt(bps) + 9_999n) / 10_000n;
}

/**
 * In-process backend for offline tests and the fallback path. Each deposit address walks through `script`,
 * advancing one state on each status() call once a deposit has been submitted.
 */
export class MockBackend implements CheckoutBackend {
  readonly name = "mock";
  readonly verifiesSignatures = false;
  private orders = new Map<string, { req: CheckoutRequest; quote: CheckoutQuote; deposited: boolean; step: number; script: SwapState[] }>();
  private seq = 0;
  /** Next quote's outcome. */
  nextScript: SwapState[] = ["KNOWN_DEPOSIT_TX", "PROCESSING", "SUCCESS"];
  /** Next payout quote's deposit address, for tests that need a real address format. */
  nextPayoutAddress?: string;

  async tokens(): Promise<OneClickToken[]> {
    return [
      { assetId: "mock:usdc", symbol: "USDC", blockchain: "near", decimals: 6, price: 1 },
      { assetId: "mock:btc", symbol: "BTC", blockchain: "btc", decimals: 8, price: 75000 },
    ];
  }

  async quote(req: CheckoutRequest): Promise<CheckoutQuote> {
    const depositAddress = `mock-deposit-${++this.seq}`;
    const quote: CheckoutQuote = { depositAddress, amountIn: req.amountOut, amountOut: req.amountOut, minAmountIn: req.amountOut, deadline: new Date(Date.now() + (req.deadlineMs ?? 1800000)).toISOString(), request: req, raw: {} };
    this.orders.set(depositAddress, { req, quote, deposited: false, step: 0, script: this.nextScript });
    return quote;
  }

  /** Pays out 1% less than goes in. */
  async payoutQuote(req: PayoutRequest): Promise<PayoutQuote> {
    const depositAddress = this.nextPayoutAddress ?? `mock-deposit-${++this.seq}`;
    const amountOut = ((BigInt(req.amountIn) * 99n) / 100n).toString();
    const asCheckout: CheckoutRequest = { originAsset: req.originAsset, destinationAsset: req.destinationAsset, amountOut, recipient: req.recipient, refundTo: req.refundTo };
    this.orders.set(depositAddress, { req: asCheckout, quote: { depositAddress, amountIn: req.amountIn, amountOut, deadline: "", request: asCheckout, raw: {} }, deposited: false, step: 0, script: this.nextScript });
    return { depositAddress, amountIn: req.amountIn, amountOut, amountOutFormatted: String(Number(amountOut) / 1e6), minAmountOut: amountOut, deadline: new Date(Date.now() + 1800000).toISOString(), timeEstimateSeconds: 30, raw: {} };
  }

  async submitDeposit(_txHash: string, depositAddress: string): Promise<void> {
    const o = this.orders.get(depositAddress);
    if (!o) throw new Error("Unknown depositAddress");
    o.deposited = true;
  }

  async status(depositAddress: string): Promise<CheckoutStatus> {
    const o = this.orders.get(depositAddress);
    if (!o) throw new Error("Unknown depositAddress");
    let status: SwapState = "PENDING_DEPOSIT";
    if (o.deposited) {
      status = o.script[Math.min(o.step, o.script.length - 1)];
      o.step++;
    }
    return {
      status,
      swapDetails: status === "SUCCESS" ? { amountOut: o.req.amountOut, destinationChainTxHashes: [{ hash: `mock-dest-${depositAddress}` }] } : status === "REFUNDED" ? { refundedAmount: o.req.amountOut, refundReason: "PARTIAL_DEPOSIT" } : {},
      quoteResponse: { quote: { amountOut: o.req.amountOut, depositAddress }, quoteRequest: { recipient: o.req.recipient, destinationAsset: o.req.destinationAsset, recipientType: "DESTINATION_CHAIN" } },
    };
  }
}

export function createBackend(base: string, jwt?: string): CheckoutBackend {
  return base === "mock" ? new MockBackend() : new HttpBackend(base, jwt);
}
