// HTTP API for the web app. Run: RELAYER_ACCOUNT=... MINTENT_CONTRACT_ID=... pnpm relayer
// Identity: nothing here can move a card or a coin without the owner's own on-chain sign_for_card call,
// so `actor` needs no login: the contract is the authority, and the relayer double-checks it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { accountFromKey, loadAccount, loadConfig } from "@mintent/shared";
import { CardOps } from "./ops.js";
import { OrderPipeline } from "./orders.js";
import { reconcile } from "./reconcile.js";
import { createRuntime } from "./runtime.js";

/** Neutral names in our own UI: no franchise branding (see docs/PLAN.md). */
export function neutralPackName(price: number): string {
  return `$${price} Graded Card Pack`;
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

function need(o: Record<string, unknown>, ...keys: string[]) {
  for (const k of keys) if (typeof o[k] !== "string" || !o[k]) throw Object.assign(new Error(`missing ${k}`), { status: 400 });
}

export async function startServer(port = Number(process.env.PORT ?? 8787)) {
  const config = loadConfig();
  const contractId = process.env.MINTENT_CONTRACT_ID;
  const relayerId = process.env.RELAYER_ACCOUNT;
  if (!contractId || !relayerId) throw new Error("set MINTENT_CONTRACT_ID and RELAYER_ACCOUNT");
  const relayer = process.env.RELAYER_PRIVATE_KEY ? accountFromKey(config.network, relayerId, process.env.RELAYER_PRIVATE_KEY, process.env.NEAR_RPC_URL) : loadAccount(config.network, relayerId);
  const d = await createRuntime({ contractId, relayer, dbPath: process.env.RELAYER_DB ?? "relayer.sqlite", config, oneClickJwt: process.env.ONECLICK_JWT });
  const pipeline = new OrderPipeline(d);
  const ops = new CardOps(d);
  const allowedOrigin = process.env.WEB_ORIGIN ?? "*";

  const routes: [string, RegExp, (m: RegExpMatchArray, b: any) => Promise<unknown>][] = [
    ["GET", /^\/health$/, async () => ({ ok: true, network: config.network, contract: contractId, treasury: d.chain.treasury.toBase58(), checkout: d.checkout.name })],
    ["GET", /^\/packs$/, async () => {
      const list = await d.cc.machines();
      return list.map((m) => ({ code: m.code, name: neutralPackName(m.price), price: m.price, odds: m.odds, expectedValue: m.ev, buybackPct: m.instantBuyback }));
    }],
    ["GET", /^\/pay-assets$/, async () => (await d.checkout.tokens()).map((t) => ({ assetId: t.assetId, symbol: t.symbol, chain: t.blockchain, decimals: t.decimals, price: t.price }))],
    ["POST", /^\/orders$/, async (_m, b) => {
      need(b, "buyer", "packType", "originAsset", "refundTo");
      const { order, quote } = await pipeline.createOrder({ buyer: b.buyer, packType: b.packType, originAsset: b.originAsset, refundTo: b.refundTo, depositType: b.depositType, refundType: b.refundType });
      return { orderId: order.id, depositAddress: quote.depositAddress, depositMemo: quote.depositMemo, amountIn: quote.amountIn, amountInFormatted: quote.amountInFormatted, deadline: quote.deadline, priceUnits: order.price_units, amountOut: order.amount_out };
    }],
    ["GET", /^\/orders\/([^/]+)$/, async (m) => pipeline.advance(decodeURIComponent(m[1]))],
    ["POST", /^\/orders\/([^/]+)\/deposit$/, async (m, b) => {
      need(b, "txHash");
      await d.checkout.submitDeposit(b.txHash, decodeURIComponent(m[1]), b.memo);
      return { ok: true };
    }],
    ["GET", /^\/cards\/([^/]+)$/, async (m) => {
      const card = await d.contract.getCard(m[1]);
      if (!card) throw Object.assign(new Error("unknown token"), { status: 404 });
      const address = await d.chain.cardAddress(m[1]);
      const holder = card.record.card_mint ? (await d.chain.assetOwner(card.record.card_mint)).owner : null;
      const proceeds = await d.chain.tokenBalance(address, config.ccPaymentMint);
      return { ...card, solanaAddress: address, holder, heldByToken: holder === address, proceedsUnits: proceeds.toString(), verifyUrl: card.record.memo ? d.cc.verifyUrl(card.record.memo) : null, contractId, mpcContract: config.mpcContract };
    }],
    ["POST", /^\/cards\/([^/]+)\/sellback$/, async (m, b) => {
      need(b, "actor");
      return ops.prepareSellback(m[1], b.actor);
    }],
    ["POST", /^\/cards\/([^/]+)\/withdraw-card$/, async (m, b) => {
      need(b, "actor", "destination");
      return ops.prepareWithdrawCard(m[1], b.actor, b.destination);
    }],
    ["POST", /^\/cards\/([^/]+)\/withdraw-proceeds$/, async (m, b) => {
      need(b, "actor", "destination");
      return ops.prepareWithdrawProceeds(m[1], b.actor, b.destination);
    }],
    ["POST", /^\/ops\/([^/]+)\/finalize$/, async (m, b) => {
      need(b, "cardSignatureHex");
      return ops.finalize(m[1], b.cardSignatureHex);
    }],
  ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      for (const [method, re, fn] of routes) {
        const m = path.match(re);
        if (m && req.method === method) {
          const result = await fn(m, method === "POST" ? await body(req) : {});
          return void res.writeHead(200).end(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
        }
      }
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    } catch (e: any) {
      res.writeHead(e?.status ?? 500).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  await new Promise<void>((r) => server.listen(port, r));
  d.log(`listening on :${port} (${config.network}, contract ${contractId}, checkout ${d.checkout.name})`);

  // Background: move open orders forward and reconcile NEAR against Solana.
  const tick = setInterval(() => void pipeline.advanceAll().catch((e) => d.log(`advance: ${e}`)), 5_000);
  const rec = setInterval(() => void reconcile(d).then((f) => f.length && d.log(`reconcile: ${JSON.stringify(f)}`), (e) => d.log(`reconcile: ${e}`)), 60_000);
  return { server, deps: d, stop: () => { clearInterval(tick); clearInterval(rec); server.close(); } };
}

if (process.argv[1]?.endsWith("server.ts")) await startServer();
