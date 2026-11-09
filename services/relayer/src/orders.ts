// Order pipeline: checkout -> mint sealed token -> buy CC pack -> open -> record.
// Every step is idempotent and its progress is persisted, so a crash at any point resumes safely.
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { assertSafePackTx, verifyEd25519 } from "@mintent/shared";
import { verifySettlement, withServiceFee, type CheckoutQuote } from "@mintent/checkout";
import type { Order } from "./db.js";
import type { Deps } from "./deps.js";

const MAX_ATTEMPTS_AFTER_PAYMENT = 12;
const USDC_DECIMALS = 1_000_000n;
// Enough for the fees and rent of a purchase and a sell-back. Below this, an order we took payment for would stall.
export const MIN_TREASURY_LAMPORTS = 5_000_000n;
// With a 5 s tick, 12 attempts is only about a minute, so a short RPC or treasury outage must not strand a paid order.
const ATTEMPTS_PER_RETRY = 3;
const AUTO_RETRY_EVERY_MS = 5 * 60_000;
const AUTO_RETRY_FOR_MS = 24 * 60 * 60_000;
const MANUAL_RETRY_COOLDOWN_MS = 60_000;

/**
 * Where a stuck order picks up again, worked out from what it has already recorded so no step can repeat its effect:
 * payment is proven again from the chain, the contract refuses a second mint, and purchase() checks any earlier
 * transaction before it builds a new one.
 */
export function resumeState(o: Order): Order["state"] {
  if (!o.settle_tx) return "awaiting_payment";
  return o.token_id ? "minted" : "paid";
}

export interface CreateOrderInput {
  buyer: string;
  packType: string;
  originAsset: string;
  refundTo: string;
  depositType?: "ORIGIN_CHAIN" | "INTENTS";
  refundType?: "ORIGIN_CHAIN" | "INTENTS";
  simulate?: "STUCK" | "FAILED";
}

export class OrderPipeline {
  /** One run per order at a time. Without this, two overlapping runs could each sign and pay for a pack. */
  private inFlight = new Map<string, Promise<Order>>();

  constructor(private d: Deps) {}

  async createOrder(input: CreateOrderInput): Promise<{ order: Order; quote: CheckoutQuote }> {
    const { config, cc, checkout, chain, db, log } = this.d;
    const sol = await chain.treasurySol();
    if (sol < MIN_TREASURY_LAMPORTS) {
      log(`REFUSING ORDERS: treasury ${chain.treasury.toBase58()} holds ${sol} lamports, needs ${MIN_TREASURY_LAMPORTS}. Add SOL.`);
      throw Object.assign(new Error("Mintent can't take new orders right now. You haven't been charged. Please try again later."), { status: 503 });
    }
    const machine = await cc.machine(input.packType);
    const price = BigInt(Math.round(machine.price)) * USDC_DECIMALS;
    const amountOut = withServiceFee(price, config.serviceFeeBps);
    const quote = await checkout.quote({
      originAsset: input.originAsset,
      destinationAsset: config.checkoutDestinationAsset,
      amountOut: amountOut.toString(),
      recipient: chain.treasury.toBase58(),
      refundTo: input.refundTo,
      depositType: input.depositType,
      refundType: input.refundType,
      simulate: input.simulate,
    });
    const order = db.insertOrder({
      id: quote.depositAddress,
      buyer: input.buyer,
      pack_type: input.packType,
      price_units: price.toString(),
      amount_out: amountOut.toString(),
      amount_in: quote.amountIn,
      origin_asset: input.originAsset,
      refund_to: input.refundTo,
      deposit_memo: quote.depositMemo ?? null,
      deadline: quote.deadline,
    });
    return { order, quote };
  }

  /** Run every step that can run now. Returns the order's latest state. */
  advance(id: string): Promise<Order> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const run = this.runSteps(id).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, run);
    return run;
  }

  private async runSteps(id: string): Promise<Order> {
    const { db, log } = this.d;
    let order = db.order(id);
    if (!order) throw new Error(`unknown order ${id}`);
    for (let guard = 0; guard < 8; guard++) {
      const before = order.state;
      try {
        order = await this.step(order);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const attempts = order.attempts + 1;
        if (msg !== order.last_error) log(`order ${id} ${order.state}: ${msg}`);
        const paid = order.state !== "awaiting_payment";
        return db.updateOrder(id, { attempts, last_error: msg.slice(0, 500), ...(paid && attempts >= MAX_ATTEMPTS_AFTER_PAYMENT ? { state: "needs_attention" as const } : {}) });
      }
      if (order.state === before) break;
      log(`order ${id}: ${before} -> ${order.state}`);
    }
    return order;
  }

  async advanceAll(): Promise<void> {
    this.recoverStuck();
    for (const o of this.d.db.openOrders()) await this.advance(o.id);
  }

  private resume(o: Order, why: string): Order {
    const state = resumeState(o);
    this.d.log(`order ${o.id}: needs_attention -> ${state} (${why}; last error: ${o.last_error})`);
    return this.d.db.updateOrder(o.id, { state, attempts: MAX_ATTEMPTS_AFTER_PAYMENT - ATTEMPTS_PER_RETRY });
  }

  /** Give stuck orders a few more attempts every few minutes, for a day. After that only retry() restarts them. */
  recoverStuck(now = Date.now()): void {
    for (const o of this.d.db.stuckOrders()) {
      if (this.inFlight.has(o.id) || now - o.updated_at < AUTO_RETRY_EVERY_MS || now - o.created_at > AUTO_RETRY_FOR_MS) continue;
      this.resume(o, "automatic retry");
    }
  }

  /** The customer's or operator's "try again now". Anyone can call it: a retry only repeats what the tick would do. */
  retry(id: string, now = Date.now()): Order {
    const o = this.d.db.order(id);
    if (!o) throw Object.assign(new Error("unknown order"), { status: 404 });
    if (o.state !== "needs_attention" || this.inFlight.has(id)) throw Object.assign(new Error("this order isn't waiting for a retry"), { status: 409 });
    if (now - o.updated_at < MANUAL_RETRY_COOLDOWN_MS) throw Object.assign(new Error("we just tried this order; try again in a minute"), { status: 429 });
    return this.resume(o, "manual retry");
  }

  private step(o: Order): Promise<Order> {
    switch (o.state) {
      case "awaiting_payment":
        return this.checkPayment(o);
      case "paid":
        return this.mint(o);
      case "minted":
        return this.purchase(o);
      case "purchased":
        return this.open(o);
      default:
        return Promise.resolve(o);
    }
  }

  private async checkPayment(o: Order): Promise<Order> {
    const { checkout, config, chain, db, sponsor, log } = this.d;
    const status = await checkout.status(o.id, o.deposit_memo ?? undefined);
    if (status.status === "REFUNDED") return db.updateOrder(o.id, { state: "refunded", checkout_status: status.status, last_error: String(status.swapDetails?.refundReason ?? "") });
    if (status.status === "FAILED") return db.updateOrder(o.id, { state: "payment_failed", checkout_status: status.status, last_error: String(status.swapDetails?.refundReason ?? "swap failed") });
    if (status.status !== "SUCCESS") return db.updateOrder(o.id, { checkout_status: status.status });

    const result = await verifySettlement(checkout, status, { recipient: chain.treasury.toBase58(), destinationAsset: config.checkoutDestinationAsset, minAmountOut: BigInt(o.amount_out) });
    if (!result.ok) {
      log(`order ${o.id}: settlement rejected: ${result.reason}`);
      return db.updateOrder(o.id, { state: "payment_failed", checkout_status: status.status, last_error: `settlement rejected: ${result.reason}` });
    }
    // Don't take the API's word for it: prove on the destination chain that our balance really rose, in a
    // transaction no other order has used.
    const settleTx = await this.provenSettlement(o, status.swapDetails?.destinationChainTxHashes ?? []);
    // Pay the customer's future NEAR gas. Not fatal: the card is theirs either way.
    await sponsor.ensureFunded(o.buyer).catch((e) => log(`order ${o.id}: sponsor failed: ${e}`));
    return db.updateOrder(o.id, { state: "paid", checkout_status: status.status, settle_tx: settleTx, attempts: 0, last_error: null });
  }

  private async provenSettlement(o: Order, hashes: { hash: string }[]): Promise<string> {
    const { chain, config, db } = this.d;
    const treasury = chain.treasury.toBase58();
    let total = 0n;
    let first: string | null = null;
    for (const { hash } of hashes) {
      if (db.orders().some((x) => x.settle_tx === hash && x.id !== o.id)) throw new Error(`settlement tx ${hash} was already used by another order`);
      // An RPC hiccup means "not proven yet", never "proven".
      const delta = await chain.tokenDeltaInTx(hash, treasury, config.checkoutMint).catch(() => null);
      if (delta !== null && delta > 0n) {
        total += delta;
        first ??= hash;
      }
    }
    if (!first || total < BigInt(o.amount_out)) {
      // Fail closed and retry: destination data can lag SUCCESS. A human looks if it never shows up.
      if (o.attempts + 1 >= MAX_ATTEMPTS_AFTER_PAYMENT) db.updateOrder(o.id, { state: "needs_attention", checkout_status: "SUCCESS" });
      throw new Error(`on-chain settlement not proven yet: treasury received ${total} of ${o.amount_out} in ${hashes.length} tx(s)`);
    }
    return first;
  }

  private async mint(o: Order): Promise<Order> {
    const { contract, chain, db } = this.d;
    // get_order_token makes this safe to retry: the contract refuses a second mint for the same order.
    const tokenId = (await contract.getOrderToken(o.id)) ?? (await contract.mintPack(o.id, o.buyer, o.pack_type));
    const cardAddress = await chain.cardAddress(tokenId);
    return db.updateOrder(o.id, { state: "minted", token_id: tokenId, card_address: cardAddress, attempts: 0, last_error: null });
  }

  private async purchase(o: Order): Promise<Order> {
    const { contract, chain, cc, config, db } = this.d;

    // Crash safety: the signature is saved BEFORE broadcast. If we were interrupted, find out what happened
    // before generating a new pack, so a customer's order can never pay for two packs.
    if (o.buy_sig) {
      const st = await chain.signatureStatus(o.buy_sig);
      if (st === "confirmed") return db.updateOrder(o.id, { state: "purchased", attempts: 0, last_error: null });
      if (st === "unknown" && (await chain.blockhashValid(o.buy_blockhash!))) return o; // may still land: wait
      if (st === "unknown" && (await chain.signatureStatus(o.buy_sig)) === "confirmed") return db.updateOrder(o.id, { state: "purchased", attempts: 0, last_error: null });
      // A retry can come long after the transaction, and an RPC may have pruned it. Collector Crypt only opens a pack it
      // was paid for, so ask it too before building a transaction that would pay a second time.
      if (st === "unknown" && o.memo && (await cc.openPack(o.memo).catch(() => null))) return db.updateOrder(o.id, { state: "purchased", attempts: 0, last_error: null });
      o = db.updateOrder(o.id, { buy_sig: null, buy_blockhash: null, memo: null });
    }

    const treasury = chain.treasury;
    const mint = new PublicKey(config.ccPaymentMint);
    const price = BigInt(o.price_units);
    const balance = await chain.tokenBalance(treasury.toBase58(), config.ccPaymentMint);
    if (balance < price) throw new Error(`treasury holds ${balance} of ${config.ccPaymentMint}, needs ${price}`);

    const { memo, transaction } = await cc.generatePack(treasury.toBase58(), o.pack_type, o.card_address!);
    const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
    assertSafePackTx(tx, treasury, mint, price); // never sign a CC-built transaction we haven't inspected
    const msg = tx.message.serialize();
    const sig = await contract.signForTreasury(msg);
    if (!verifyEd25519(treasury.toBase58(), msg, sig)) throw new Error("MPC signature does not verify for the treasury");
    const blockhash = tx.message.recentBlockhash;
    if (!(await chain.blockhashValid(blockhash))) throw new Error("blockhash expired while signing; will rebuild");
    tx.addSignature(treasury, sig);
    const txid = bs58.encode(tx.signatures[0]);
    db.updateOrder(o.id, { memo, buy_sig: txid, buy_blockhash: blockhash });
    await chain.send(tx);
    return db.order(o.id)!; // the next pass confirms it through the crash-safe path above
  }

  private async open(o: Order): Promise<Order> {
    const { cc, chain, contract, db } = this.d;
    const opened = await cc.openPack(o.memo!);
    if (!opened) return o; // CC hasn't seen the payment yet
    const { owner } = await chain.assetOwner(opened.nftAddress);
    if (owner !== o.card_address) throw new Error(`card ${opened.nftAddress} is owned by ${owner}, not the token's address ${o.card_address}`);
    const meta = await cc.card(opened.nftAddress);
    // The reveal is the product's best moment: have the image ready before the customer is sent to it.
    await this.d.warmImages?.([cc.imageUrl(opened.nftAddress, 800)]);
    const insuredCents = Math.round(Number(meta.insuredValue ?? 0) * 100);
    const view = await contract.getCard(o.token_id!);
    if (view?.record.status === "Sealed") {
      await contract.recordOpen({ tokenId: o.token_id!, memo: o.memo!, cardMint: opened.nftAddress, cardName: opened.cardName, rarity: opened.rarity, roll: opened.roll, insuredValueUsdCents: insuredCents, media: meta.frontImage ?? null });
    }
    return db.updateOrder(o.id, { state: "complete", card_mint: opened.nftAddress, card_name: opened.cardName, rarity: opened.rarity, roll: opened.roll, insured_cents: insuredCents, delivery_tx: opened.deliveryTx, attempts: 0, last_error: null });
  }
}
