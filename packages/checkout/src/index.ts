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
  submitDeposit(txHash: string, depositAddress: string, memo?: string): Promise<void>;
  status(depositAddress: string, memo?: string): Promise<CheckoutStatus>;
}

const OFFICIAL_HOST = "1click.chaindefuser.com";

// The official SDK's verifyQuoteSignature returns false for 1Click's own BTC quotes, live and dry, with
// SOL and ETH verifying fine (SDK 0.1.26, checked 8 Nov 2026). A known false negative must not block BTC checkouts.
// Settlement is proven on the destination chain anyway, which doesn't depend on any signature.
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
