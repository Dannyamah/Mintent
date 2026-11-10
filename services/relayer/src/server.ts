// HTTP API for the web app. Run: RELAYER_ACCOUNT=... MINTENT_CONTRACT_ID=... pnpm relayer
// Identity: nothing here can move a card or a coin without the owner's own on-chain sign_for_card call,
// so `actor` needs no login: the contract is the authority, and the relayer double-checks it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { KeyPair, type KeyPairString } from "near-api-js";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { accountFromKey, cardCode, CONFIGS, isStandardCardPack, loadAccount, loadConfig, nearProvider, NETWORKS, packSlug, type RecentPull } from "@mintent/shared";

/** A private key from ~/.near-credentials/<network>/<name>.json, or null. */
const keyFile = (network: string, name: string): string | null => {
  const file = join(homedir(), ".near-credentials", network, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { private_key: string }).private_key : null;
};
import { CardOps } from "./ops.js";
import { OrderPipeline } from "./orders.js";
import { reconcile } from "./reconcile.js";
import { createRuntime } from "./runtime.js";
import { createKeeper } from "./keeper.js";
import { createCardIndex } from "./card-index.js";
import { createTestnetUpkeep, testPayLimits, testPayRefusal } from "./testnet-upkeep.js";

/** Neutral names in our own UI: no franchise branding (see docs/PLAN.md). */
export function neutralPackName(price: number): string {
  return `$${price} Graded Card Pack`;
}

// Tidepool refuses to swap a coin for itself, so the test network can't take USDC on Solana. Mainnet 1Click quotes it (9 Nov).
// 1Click temporarily blocks small swaps from these chains (docs changelog, Sep 2026), so they can't pay for a pack.
const SMALL_SWAPS_BLOCKED = new Set(["bsc", "pol", "ton", "op", "avax", "stellar", "monad", "xlayer", "adi", "tron"]);
const TESTNET_USDC = "usdc.tidepool-sandbox.testnet";
const TESTNET_VERIFIER = "verifier.tidepool-sandbox.testnet";
const TESTNET_PAY_ASSET = `nep141:${TESTNET_USDC}`;

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

export async function startServer(port = Number(process.env.PORT || 8787)) {
  const config = loadConfig();
  const contractId = process.env.MINTENT_CONTRACT_ID;
  const relayerId = process.env.RELAYER_ACCOUNT;
  if (!contractId || !relayerId) throw new Error("set MINTENT_CONTRACT_ID and RELAYER_ACCOUNT");
  const relayer = process.env.RELAYER_PRIVATE_KEY ? accountFromKey(config.network, relayerId, process.env.RELAYER_PRIVATE_KEY, process.env.NEAR_RPC_URL) : loadAccount(config.network, relayerId);
  const d = await createRuntime({ contractId, relayer, dbPath: process.env.RELAYER_DB || "relayer.sqlite", config, oneClickJwt: process.env.ONECLICK_JWT });
  const pipeline = new OrderPipeline(d);
  const ops = new CardOps(d);
  // Only our own sites may call this from a browser. Unset means any origin, which is for local development.
  const origins = (process.env.WEB_ORIGIN || "").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
  // Testnet convenience only: lets the app pay a quote with test USDC. Never available on mainnet.
  const funderId = config.network === "testnet" ? process.env.DEMO_FUNDER : undefined;
  const funder = funderId ? (process.env.DEMO_FUNDER_PRIVATE_KEY ? accountFromKey("testnet", funderId, process.env.DEMO_FUNDER_PRIVATE_KEY, process.env.NEAR_RPC_URL) : loadAccount("testnet", funderId)) : null;
  const limits = testPayLimits();
  // The Keeper signs with its own account, which owners name in their permission. Without one, the feature is off.
  const keeperId = process.env.KEEPER_ACCOUNT || null;
  // The Keeper should run with its function-call key (scripts/src/restrict-keeper-key.ts), which can call only keeper_sign and
  // keeper_payout on this contract. Locally that's <keeper>.function-call.json, before the account's full-access key.
  const keeperKey = keeperId ? (process.env.KEEPER_PRIVATE_KEY || keyFile(config.network, `${keeperId}.function-call`) || keyFile(config.network, keeperId)) : null;
  const keeperAccount = keeperId && keeperKey ? accountFromKey(config.network, keeperId, keeperKey, process.env.NEAR_RPC_URL) : null;
  // What the Keeper's key is allowed to do, read from NEAR, for /health and the card page.
  let keeperKeyScope: { kind: "function-call"; contract: string; methods: string[] } | { kind: "full-access" } | null = null;
  if (keeperId && keeperKey) {
    const publicKey = KeyPair.fromString(keeperKey as KeyPairString).getPublicKey().toString();
    const nearRpc = nearProvider(config.network);
    void nearRpc.query({ request_type: "view_access_key", finality: "final", account_id: keeperId, public_key: publicKey } as never).then(
      (k) => {
        const p = (k as unknown as { permission: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[] } } }).permission;
        keeperKeyScope = p === "FullAccess" ? { kind: "full-access" } : { kind: "function-call", contract: p.FunctionCall.receiver_id, methods: p.FunctionCall.method_names };
        if (keeperKeyScope.kind === "full-access") console.warn("the Keeper is running with a full-access key: run scripts/src/restrict-keeper-key.ts");
      },
      (e) => console.warn(`couldn't read the Keeper's key from NEAR: ${String(e).slice(0, 160)}`),
    );
  }
  let gallery: { at: number; pulls: RecentPull[] } = { at: 0, pulls: [] };

  const cards = createCardIndex(d.contract, contractId);
  const packView = (m: Awaited<ReturnType<typeof d.cc.machines>>[number]) => ({ code: m.code, slug: packSlug(neutralPackName(m.price)), name: neutralPackName(m.price), price: m.price, odds: m.odds, expectedValue: m.ev, buybackPct: m.instantBuyback });

  // Everything the app shows about a token, read live from NEAR, Solana and Collector Crypt.
  const cardView = async (key: string) => {
    const tokenId = await cards.resolve(key);
    if (!tokenId) throw Object.assign(new Error("unknown card"), { status: 404 });
    const card = await d.contract.getCard(tokenId);
    if (!card) throw Object.assign(new Error("unknown token"), { status: 404 });
    const address = await d.chain.cardAddress(tokenId);
    const mint = card.record.card_mint;
    const holder = mint ? (await d.chain.assetOwner(mint)).owner : null;
    const proceeds = await d.chain.tokenBalance(address, config.ccPaymentMint);
    const heldByToken = holder === address;
    const offer = mint && heldByToken ? await d.cc.buybackAvailable(mint).catch(() => null) : null;
    const order = d.db.orderByToken(tokenId);
    const catalog = mint && !order?.card_name ? await d.cc.card(mint).catch(() => null) : null;
    return {
      ...card,
      solanaAddress: address,
      holder,
      heldByToken,
      proceedsUnits: proceeds.toString(),
      verifyUrl: card.record.memo ? d.cc.verifyUrl(card.record.memo) : null,
      contractId,
      mpcContract: config.mpcContract,
      name: order?.card_name ?? catalog?.itemName ?? null,
      image: mint ? d.cc.imageUrl(mint, 800) : null,
      thumb: mint ? d.cc.imageUrl(mint, 320) : null,
      offer: offer?.available ? { amountUnits: offer.amountUnits, expiresAt: offer.expiresAt } : null,
      mintedAt: order?.created_at ?? null,
      keeperStatus: d.db.keeperStatus(tokenId) ?? null,
      links: await cards.links(tokenId, Boolean(mint)),
    };
  };

  const assetView = (t: { assetId: string; symbol: string; blockchain: string; decimals: number; price?: number; contractAddress?: string }) => ({ assetId: t.assetId, symbol: t.symbol, chain: t.blockchain, decimals: t.decimals, price: t.price, contract: t.contractAddress ?? null });

  const routes: [string, RegExp, (m: RegExpMatchArray, b: any, req: IncomingMessage) => Promise<unknown>][] = [
    ["GET", /^\/health$/, async () => ({ ok: true, network: config.network, contract: contractId, treasury: d.chain.treasury.toBase58(), checkout: d.checkout.name, mpcContract: config.mpcContract, serviceFeeBps: config.serviceFeeBps, defaultPack: CONFIGS[config.network].defaultPack, nearRpcs: [NETWORKS[config.network].rpc, ...NETWORKS[config.network].rpcFallbacks], testPay: Boolean(funder), keeper: keeperId, keeperKey: keeperKeyScope, testPayAsset: funder ? TESTNET_PAY_ASSET : null })],
    ["GET", /^\/gallery$/, async () => {
      return gallery.pulls;
    }],
    ["GET", /^\/card-image\/([1-9A-HJ-NP-Za-km-z]{32,44})$/, async (m) => ({ image: d.cc.imageUrl(m[1], 800) })],
    ["GET", /^\/owners\/([^/]+)\/cards$/, async (m) => d.contract.tokensOf(decodeURIComponent(m[1]))],
    ["GET", /^\/packs$/, async () => {
      // One pack per price. Prefer the standard machine at that price, then the best expected value.
      const best = new Map<number, Awaited<ReturnType<typeof d.cc.machines>>[number]>();
      const score = (m: { code: string; ev: number | null }) => (m.code.startsWith("pokemon_") ? 1e9 : 0) + (m.ev ?? 0);
      for (const m of await d.cc.machines()) {
        if (!isStandardCardPack(m.code) || !m.ev || !m.price || m.price % 1 !== 0) continue;
        const cur = best.get(m.price);
        if (!cur || score(m) > score(cur)) best.set(m.price, m);
      }
      return [...best.values()].sort((a, b) => a.price - b.price).map(packView);
    }],
    ["GET", /^\/packs\/([A-Za-z0-9_-]+)$/, async (m) => {
      if (!isStandardCardPack(m[1])) throw Object.assign(new Error("that pack isn't offered"), { status: 404 });
      const machine = await d.cc.machine(m[1]);
      const recent = gallery.pulls.filter((p) => p.packType === m[1]).slice(0, 12);
      return { ...packView(machine), recent: recent.length >= 4 ? recent : gallery.pulls.slice(0, 12), recentIsFromThisPack: recent.length >= 4 };
    }],
    ["GET", /^\/owners\/([^/]+)\/dashboard$/, async (m) => {
      const account = decodeURIComponent(m[1]);
      const ids = await d.contract.tokensOf(account).catch(() => [] as string[]);
      const cards = (await Promise.all(ids.slice(0, 60).map((id) => cardView(id).catch(() => null)))).filter((c) => c !== null);
      const orders = d.db.ordersByBuyer(account);
      const ops = d.db.opsByActor(account);
      const activity = [
        ...orders.map((o) => ({ kind: "order", at: o.created_at, state: o.state, tokenId: o.token_id, code: o.token_id ? cardCode(contractId, o.token_id) : null, name: o.card_name, rarity: o.rarity, packPriceUnits: o.price_units, tx: o.buy_sig, orderId: o.id })),
        ...ops.filter((o) => o.state === "sent").map((o) => ({ kind: o.kind, at: o.created_at, byKeeper: Boolean((JSON.parse(o.detail) as { keeper?: string }).keeper), state: o.state, tokenId: o.token_id, code: cardCode(contractId, o.token_id), detail: JSON.parse(o.detail), tx: o.tx_sig, swapStatus: o.swap_status, swapAmountOut: o.swap_amount_out })),
      ].sort((a, b) => b.at - a.at).slice(0, 40);
      return { account, cards, active: orders.filter((o) => ["awaiting_payment", "paid", "minted", "purchased", "needs_attention"].includes(o.state)).map((o) => ({ orderId: o.id, state: o.state, status: o.checkout_status, packType: o.pack_type, priceUnits: o.price_units, createdAt: o.created_at, lastError: o.last_error, tokenId: o.token_id, code: o.token_id ? cardCode(contractId, o.token_id) : null })), activity };
    }],
    ["GET", /^\/pay-assets$/, async () => (await d.checkout.tokens()).filter((t) => !SMALL_SWAPS_BLOCKED.has(t.blockchain) && (config.network !== "testnet" || t.assetId !== config.checkoutDestinationAsset)).map(assetView)],
    // The small-swap block is on where a swap is paid from, so a cash-out can go to those chains.
    ["GET", /^\/cash-out-assets$/, async () => (await d.checkout.tokens()).map(assetView)],
    ["POST", /^\/orders$/, async (_m, b) => {
      need(b, "buyer", "packType", "originAsset", "refundTo");
      const { order, quote } = await pipeline.createOrder({ buyer: b.buyer, packType: b.packType, originAsset: b.originAsset, refundTo: b.refundTo, depositType: b.depositType, refundType: b.refundType });
      return { orderId: order.id, depositAddress: quote.depositAddress, depositMemo: quote.depositMemo, amountIn: quote.amountIn, amountInFormatted: quote.amountInFormatted, deadline: quote.deadline, priceUnits: order.price_units, amountOut: order.amount_out, timeEstimateSeconds: quote.timeEstimateSeconds };
    }],
    // Reads only. The background tick moves orders forward; a page poll must never start a purchase.
    ["GET", /^\/orders\/([^/]+)$/, async (m) => {
      const order = d.db.order(decodeURIComponent(m[1]));
      if (!order) throw Object.assign(new Error("unknown order"), { status: 404 });
      return { ...order, verifyUrl: order.memo ? d.cc.verifyUrl(order.memo) : null, code: order.token_id ? cardCode(contractId, order.token_id) : null };
    }],
    ["POST", /^\/orders\/([^/]+)\/retry$/, async (m) => {
      const { state } = pipeline.retry(decodeURIComponent(m[1]));
      return { ok: true, state };
    }],
    ["POST", /^\/orders\/([^/]+)\/test-pay$/, async (m, _b, req) => {
      if (!funder) throw Object.assign(new Error("test payments are not available"), { status: 403 });
      const order = d.db.order(decodeURIComponent(m[1]));
      if (!order || order.state !== "awaiting_payment" || order.origin_asset !== `nep141:${TESTNET_USDC}`) throw Object.assign(new Error("this order can't take a test payment"), { status: 400 });
      // Free test packs are shared by everyone, so each visitor gets a few a day. Behind Railway's proxy, the first forwarded address is the visitor.
      const visitor = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "unknown").split(",")[0].trim();
      const refusal = testPayRefusal(d.db.testPayCounts(visitor, order.buyer, Date.now() - 24 * 3600_000), limits);
      if (refusal) throw Object.assign(new Error(refusal), { status: 429 });
      if (!d.db.recordTestPay(order.id, order.buyer, visitor)) throw Object.assign(new Error("this order has already been paid"), { status: 409 });
      const tx = await funder.callFunctionRaw({ contractId: TESTNET_USDC, methodName: "ft_transfer_call", args: { receiver_id: TESTNET_VERIFIER, amount: order.amount_in, msg: order.id }, deposit: 1n, gas: 100_000_000_000_000n });
      await d.checkout.submitDeposit(tx.transaction.hash, order.id).catch(() => undefined);
      return { ok: true };
    }],
    ["POST", /^\/orders\/([^/]+)\/deposit$/, async (m, b) => {
      need(b, "txHash");
      await d.checkout.submitDeposit(b.txHash, decodeURIComponent(m[1]), b.memo);
      return { ok: true };
    }],
    ["GET", /^\/cards\/([^/]+)$/, async (m) => cardView(decodeURIComponent(m[1]))],
    // Where a slug, a code or an old token id points: the app uses it to turn old links into readable ones.
    ["GET", /^\/lookup\/([^/]+)$/, async (m) => {
      const tokenId = await cards.resolve(decodeURIComponent(m[1]));
      if (!tokenId) throw Object.assign(new Error("unknown card"), { status: 404 });
      return cards.links(tokenId);
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
    ["POST", /^\/cards\/([^/]+)\/cash-out$/, async (m, b) => {
      need(b, "actor", "destinationAsset", "recipient");
      return ops.prepareCashOut(m[1], b.actor, b.destinationAsset, String(b.recipient).trim());
    }],
    ["GET", /^\/ops\/([^/]+)$/, async (m) => {
      const op = d.db.op(decodeURIComponent(m[1]));
      if (!op) throw Object.assign(new Error("unknown operation"), { status: 404 });
      return op;
    }],
    ["POST", /^\/ops\/([^/]+)\/finalize$/, async (m, b) => {
      need(b, "cardSignatureHex");
      return ops.finalize(m[1], b.cardSignatureHex);
    }],
  ];

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = String(req.headers.origin ?? "").replace(/\/$/, "");
    if (!origins.length) res.setHeader("Access-Control-Allow-Origin", "*");
    else if (origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Content-Type", "application/json");
    if (req.method === "OPTIONS") return void res.writeHead(204).end();
    const path = new URL(req.url ?? "/", "http://x").pathname;
    try {
      for (const [method, re, fn] of routes) {
        const m = path.match(re);
        if (m && req.method === method) {
          const result = await fn(m, method === "POST" ? await body(req) : {}, req);
          return void res.writeHead(200).end(JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
        }
      }
      res.writeHead(404).end(JSON.stringify({ error: "not found" }));
    } catch (e: any) {
      res.writeHead(e?.status ?? 500).end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
  });
  // The wall must never make a visitor wait for resizing, so prepare its images before publishing them.
  const refreshGallery = async () => {
    // Only pulls from the packs we sell, so the wall shows what a buyer can actually get.
    const pulls = (await d.cc.recentPulls(200)).filter((p) => isStandardCardPack(p.packType)).slice(0, 60);
    if (!pulls.length) return;
    await d.warmImages?.(pulls.map((p) => p.thumb));
    gallery = { at: Date.now(), pulls };
  };
  await refreshGallery().catch((e) => d.log(`gallery: ${e}`));
  // Testnet only: test payments settle in a different mint from the one Collector Crypt's devnet charges, so the treasury
  // only ever drains there. On mainnet the buyer's payment funds the purchase and d.topUpTestTreasury doesn't exist.
  const topUp = () => void d.topUpTestTreasury?.().catch((e) => d.log(`treasury top-up: ${e}`));
  topUp();
  await new Promise<void>((r) => server.listen(port, r));
  d.log(`listening on :${port} (${config.network}, contract ${contractId}, checkout ${d.checkout.name})`);

  // Background: move open orders forward and reconcile NEAR against Solana.
  const tick = setInterval(() => void pipeline.advanceAll().catch((e) => d.log(`advance: ${e}`)), 5_000);
  const wall = setInterval(() => void refreshGallery().catch((e) => d.log(`gallery: ${e}`)), 5 * 60_000);
  const rec = setInterval(() => void reconcile(d).then((f) => f.length && d.log(`reconcile: ${JSON.stringify(f)}`), (e) => d.log(`reconcile: ${e}`)), 60_000);
  const funds = setInterval(topUp, 60_000);
  // Testnet only: refill the funder and the treasury's SOL from what the demo itself has used.
  const upkeep = funder ? createTestnetUpkeep(d, funder) : null;
  if (upkeep) void upkeep();
  const keep = upkeep ? setInterval(() => void upkeep(), 5 * 60_000) : null;
  const keeper = keeperAccount ? createKeeper(d, ops, keeperAccount) : null;
  const keeping = keeper ? setInterval(() => void keeper().catch((e) => d.log(`keeper: ${e}`)), 30_000) : null;
  let cashingOut = false;
  const cashOuts = setInterval(() => {
    if (cashingOut) return; // funding a testnet deposit can outlast a tick, and mustn't run twice
    cashingOut = true;
    void ops.advanceCashOuts().catch((e) => d.log(`cash-outs: ${e}`)).finally(() => { cashingOut = false; });
  }, 5_000);
  return { server, deps: d, stop: () => { clearInterval(tick); clearInterval(rec); clearInterval(wall); clearInterval(funds); clearInterval(cashOuts); if (keep) clearInterval(keep); if (keeping) clearInterval(keeping); server.close(); } };
}

if (process.argv[1]?.endsWith("server.ts")) {
  try {
    process.loadEnvFile(new URL("../../../.env", import.meta.url));
  } catch {
    /* no .env: everything comes from the environment. Values already set always win. */
  }
  await startServer();
}
