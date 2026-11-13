import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, createPublicKey } from "node:crypto";
import { beforeEach, test } from "node:test";
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { looksLikeAddress, MockBackend, quoteErrorForCustomer } from "@mintent/checkout";
import { afterExitFee, ata, COMPUTE_BUDGET, CONFIGS, exitFee, loadConfig, MEMO_PROGRAM, MPL_CORE, realRpcError, TOKEN_PROGRAM, transferCheckedIx, withRealErrors, type CardView } from "@mintent/shared";
import { canFillEveryDraw } from "@mintent/shared";
import { CardOps, createKeeper, currentKeeperStatus, Db, grantKey, isSolanaSignature, keeperShouldSell, OrderPipeline, reconcile, sponsorAmounts, type Chain, type ContractApi, type Deps } from "../src/index.ts";

function keypair() {
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  return { address: bs58.encode(pub), sign: (m: Uint8Array) => new Uint8Array(edSign(null, Buffer.from(m), privateKey)) };
}

const treasuryKp = keypair();
const cardKp = keypair();
const TREASURY = new PublicKey(treasuryKp.address);
const CARD = cardKp.address;
const GACHA = new PublicKey("A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv");
const USDC = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const MINT = "44zam74dQs2GgESFg3bD7TMHAaCtonZ4B4YPXzd367X2";
const BLOCKHASH = "C7SnyRTwxDbennYRKpBadraiahftrdXZzmFaCCt5Pbbd";

function packTx(amount: bigint, extra: TransactionInstruction[] = [], payer = GACHA): string {
  const mint = new PublicKey(USDC);
  const ixs = [
    new TransactionInstruction({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.from([2, 0x80, 0x38, 1, 0]) }),
    new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from("cc-memo") }),
    transferCheckedIx(TREASURY, mint, GACHA, TREASURY, amount, 6),
    ...extra,
  ];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: BLOCKHASH as never, instructions: ixs }).compileToLegacyMessage());
  if (payer.equals(GACHA)) tx.signatures[0] = new Uint8Array(64).fill(tx.signatures.length + Number(amount % 200n) + ++sigSeed);
  return Buffer.from(tx.serialize()).toString("base64");
}
let sigSeed = 0;

interface World {
  deps: Deps;
  checkout: MockBackend;
  card: CardView;
  generatePacks: number;
  treasurySigns: number;
  sent: VersionedTransaction[];
  sigStatus: "confirmed" | "failed" | "unknown";
  blockhashOk: boolean;
  balance: bigint;
  assetOwnerIs: string;
  packTxFactory: () => string;
  releases: string[];
  exitsCleared: number;
  opened: number;
  mints: number;
  minted: Map<string, string>;
  sponsored: string[];
  settledDelta: bigint | null;
  ccSawPayment: boolean;
  treasurySol: bigint;
  incoming: { sig: string; atMs: number; delta: bigint }[];
}

function world(): World {
  const w: World = {
    checkout: new MockBackend(),
    card: { token_id: "0", owner_id: "alice", solana_path: "card/0", locked_until_ms: "0", transferable: true, record: { status: "Sealed", pack_type: "p", memo: null, card_mint: null, rarity: null, roll: null, insured_value_usd_cents: null, release_reason: null } },
    generatePacks: 0,
    treasurySigns: 0,
    sent: [],
    sigStatus: "confirmed",
    blockhashOk: true,
    balance: 1_000_000_000n,
    assetOwnerIs: CARD,
    packTxFactory: () => packTx(25_000_000n),
    releases: [],
    exitsCleared: 0,
    opened: 0,
    mints: 0,
    minted: new Map(),
    sponsored: [],
    settledDelta: 25_250_000n,
    ccSawPayment: false,
    treasurySol: 1_000_000_000n,
    incoming: [],
    deps: null as never,
  };
  const contract: ContractApi = {
    getCard: async () => w.card,
    getOrderToken: async (id) => w.minted.get(id) ?? null,
    tokensOf: async () => ["0"],
    checkCardMessage: async () => ({ moves_card: true, uses_durable_nonce: true }),
    mintPack: async (id) => {
      w.mints++;
      w.minted.set(id, "0");
      return "0";
    },
    recordOpen: async (a) => {
      w.opened++;
      w.card.record.status = "Opened";
      w.card.record.card_mint = a.cardMint;
    },
    recordRelease: async (_t, reason) => {
      w.releases.push(reason);
      w.card.record.status = "Released";
    },
    recordExitFailed: async () => {
      w.exitsCleared++;
      w.card.record.status = "Opened";
    },
    signForTreasury: async (m) => {
      w.treasurySigns++;
      return treasuryKp.sign(m);
    },
  };
  const chain: Chain = {
    treasury: TREASURY,
    cardAddress: async () => CARD,
    assetOwner: async () => ({ owner: w.assetOwnerIs, collection: null }),
    signatureStatus: async () => w.sigStatus,
    blockhashValid: async () => w.blockhashOk,
    send: async (tx) => {
      w.sent.push(tx);
      return "sent-sig";
    },
    tokenBalance: async () => w.balance,
    treasurySol: async () => w.treasurySol,
    recentTokenTxs: async () => w.incoming.map(({ sig, atMs }) => ({ sig, atMs })),
    tokenDeltaInTx: async (sig) => w.incoming.find((i) => i.sig === sig)?.delta ?? w.settledDelta,
    buildNonceTx: async (_i, ixs) => new VersionedTransaction(new TransactionMessage({ payerKey: TREASURY, recentBlockhash: BLOCKHASH as never, instructions: ixs }).compileToV0Message()),
  };
  w.deps = {
    config: { network: "testnet", ccPaymentMint: USDC, checkoutDestinationAsset: "dest", checkoutMint: "x", serviceFeeBps: 100, nonceAccounts: 1 },
    db: new Db(),
    checkout: w.checkout,
    cc: {
      machine: async () => ({ code: "pokemon_25", name: "n", price: 25, instantBuyback: 85, ev: 27, odds: {} }),
      generatePack: async () => {
        w.generatePacks++;
        return { memo: `memo-${w.generatePacks}`, transaction: w.packTxFactory() };
      },
      // Like the real API: a pack only opens once it has been paid for.
      openPack: async () => (w.sigStatus === "confirmed" || w.ccSawPayment ? { nftAddress: MINT, rarity: "Rare", roll: 7, cardName: "Card", deliveryTx: "delivery" } : null),
      buybackQuote: async () => { throw new Error("not used"); },
      card: async () => ({ insuredValue: "21.69", frontImage: "img" }),
      verifyUrl: (m: string) => m,
      imageUrl: (m: string) => `img/${m}`,
      buybackAvailable: async () => ({ available: true, amountUnits: 1, expiresAt: null }),
    } as never,
    contract,
    chain,
    sponsor: { ensureFunded: async (a) => void w.sponsored.push(a) },
    log: () => {},
  };
  return w;
}

async function paidOrder(w: World) {
  const p = new OrderPipeline(w.deps);
  const { order } = await p.createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:usdc", refundTo: "alice" });
  await w.checkout.submitDeposit("tx", order.id);
  return { p, id: order.id };
}

async function runUntilSettled(p: OrderPipeline, id: string, passes = 8) {
  let o = await p.advance(id);
  for (let i = 0; i < passes && !["complete", "refunded", "payment_failed", "needs_attention"].includes(o.state); i++) o = await p.advance(id);
  return o;
}

let w: World;
beforeEach(() => {
  w = world();
});

test("the quote asks for price + 1% at the treasury", async () => {
  const { order, quote } = await new OrderPipeline(w.deps).createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:usdc", refundTo: "alice" });
  assert.equal(order.price_units, "25000000");
  assert.equal(order.amount_out, "25250000");
  assert.equal(quote.request.recipient, TREASURY.toBase58());
  assert.equal(order.state, "awaiting_payment");
});

test("nothing happens before payment", async () => {
  const { order } = await new OrderPipeline(w.deps).createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:usdc", refundTo: "alice" });
  const o = await new OrderPipeline(w.deps).advance(order.id);
  assert.equal(o.state, "awaiting_payment");
  assert.equal(w.mints, 0);
});

test("happy path: paid -> minted -> purchased -> complete, and the buyer is sponsored", async () => {
  const { p, id } = await paidOrder(w);
  const o = await runUntilSettled(p, id);
  assert.equal(o.state, "complete");
  assert.equal(w.mints, 1);
  assert.equal(w.generatePacks, 1);
  assert.equal(w.opened, 1);
  assert.equal(o.insured_cents, 2169);
  assert.equal(o.card_address, CARD);
  assert.deepEqual(w.sponsored, ["alice"]);
  assert.equal(w.sent.length, 1);
});

test("crash after broadcast: resuming never buys a second pack", async () => {
  const { p, id } = await paidOrder(w);
  w.sigStatus = "unknown";
  let o = await runUntilSettled(p, id, 3);
  assert.equal(o.state, "minted");
  assert.ok(o.buy_sig);
  assert.equal(w.generatePacks, 1);
  // Process restarts with the same database. The transaction turns out to have landed.
  w.sigStatus = "confirmed";
  o = await runUntilSettled(new OrderPipeline(w.deps), id);
  assert.equal(o.state, "complete");
  assert.equal(w.generatePacks, 1, "must not generate a second pack");
  assert.equal(w.sent.length, 1, "must not broadcast twice");
});

test("overlapping runs of one order never buy two packs", async () => {
  const { p, id } = await paidOrder(w);
  for (let i = 0; i < 8 && w.deps.db.order(id)!.state !== "complete"; i++) await Promise.all([p.advance(id), p.advance(id), p.advance(id)]);
  assert.equal(w.deps.db.order(id)!.state, "complete");
  assert.equal(w.generatePacks, 1);
  assert.equal(w.sent.length, 1);
});

test("expired purchase is rebuilt, exactly one more time", async () => {
  const { p, id } = await paidOrder(w);
  w.sigStatus = "unknown";
  await runUntilSettled(p, id, 3);
  assert.equal(w.generatePacks, 1);
  w.blockhashOk = false;
  await p.advance(id); // expired: clears and fails on the expiry guard before sending
  assert.equal(w.generatePacks, 2);
  assert.equal(w.sent.length, 1, "an expired signature is never broadcast");
  w.blockhashOk = true;
  w.sigStatus = "confirmed";
  const o = await runUntilSettled(p, id);
  assert.equal(o.state, "complete");
});

test("the treasury refuses CC transactions it hasn't inspected", async () => {
  const cases: [string, () => string, RegExp][] = [
    ["charges too much", () => packTx(26_000_000n), /more than/],
    ["extra program", () => packTx(25_000_000n, [new TransactionInstruction({ programId: MPL_CORE, keys: [], data: Buffer.from([1]) })]), /unexpected instruction/],
    ["second transfer", () => packTx(25_000_000n, [transferCheckedIx(TREASURY, new PublicKey(USDC), GACHA, TREASURY, 1n, 6)]), /unexpected instruction/],
    ["inflated priority fee", () => packTx(25_000_000n, [new TransactionInstruction({ programId: COMPUTE_BUDGET, keys: [], data: Buffer.concat([Buffer.from([3]), Buffer.from(new BigUint64Array([10_000_000_000n]).buffer)]) })], TREASURY), /priority fee/],
  ];
  for (const [name, factory, why] of cases) {
    const x = world();
    x.packTxFactory = factory;
    const { p, id } = await paidOrder(x);
    const o = await runUntilSettled(p, id, 6);
    assert.equal(x.treasurySigns, 0, `${name}: must not sign`);
    assert.match(o.last_error ?? "", why, name);
    assert.equal(o.state, "minted");
  }
});

test("CC making the treasury its fee payer is fine at a normal priority fee (it does this when the player holds SOL)", async () => {
  w.packTxFactory = () => packTx(25_000_000n, [], TREASURY);
  const { p, id } = await paidOrder(w);
  assert.equal((await runUntilSettled(p, id)).state, "complete");
  assert.equal(w.treasurySigns, 1);
});

test("a paid order that can't finish goes to needs_attention, not silently nowhere", async () => {
  w.balance = 0n;
  const { p, id } = await paidOrder(w);
  let o = await p.advance(id);
  for (let i = 0; i < 20 && o.state !== "needs_attention"; i++) o = await p.advance(id);
  assert.equal(o.state, "needs_attention");
  assert.match(o.last_error ?? "", /treasury holds/);
  assert.equal(w.treasurySigns, 0);
});

// A confidential swap: status says SUCCESS, with no payout hash we can use.
function noReportedHash() {
  const real = w.checkout.status.bind(w.checkout);
  w.checkout.status = async (d) => {
    const s = await real(d);
    if (s.status === "SUCCESS") s.swapDetails = { ...s.swapDetails, destinationChainTxHashes: [] };
    return s;
  };
  w.settledDelta = null;
}
const FULL = 25_250_000n;

test("with no reported hash, a fresh transaction for the full amount proves payment", async () => {
  noReportedHash();
  w.incoming = [{ sig: "inflow-1", atMs: Date.now(), delta: FULL }];
  const { p, id } = await paidOrder(w);
  const o = await runUntilSettled(p, id);
  assert.equal(o.state, "complete");
  assert.equal(o.settle_tx, "inflow-1");
  assert.equal(w.mints, 1);
});

test("the same transaction can't prove two orders", async () => {
  noReportedHash();
  w.incoming = [{ sig: "inflow-1", atMs: Date.now(), delta: FULL }];
  const a = await paidOrder(w);
  assert.equal((await runUntilSettled(a.p, a.id)).settle_tx, "inflow-1");
  const b = await paidOrder(w);
  const stuck = await b.p.advance(b.id);
  const again = await b.p.advance(b.id);
  assert.equal(stuck.settle_tx, null);
  assert.equal(again.state, "awaiting_payment");
  assert.equal(w.mints, 1);

  w.incoming.push({ sig: "inflow-2", atMs: Date.now(), delta: FULL });
  assert.equal((await runUntilSettled(b.p, b.id)).settle_tx, "inflow-2");
  assert.equal(w.mints, 2);
});

test("a transaction too small, or from before the order, proves nothing", async () => {
  noReportedHash();
  w.incoming = [{ sig: "small", atMs: Date.now(), delta: FULL - 1n }, { sig: "old", atMs: Date.now() - 10 * 60_000, delta: FULL }];
  const { p, id } = await paidOrder(w);
  let o = await p.advance(id);
  for (let i = 0; i < 20 && o.state === "awaiting_payment"; i++) o = await p.advance(id);
  assert.equal(o.state, "needs_attention");
  assert.match(o.last_error ?? "", /not proven/);
  assert.equal(w.mints, 0);
});

test("an unpaid order is never completed by someone else's transaction", async () => {
  // The treasury received money, but 1Click hasn't said this order was paid.
  w.incoming = [{ sig: "other", atMs: Date.now(), delta: FULL }];
  const { order } = await new OrderPipeline(w.deps).createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:usdc", refundTo: "alice" });
  const o = await new OrderPipeline(w.deps).advance(order.id);
  assert.equal(o.state, "awaiting_payment");
  assert.equal(w.mints, 0);
});

test("an RPC failure during the on-chain search isn't treated as proof", async () => {
  noReportedHash();
  w.incoming = [{ sig: "inflow-1", atMs: Date.now(), delta: FULL }];
  w.deps.chain.recentTokenTxs = async () => { throw new Error("429"); };
  const { p, id } = await paidOrder(w);
  assert.equal((await p.advance(id)).state, "awaiting_payment");
  assert.equal(w.mints, 0);
});

test("a reported hash is still used first", async () => {
  w.incoming = [{ sig: "other-inflow", atMs: Date.now(), delta: FULL }];
  const { p, id } = await paidOrder(w);
  const o = await runUntilSettled(p, id);
  assert.match(o.settle_tx ?? "", /^mock-dest-/);
});

test("a pack whose drawn tier could be empty is neither offered nor sold, so nobody pays for a pack that can't be filled", async () => {
  // Collector Crypt's devnet $25 machine on 13 Nov: no commons left, and 75% of draws are commons.
  const empty = { odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 }, stock: { common: 0, uncommon: 845, rare: 3689, epic: 487 } };
  assert.equal(canFillEveryDraw(empty), false);
  assert.equal(canFillEveryDraw({ ...empty, stock: { ...empty.stock, common: 1 } }), true);
  assert.equal(canFillEveryDraw({ odds: { common: 1, epic: 0 }, stock: { common: 3, epic: 0 } }), true, "a tier the odds never land on doesn't matter");
  assert.equal(canFillEveryDraw({ odds: { common: 1 } }), true, "no stock reported: don't block");
  const cc = w.deps.cc as { machine: unknown };
  const before = cc.machine;
  cc.machine = async () => ({ code: "pokemon_25", name: "n", price: 25, instantBuyback: 85, ev: 27, ...empty });
  try {
    await assert.rejects(new OrderPipeline(w.deps).createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:usdc", refundTo: "alice" }), { status: 409 });
    assert.equal(w.deps.db.orders().length, 0);
  } finally {
    cc.machine = before;
  }
});

test("no new orders when the treasury can't pay Solana fees, so nobody pays into a stall", async () => {
  w.treasurySol = 1_200_000n; // the real low balance that was found on devnet
  await assert.rejects(new OrderPipeline(w.deps).createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:usdc", refundTo: "alice" }), { status: 503 });
  assert.equal(w.deps.db.orders().length, 0);
  w.treasurySol = 5_000_000n;
  assert.ok((await new OrderPipeline(w.deps).createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:usdc", refundTo: "alice" })).order);
});

// Run an order until it's stuck, then run the clock past the retry interval.
async function stuck(p: OrderPipeline, id: string) {
  let o = await p.advance(id);
  for (let i = 0; i < 40 && o.state !== "needs_attention"; i++) o = await p.advance(id);
  assert.equal(o.state, "needs_attention");
  return o;
}
const MINUTE = 60_000;

test("a stuck order recovers by itself once the cause is fixed, and buys exactly one pack", async () => {
  w.balance = 0n;
  const { p, id } = await paidOrder(w);
  const o = await stuck(p, id);
  assert.equal(o.token_id, "0");

  p.recoverStuck(Date.now() + MINUTE); // too soon
  assert.equal(w.deps.db.order(id)!.state, "needs_attention");

  w.balance = 1_000_000_000n;
  p.recoverStuck(Date.now() + 6 * MINUTE);
  assert.equal(w.deps.db.order(id)!.state, "minted");
  assert.equal((await runUntilSettled(p, id)).state, "complete");
  assert.equal(w.generatePacks, 1);
  assert.equal(w.treasurySigns, 1);
  assert.equal(w.mints, 1);
});

test("a retry after the pack was paid for only opens it, and never pays again", async () => {
  const { p, id } = await paidOrder(w);
  w.deps.cc.openPack = async () => { throw new Error("openPack 500: down"); };
  await stuck(p, id);
  assert.equal(w.generatePacks, 1);

  w.deps.cc.openPack = async () => ({ nftAddress: MINT, rarity: "Rare", roll: 7, cardName: "Card", deliveryTx: "delivery" });
  p.recoverStuck(Date.now() + 6 * MINUTE);
  assert.equal((await runUntilSettled(p, id)).state, "complete");
  assert.equal(w.generatePacks, 1);
  assert.equal(w.treasurySigns, 1);
});

test("if the RPC has forgotten a paid purchase, Collector Crypt's answer stops a second payment", async () => {
  const { p, id } = await paidOrder(w);
  w.sigStatus = "unknown";
  let o = await p.advance(id);
  for (let i = 0; i < 5 && !o.buy_sig; i++) o = await p.advance(id);
  const generated = w.generatePacks;
  assert.ok(o.buy_sig);

  w.blockhashOk = false;
  w.ccSawPayment = true;
  assert.equal((await runUntilSettled(p, id)).state, "complete");
  assert.equal(w.generatePacks, generated);
});

test("an order stuck before minting resumes at the mint, and settlement proof is still required", async () => {
  w.settledDelta = 1n;
  const { p, id } = await paidOrder(w);
  await stuck(p, id);
  p.recoverStuck(Date.now() + 6 * MINUTE);
  assert.equal(w.deps.db.order(id)!.state, "awaiting_payment");
  await stuck(p, id); // still unproven: back to stuck, with no mint
  assert.equal(w.mints, 0);

  w.settledDelta = 25_250_000n;
  p.recoverStuck(Date.now() + 6 * MINUTE);
  assert.equal((await runUntilSettled(p, id)).state, "complete");
  assert.equal(w.mints, 1);
});

test("a retry round is short: three more attempts, not another twelve", async () => {
  w.balance = 0n;
  const { p, id } = await paidOrder(w);
  await stuck(p, id);
  p.recoverStuck(Date.now() + 6 * MINUTE);
  let passes = 0;
  let o = w.deps.db.order(id)!;
  while (o.state !== "needs_attention" && passes++ < 20) o = await p.advance(id);
  assert.equal(passes, 3);
});

test("automatic retries stop after a day, and a manual retry still works", async () => {
  w.balance = 0n;
  const { p, id } = await paidOrder(w);
  await stuck(p, id);
  p.recoverStuck(Date.now() + 25 * 60 * MINUTE);
  assert.equal(w.deps.db.order(id)!.state, "needs_attention");
  assert.equal(p.retry(id, Date.now() + 25 * 60 * MINUTE).state, "minted");
});

test("manual retry: unknown orders, orders that aren't stuck and repeat presses are refused", async () => {
  w.balance = 0n;
  const { p, id } = await paidOrder(w);
  assert.throws(() => p.retry("nope"), { status: 404 });
  assert.throws(() => p.retry(id), { status: 409 }); // still running normally
  await stuck(p, id);
  assert.throws(() => p.retry(id), { status: 429 }); // it only just failed
  p.retry(id, Date.now() + 2 * MINUTE);
  assert.throws(() => p.retry(id, Date.now() + 4 * MINUTE), { status: 409 });
});

test("refunded and rejected orders are final: nothing restarts them", async () => {
  w.checkout.nextScript = ["PROCESSING", "REFUNDED"];
  const { p, id } = await paidOrder(w);
  assert.equal((await runUntilSettled(p, id)).state, "refunded");
  p.recoverStuck(Date.now() + 6 * MINUTE);
  assert.equal(w.deps.db.order(id)!.state, "refunded");
  assert.throws(() => p.retry(id, Date.now() + 6 * MINUTE), { status: 409 });
});

const MAINNET_CASH_OUT = { network: "mainnet", ccPaymentMint: USDC, checkoutDestinationAsset: "dest", checkoutMint: USDC, serviceFeeBps: 100, nonceAccounts: 1 } as const;
const cashOut = (op: { detail: string }) => JSON.parse(op.detail);
// A cash-out moves USDC, not the card, and the contract's policy classifies it that way.
const cashOutOps = () => {
  w.deps.contract.checkCardMessage = async () => ({ moves_card: false, uses_durable_nonce: true });
  return new CardOps(w.deps);
};

test("cash-out on mainnet: the NFT's address pays 1Click's deposit address, and a refund comes back to it", async () => {
  w.deps.config = MAINNET_CASH_OUT as never;
  let asked: Record<string, string> | undefined;
  const quote = w.checkout.payoutQuote.bind(w.checkout);
  w.checkout.payoutQuote = async (r) => { asked = r as never; return quote(r); };
  const deposit = keypair().address;
  w.checkout.nextPayoutAddress = deposit;
  const ops = cashOutOps();
  const op = await ops.prepareCashOut("0", "alice", "mock:btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  assert.equal(op.kind, "cash_out");
  assert.equal(op.moves_card, 0);
  assert.equal(asked!.refundTo, CARD);
  assert.equal(asked!.amountIn, (w.balance - exitFee(w.balance)).toString()); // the swap gets what's left after the fee
  assert.equal(cashOut(op).symbol, "BTC");
  assert.equal(cashOut(op).depositAddress, deposit);
  const keys = VersionedMessage.deserialize(Buffer.from(op.message_hex, "hex")).staticAccountKeys.map((k) => k.toBase58());
  assert.ok(keys.includes((await ata(new PublicKey(deposit), new PublicKey(USDC))).toBase58()), "the USDC goes to the deposit address");
  assert.ok(keys.includes((await ata(TREASURY, new PublicKey(USDC))).toBase58()), "and the fee to the treasury");
});

test("the exit fee is 1%, at least $0.25, and an amount that can't cover it is refused", () => {
  assert.equal(exitFee(15_300_000n), 250_000n); // $15.30 sell-back: the $0.25 minimum
  assert.equal(exitFee(25_000_000n), 250_000n);
  assert.equal(exitFee(100_000_000n), 1_000_000n); // $100: 1%
  assert.equal(exitFee(100_000_001n), 1_000_001n); // rounds up
  assert.deepEqual(afterExitFee(15_300_000n), { fee: 250_000n, net: 15_050_000n });
  assert.equal(afterExitFee(250_000n), null);
});

async function transfers(hex: string) {
  const m = VersionedMessage.deserialize(Buffer.from(hex, "hex"));
  const keys = m.staticAccountKeys.map((k) => k.toBase58());
  return m.compiledInstructions.filter((ix) => keys[ix.programIdIndex] === TOKEN_PROGRAM.toBase58()).map((ix) => ({ to: keys[ix.accountKeyIndexes[2]], amount: Buffer.from(ix.data).readBigUInt64LE(1) }));
}

test("a USDC withdrawal sends the owner's share and the fee to the treasury, in one transaction", async () => {
  w.balance = 15_300_000n;
  const dest = keypair().address;
  const op = await cashOutOps().prepareWithdrawProceeds("0", "alice", dest);
  const usdc = new PublicKey(USDC);
  assert.deepEqual(await transfers(op.message_hex), [
    { to: (await ata(new PublicKey(dest), usdc)).toBase58(), amount: 15_050_000n },
    { to: (await ata(TREASURY, usdc)).toBase58(), amount: 250_000n },
  ]);
  assert.equal(JSON.parse(op.detail).fee, "250000");
});

test("a cash-out takes the fee before the swap, and withdrawing the card is free", async () => {
  w.deps.config = MAINNET_CASH_OUT as never;
  w.balance = 100_000_000n;
  const deposit = keypair().address;
  w.checkout.nextPayoutAddress = deposit;
  const op = await cashOutOps().prepareCashOut("0", "alice", "mock:usdc", "alice.near");
  const usdc = new PublicKey(USDC);
  assert.deepEqual(await transfers(op.message_hex), [
    { to: (await ata(new PublicKey(deposit), usdc)).toBase58(), amount: 99_000_000n },
    { to: (await ata(TREASURY, usdc)).toBase58(), amount: 1_000_000n },
  ]);

  w.deps.db.updateOp(op.id, { state: "expired" }); // free the one signing slot this test world has
  w.card.record.status = "Opened";
  w.card.record.card_mint = MINT;
  w.deps.contract.checkCardMessage = async () => ({ moves_card: true, uses_durable_nonce: true });
  const card = await new CardOps(w.deps).prepareWithdrawCard("0", "alice", keypair().address);
  assert.deepEqual(await transfers(card.message_hex), []);
});

test("too little USDC to cover the fee is refused before anything is signed", async () => {
  w.balance = 200_000n;
  await assert.rejects(cashOutOps().prepareWithdrawProceeds("0", "alice", keypair().address), /too small/);
  await assert.rejects(cashOutOps().prepareCashOut("0", "alice", "mock:usdc", "alice.near"), /too small/);
});

test("cash-out refuses the wrong kind of address and someone who doesn't own the NFT", async () => {
  const ops = cashOutOps();
  await assert.rejects(ops.prepareCashOut("0", "alice", "mock:btc", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"), { status: 400 });
  await assert.rejects(ops.prepareCashOut("0", "mallory", "mock:btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), /not the owner/);
  await assert.rejects(ops.prepareCashOut("0", "alice", "mock:nope", "alice.near"), { status: 400 });
  w.balance = 0n;
  await assert.rejects(ops.prepareCashOut("0", "alice", "mock:usdc", "alice.near"), /no proceeds/);
});

test("cash-out follows the swap to the end, funds the deposit once, and reports the result", async () => {
  const funded: string[] = [];
  const fundedAmounts: bigint[] = [];
  w.deps.fundTestCashOut = async (d, amount) => { funded.push(d); fundedAmounts.push(amount); return "fund-tx"; };
  const ops = cashOutOps();
  const op = await ops.prepareCashOut("0", "alice", "mock:usdc", "alice.near");
  await ops.advanceCashOuts();
  assert.equal(funded.length, 0); // not until the owner's transaction has landed

  w.deps.db.updateOp(op.id, { state: "sent", tx_sig: "card-tx" });
  for (let i = 0; i < 6; i++) await ops.advanceCashOuts();
  const end = w.deps.db.op(op.id)!;
  assert.equal(end.swap_status, "SUCCESS");
  assert.equal(end.swap_deposit_tx, "fund-tx");
  assert.ok(end.swap_dest_tx);
  assert.equal(funded.length, 1);
  assert.equal(fundedAmounts[0], w.balance - exitFee(w.balance)); // the treasury funds only what's left after the fee
  await ops.advanceCashOuts();
  assert.equal(funded.length, 1);
});

test("a refunded cash-out is reported as refunded", async () => {
  w.deps.config = MAINNET_CASH_OUT as never;
  w.checkout.nextScript = ["PROCESSING", "REFUNDED"];
  w.checkout.nextPayoutAddress = keypair().address;
  const ops = cashOutOps();
  const op = await ops.prepareCashOut("0", "alice", "mock:usdc", "alice.near");
  w.deps.db.updateOp(op.id, { state: "sent", tx_sig: "card-tx" });
  for (let i = 0; i < 4; i++) await ops.advanceCashOuts();
  assert.equal(w.deps.db.op(op.id)!.swap_status, "REFUNDED");
  assert.equal(w.deps.db.op(op.id)!.swap_deposit_tx, "card-tx"); // mainnet: the NFT's own transaction is the deposit
});

test("a failed step in a cash-out retries on the next pass", async () => {
  let fail = true;
  w.deps.fundTestCashOut = async () => { if (fail) throw new Error("RPC down"); return "fund-tx"; };
  const ops = cashOutOps();
  const op = await ops.prepareCashOut("0", "alice", "mock:usdc", "alice.near");
  w.deps.db.updateOp(op.id, { state: "sent", tx_sig: "card-tx" });
  await ops.advanceCashOuts();
  assert.equal(w.deps.db.op(op.id)!.swap_deposit_tx, null);
  fail = false;
  await ops.advanceCashOuts();
  assert.equal(w.deps.db.op(op.id)!.swap_deposit_tx, "fund-tx");
});

test("the wrong kind of refund address stops an order before anyone can pay", async () => {
  const p = new OrderPipeline(w.deps);
  await assert.rejects(p.createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:btc", refundTo: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }), { status: 400 });
  await assert.rejects(p.createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:nope", refundTo: "alice" }), { status: 400 });
  assert.equal(w.deps.db.orders().length, 0);
  const { order } = await p.createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:btc", refundTo: "  bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq " });
  assert.equal(order.refund_to, "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  const asked = await new OrderPipeline(w.deps).createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:btc", refundTo: " 1BoatSLRHtKNngkdXEeobR76b53LETtpyT " });
  assert.equal(asked.quote.request.refundTo, "1BoatSLRHtKNngkdXEeobR76b53LETtpyT");
});

test("a refused quote gives the customer a plain message, never the raw API response", async () => {
  w.checkout.quote = async () => { throw new Error('1Click /v0/quote 400: {"message":"originAsset and destinationAsset must differ"}'); };
  await assert.rejects(new OrderPipeline(w.deps).createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:usdc", refundTo: "alice" }), (e: Error & { status?: number }) => {
    assert.equal(e.status, 502);
    assert.doesNotMatch(e.message, /1Click|originAsset|\{/);
    return true;
  });
  assert.match(quoteErrorForCustomer(new Error('400: {"message":"Amount is too low for bridge"}')), /too small/);
  assert.match(quoteErrorForCustomer(new Error('400: {"message":"invalid recipient"}')), /address/);
});

test("a relayer is never pointed at another network's Solana RPC", () => {
  const mainnetUrl = "https://mainnet.helius-rpc.com/?api-key=x";
  assert.equal(loadConfig({ NEAR_NETWORK: "testnet", SOLANA_RPC_URL: mainnetUrl }).solanaRpc, CONFIGS.testnet.solanaRpc);
  assert.equal(loadConfig({ NEAR_NETWORK: "mainnet", SOLANA_RPC_URL: mainnetUrl }).solanaRpc, mainnetUrl);
  assert.equal(loadConfig({ NEAR_NETWORK: "testnet", SOLANA_RPC_URL: "" }).solanaRpc, CONFIGS.testnet.solanaRpc);
  assert.throws(() => loadConfig({ NEAR_NETWORK: "mainnet", SOLANA_RPC_URL: "https://devnet.helius-rpc.com/?api-key=x" }), /test network/);
});

test("free test packs are capped per visitor, per account and in total, and can't be paid twice", async () => {
  const { testPayLimits, testPayRefusal } = await import("../src/testnet-upkeep.ts");
  const limits = testPayLimits({});
  assert.deepEqual(limits, { perVisitorPerDay: 3, perAccountPerDay: 3, allPerDay: 40 });
  const db = new Db();
  const since = Date.now() - 24 * 3600_000;
  for (let i = 0; i < 3; i++) assert.ok(db.recordTestPay(`o${i}`, "alice", "1.2.3.4"));
  assert.equal(db.recordTestPay("o0", "alice", "1.2.3.4"), false);
  assert.match(testPayRefusal(db.testPayCounts("1.2.3.4", "bob", since), limits) ?? "", /free test packs/);
  assert.match(testPayRefusal(db.testPayCounts("5.6.7.8", "alice", since), limits) ?? "", /free test packs/);
  assert.equal(testPayRefusal(db.testPayCounts("5.6.7.8", "bob", since), limits), null);
  assert.match(testPayRefusal({ visitor: 0, account: 0, all: 40 }, limits) ?? "", /all been used/);
  assert.deepEqual(db.testPayCounts("1.2.3.4", "alice", Date.now() + 1), { visitor: 0, account: 0, all: 0 });
});

test("only standard graded-card packs can be ordered", async () => {
  const p = new OrderPipeline(w.deps);
  for (const code of ["sealed_80", "epokewatch_1500", "comic_250", "pokemon_25x", "", "pokemon_"]) await assert.rejects(p.createOrder({ buyer: "alice", packType: code, originAsset: "mock:usdc", refundTo: "alice" }), { status: 400 }, code);
  assert.equal(w.deps.db.orders().length, 0);
  assert.ok((await p.createOrder({ buyer: "alice", packType: "pokemon_100", originAsset: "mock:usdc", refundTo: "alice" })).order);
});

// ---------- keeper ----------

const FUTURE = () => String(Date.now() + 3_600_000);
const ccQuote = (price: string) => ({
  memo: "m:buyback",
  refundAmount: 0,
  quote: {
    ed25519Instruction: { programId: "Ed25519SigVerify111111111111111111111111111", data: Buffer.alloc(144).toString("base64") },
    quoteMarker: keypair().address, quoteId: "1", price, expiresAt: Math.floor(Date.now() / 1000) + 600, paymentMint: USDC,
    destinationOwner: keypair().address, treasury: keypair().address, rentVault: keypair().address,
    ccProgram: "CcBuyM7sDhedBGLZxivBvgZVdqzrQAG66KYHgnTTEpLF", memoProgram: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", tokenProgram: TOKEN_PROGRAM.toBase58(),
    standard: "core", computeUnitLimit: 250_000, memo: "m:buyback",
  },
});

/** A delivered card with a Keeper permission, and a Collector Crypt offer of `offer` against a minimum of `floor`. */
async function keptCard(offer: number, floor = "15000000") {
  const { p, id } = await paidOrder(w);
  assert.equal((await runUntilSettled(p, id)).state, "complete");
  w.card.keeper = { agent: "keeper", min_price: floor, expires_ms: FUTURE() };
  w.deps.cc.buybackAvailable = async () => ({ available: true, amountUnits: offer, expiresAt: null });
  w.deps.cc.buybackQuote = async () => ccQuote(String(offer)) as never;
  w.deps.contract.checkCardMessage = async () => ({ moves_card: true, uses_durable_nonce: true });
  const signed: string[] = [];
  const contract = { ...w.deps.contract, keeperSign: async (_k: unknown, tokenId: string, m: Uint8Array) => { signed.push(tokenId); return cardKp.sign(m); } };
  w.deps.contract = contract as never;
  const ops = new CardOps(w.deps);
  return { ops, signed, tick: createKeeper(w.deps as never, ops, { accountId: "keeper" } as never) };
}

test("the Keeper's rule: sell only while the offer meets the minimum and the permission lasts", () => {
  const grant = { min_price: "15000000", expires_ms: String(Date.now() + 1000) };
  assert.equal(keeperShouldSell(grant, { available: true, amountUnits: 15_000_000 }, Date.now()).sell, true);
  assert.equal(keeperShouldSell(grant, { available: true, amountUnits: 14_999_999 }, Date.now()).sell, false);
  assert.equal(keeperShouldSell(grant, { available: false, amountUnits: 99_000_000 }, Date.now()).sell, false);
  assert.equal(keeperShouldSell(grant, { available: true, amountUnits: 99_000_000 }, Date.now() + 2000).sell, false);
  assert.equal(keeperShouldSell(null, { available: true, amountUnits: 99_000_000 }, Date.now()).sell, false);
});

test("a Keeper status from an earlier permission is never shown as the current one", () => {
  const db = new Db(":memory:");
  const before = { min_price: "17300000", expires_ms: "1800000000000", hold: false, payout: "5f5TjVbkD3o4nFcrDZXmzKFSVQoBoQETNfucuhKJCF5D" };
  db.setKeeperStatus("0", "waiting", "Waiting: the offer is $15.30, below your $17.30 minimum.", grantKey(before));
  const status = db.keeperStatus("0");
  assert.equal(currentKeeperStatus(status, before)?.detail, "Waiting: the offer is $15.30, below your $17.30 minimum.");
  // The owner turns the Keeper off and on again at a new minimum: the old note must not describe the new permission.
  assert.equal(currentKeeperStatus(status, { min_price: "15300000", expires_ms: "1800000000000", hold: false, payout: null }), null);
  // Once the permission is gone (sold, or turned off), the last note stays readable.
  assert.equal(currentKeeperStatus(status, null)?.detail, "Waiting: the offer is $15.30, below your $17.30 minimum.");
  assert.equal("grant_key" in (currentKeeperStatus(status, null) ?? {}), false);
});

test("the Keeper sells for the owner: the sale is the owner's, and the Keeper pays its own gas", async () => {
  const { tick, signed } = await keptCard(15_300_000);
  const [decision] = await tick();
  assert.equal(decision.action, "sold");
  assert.deepEqual(signed, ["0"]);
  assert.deepEqual(w.releases, ["bought_back"]);
  const op = w.deps.db.opsByActor("alice")[0];
  assert.equal(op.kind, "sellback");
  assert.equal(JSON.parse(op.detail).keeper, "keeper");
  assert.ok(w.sponsored.includes("keeper"));
});

test("the Keeper waits while the offer is below the owner's minimum", async () => {
  const { tick, signed } = await keptCard(14_000_000);
  const [decision] = await tick();
  assert.equal(decision.action, "waiting");
  assert.deepEqual(signed, []);
  assert.equal(w.sent.length, 1); // only the pack purchase
});

test("the relayer won't co-sign if the owner withdraws the permission, or sells the NFT, before the sale lands", async () => {
  for (const change of [(c: typeof w.card) => { c.keeper = null; }, (c: typeof w.card) => { c.owner_id = "bob"; }]) {
    w = world();
    const { tick } = await keptCard(15_300_000);
    const sign = w.deps.contract.keeperSign!;
    w.deps.contract.keeperSign = async (...a) => { change(w.card); return sign(...a); };
    const [decision] = await tick();
    assert.equal(decision.action, "waiting");
    assert.deepEqual(w.releases, []);
    assert.equal(w.sent.length, 1);
  }
});

test("hold mode: the Keeper keeps the card until the offer's last 24 hours", () => {
  const grant = { min_price: "15000000", expires_ms: String(Date.now() + 40 * 86_400_000), hold: true };
  const offer = (hoursLeft: number) => ({ available: true, amountUnits: 15_300_000, expiresAt: new Date(Date.now() + hoursLeft * 3_600_000).toISOString() });
  const early = keeperShouldSell(grant, offer(72), Date.now());
  assert.equal(early.sell, false);
  assert.match(early.why, /Holding your card/);
  assert.equal(keeperShouldSell(grant, offer(23), Date.now()).sell, true);
  assert.equal(keeperShouldSell(grant, { available: true, amountUnits: 15_300_000, expiresAt: null }, Date.now()).sell, true, "unknown deadline: don't risk missing it");
  assert.equal(keeperShouldSell({ ...grant, hold: false }, offer(72), Date.now()).sell, true);
});

test("the owner can read why the Keeper is waiting", async () => {
  const { tick } = await keptCard(14_000_000);
  await tick();
  assert.match(w.deps.db.keeperStatus("0")?.detail ?? "", /Waiting: the offer is \$14\.00, below your \$15\.00 minimum/);
});

test("after selling, the Keeper pays the owner's chosen address, less the exit fee, as the owner's own withdrawal", async () => {
  const payout = keypair().address;
  const { tick } = await keptCard(15_300_000);
  w.card.keeper = { agent: "keeper", min_price: "15000000", expires_ms: FUTURE(), payout };
  const paid: string[] = [];
  w.deps.contract.keeperPayout = async (_k, tokenId, m) => { paid.push(tokenId); return cardKp.sign(m); };
  const logs: string[] = [];
  w.deps.log = (m) => logs.push(m);
  const [sold] = await tick();
  assert.equal(sold.action, "sold");
  assert.equal(w.card.record.status, "Released");
  w.deps.contract.checkCardMessage = async () => ({ moves_card: false, uses_durable_nonce: true }); // a payout moves USDC, not the card
  const [payoutDecision] = await tick();
  assert.deepEqual(logs.filter((l) => /keeper: token/.test(l)), []);
  assert.equal(payoutDecision.action, "paid");
  assert.deepEqual(paid, ["0"]);
  const op = w.deps.db.opsByActor("alice").find((o) => o.kind === "withdraw_proceeds")!;
  const detail = JSON.parse(op.detail);
  assert.equal(detail.destination, payout);
  assert.equal(detail.keeper, "keeper");
  assert.equal(BigInt(detail.net) + BigInt(detail.fee), w.balance);
  assert.match(w.deps.db.keeperStatus("0")?.detail ?? "", /Sent you/);
});

test("no payout without an address the owner chose", async () => {
  const { ops } = await keptCard(15_300_000);
  await assert.rejects(ops.prepareKeeperPayout("0", "keeper"), /no live payout permission/);
});

test("the Keeper can't prepare a sale without a live permission of its own", async () => {
  const { ops } = await keptCard(15_300_000);
  await assert.rejects(ops.prepareKeeperSellback("0", "someone-else"), /no live permission/);
  w.card.keeper = { agent: "keeper", min_price: "15000000", expires_ms: String(Date.now() - 1) };
  await assert.rejects(ops.prepareKeeperSellback("0", "keeper"), /no live permission/);
  w.card.keeper = { agent: "keeper", min_price: "16000000", expires_ms: FUTURE() };
  await assert.rejects(ops.prepareKeeperSellback("0", "keeper"), /below the owner's minimum/);
});

test("address formats", () => {
  const good: [string, string][] = [["eth", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"], ["base", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"], ["btc", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"], ["btc", "1BoatSLRHtKNngkdXEeobR76b53LETtpyT"], ["sol", TREASURY.toBase58()], ["near", "alice.near"], ["near", "9ed1b724cc85b4b7f30fd32bf8868aee0d6d177d4b3b0a259547565329cf631a"], ["doge", "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L"], ["unknownchain", "anything"]];
  const bad: [string, string][] = [["eth", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"], ["btc", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"], ["sol", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"], ["near", "Alice Near"], ["eth", "0x123"], ["unknownchain", "  "]];
  for (const [c, a] of good) assert.ok(looksLikeAddress(c, a), `${c} ${a}`);
  for (const [c, a] of bad) assert.ok(!looksLikeAddress(c, a), `${c} ${a}`);
});

test("refunded and failed payments never mint", async () => {
  for (const [script, state] of [[["PROCESSING", "REFUNDED"], "refunded"], [["PROCESSING", "FAILED"], "payment_failed"]] as const) {
    const x = world();
    x.checkout.nextScript = [...script];
    const { p, id } = await paidOrder(x);
    const o = await runUntilSettled(p, id);
    assert.equal(o.state, state);
    assert.equal(x.mints, 0);
  }
});

test("a SUCCESS for someone else's recipient is rejected", async () => {
  const { p, id } = await paidOrder(w);
  const real = w.checkout.status.bind(w.checkout);
  w.checkout.status = async (d) => {
    const s = await real(d);
    s.status = "SUCCESS";
    s.swapDetails = { amountOut: "25250000" };
    s.quoteResponse.quoteRequest!.recipient = "attacker";
    return s;
  };
  const o = await runUntilSettled(p, id);
  assert.equal(o.state, "payment_failed");
  assert.match(o.last_error ?? "", /settlement rejected: recipient/);
  assert.equal(w.mints, 0);
});

test("underpaid settlement is rejected", async () => {
  const { p, id } = await paidOrder(w);
  const real = w.checkout.status.bind(w.checkout);
  w.checkout.status = async (d) => {
    const s = await real(d);
    s.status = "SUCCESS";
    s.swapDetails = { amountOut: "25249999" };
    return s;
  };
  assert.equal((await runUntilSettled(p, id)).state, "payment_failed");
});

test("an API SUCCESS with no matching on-chain deposit never mints", async () => {
  w.settledDelta = 25_249_999n; // the chain says we received less than the API claims
  const { p, id } = await paidOrder(w);
  let o = await p.advance(id);
  for (let i = 0; i < 20 && o.state === "awaiting_payment"; i++) o = await p.advance(id);
  assert.equal(o.state, "needs_attention");
  assert.match(o.last_error ?? "", /not proven/);
  assert.equal(w.mints, 0);
});

test("an RPC failure while proving settlement is not treated as proof, and doesn't retry forever", async () => {
  w.deps.chain.tokenDeltaInTx = async () => { throw new Error("Invalid param: WrongSize"); };
  const { p, id } = await paidOrder(w);
  let o = await p.advance(id);
  for (let i = 0; i < 20 && o.state === "awaiting_payment"; i++) o = await p.advance(id);
  assert.equal(o.state, "needs_attention");
  assert.equal(w.mints, 0);
});

test("only 64-byte signatures are looked up on Solana", () => {
  assert.equal(isSolanaSignature("Aajq3B1ufHnoN5dTgu8jqqwLfSU227UDyPRDCWpjtv47"), false); // NEAR hash from a real Tidepool status
  assert.equal(isSolanaSignature("N4C8o2YCbiWUfKKDUfLWCqRfUh3Wk9SXPM9UVMCe33rfdUpnWLxzRmw6Pci8UvU6YqZZ33GmXysUUWFSHBFhEwP"), true);
  assert.equal(isSolanaSignature("not base58 0OIl"), false);
});

test("a settlement that isn't visible yet is retried, then accepted", async () => {
  w.settledDelta = null;
  const { p, id } = await paidOrder(w);
  let o = await runUntilSettled(p, id, 4);
  assert.equal(o.state, "awaiting_payment");
  w.settledDelta = 25_250_000n;
  o = await runUntilSettled(p, id);
  assert.equal(o.state, "complete");
  assert.ok(o.settle_tx);
});

test("one settlement transaction can't pay for two orders", async () => {
  const { p, id } = await paidOrder(w);
  await runUntilSettled(p, id);
  const real = w.checkout.status.bind(w.checkout);
  const { order } = await p.createOrder({ buyer: "alice", packType: "pokemon_25", originAsset: "mock:usdc", refundTo: "alice" });
  await w.checkout.submitDeposit("tx", order.id);
  w.checkout.status = async (d) => {
    const s = await real(d);
    if (s.status === "SUCCESS") s.swapDetails.destinationChainTxHashes = [{ hash: `mock-dest-${id}` }];
    return s;
  };
  const o = await runUntilSettled(p, order.id, 5);
  assert.equal(o.state, "awaiting_payment");
  assert.match(o.last_error ?? "", /already used by another order/);
  assert.equal(w.mints, 1);
});

test("a card delivered to the wrong address is not recorded", async () => {
  w.assetOwnerIs = "someone-else";
  const { p, id } = await paidOrder(w);
  const o = await runUntilSettled(p, id, 6);
  assert.equal(o.state, "purchased");
  assert.match(o.last_error ?? "", /owned by someone-else/);
  assert.equal(w.opened, 0);
});

test("opening twice is safe: record_open is skipped if already recorded", async () => {
  const { p, id } = await paidOrder(w);
  await runUntilSettled(p, id);
  w.deps.db.updateOrder(id, { state: "purchased" });
  await p.advance(id);
  assert.equal(w.opened, 1);
});

// ---------- card operations ----------

function openedCard() {
  w.card.record.status = "Opened";
  w.card.record.card_mint = MINT;
}

test("only the owner can prepare an operation", async () => {
  openedCard();
  await assert.rejects(new CardOps(w.deps).prepareWithdrawCard("0", "mallory", CARD), /not the owner/);
});

test("withdraw: verify the owner's signature, co-sign, broadcast, record release", async () => {
  openedCard();
  const ops = new CardOps(w.deps);
  const op = await ops.prepareWithdrawCard("0", "alice", GACHA.toBase58());
  const sig = cardKp.sign(Buffer.from(op.message_hex, "hex"));
  const done = await ops.finalize(op.id, Buffer.from(sig).toString("hex"));
  assert.equal(done.state, "sent");
  assert.equal(w.treasurySigns, 1);
  assert.equal(w.sent.length, 1);
  assert.deepEqual(w.releases, ["withdrawn"]);
});

test("someone given the NFT with no NEAR is sponsored when they act on it", async () => {
  openedCard();
  w.card.owner_id = "ben";
  await new CardOps(w.deps).prepareWithdrawCard("0", "ben", GACHA.toBase58());
  assert.deepEqual(w.sponsored, ["ben"]);
});

test("sponsorship covers the prepaid gas of a card signature at the live price", () => {
  const { min, topUp } = sponsorAmounts(100_000_000n); // testnet's price
  // Real rejections: 30 Tgas needed 0.0309 NEAR, so 50 Tgas needs about 0.051.
  const measuredFor50Tgas = 51_000_000_000_000_000_000_000n;
  assert.ok(min > measuredFor50Tgas);
  assert.ok(topUp > min);
  const nearTransfer = 30_919_628_919_299_500_000_001n; // the 30 Tgas NFT transfer that was rejected at 0.015 NEAR
  assert.ok(topUp > nearTransfer);
});

test("failover surfaces the real error, so stale-nonce recovery and messages work", async () => {
  class InvalidNonceError extends Error {}
  const nonce = new InvalidNonceError("Invalid nonce (ak: 69, tx: 69)");
  const busy = new Error('{"code": -429, "message": "Rate limits exceeded"}');
  const wrapped = Object.assign(new Error("Exceeded 4 providers to execute request"), { errors: [busy, nonce, nonce] });
  assert.equal(realRpcError(wrapped), nonce, "skips the busy provider");
  assert.equal(realRpcError(Object.assign(new Error("x"), { errors: [busy] })), busy, "falls back to the first error");
  const plain = new Error("plain");
  assert.equal(realRpcError(plain), plain);
  const p = withRealErrors({ value: 7, send: async () => { throw wrapped; }, ok: async () => "fine", sync: () => "sync" });
  await assert.rejects(p.send(), (e) => e === nonce);
  assert.equal(await p.ok(), "fine");
  assert.equal(p.sync(), "sync");
  assert.equal(p.value, 7);
});

test("a forged card signature gets no co-signature", async () => {
  openedCard();
  const ops = new CardOps(w.deps);
  const op = await ops.prepareWithdrawCard("0", "alice", GACHA.toBase58());
  await assert.rejects(ops.finalize(op.id, "ab".repeat(64)), /does not verify/);
  assert.equal(w.treasurySigns, 0);
});

test("the second lock: if the owner changed, the relayer refuses to co-sign a held signature", async () => {
  openedCard();
  const ops = new CardOps(w.deps);
  const op = await ops.prepareWithdrawCard("0", "alice", GACHA.toBase58());
  const sig = cardKp.sign(Buffer.from(op.message_hex, "hex"));
  w.card.owner_id = "bob"; // alice sold the NFT after signing
  await assert.rejects(ops.finalize(op.id, Buffer.from(sig).toString("hex")), /owner changed/);
  assert.equal(w.treasurySigns, 0);
  assert.equal(w.sent.length, 0);
});

test("an expired operation is refused", async () => {
  openedCard();
  const ops = new CardOps(w.deps);
  const op = await ops.prepareWithdrawCard("0", "alice", GACHA.toBase58());
  w.deps.db.updateOp(op.id, { expires_at: Date.now() - 1 });
  await assert.rejects(ops.finalize(op.id, Buffer.from(cardKp.sign(Buffer.from(op.message_hex, "hex"))).toString("hex")), /expired/);
  assert.equal(w.treasurySigns, 0);
});

test("a failed broadcast clears Exiting so the token isn't stuck", async () => {
  openedCard();
  const ops = new CardOps(w.deps);
  const op = await ops.prepareWithdrawCard("0", "alice", GACHA.toBase58());
  w.card.record.status = "Exiting"; // the owner's sign_for_card did this
  w.deps.chain.send = async () => { throw new Error("simulation failed"); };
  await assert.rejects(ops.finalize(op.id, Buffer.from(cardKp.sign(Buffer.from(op.message_hex, "hex"))).toString("hex")), /simulation failed/);
  assert.equal(w.exitsCleared, 1);
  assert.equal(w.card.record.status, "Opened");
});

test("nonce slots: one at a time per account, and released after finishing", async () => {
  openedCard();
  const ops = new CardOps(w.deps);
  const op = await ops.prepareWithdrawCard("0", "alice", GACHA.toBase58());
  await assert.rejects(ops.prepareWithdrawCard("0", "alice", GACHA.toBase58()), /busy/);
  await ops.finalize(op.id, Buffer.from(cardKp.sign(Buffer.from(op.message_hex, "hex"))).toString("hex"));
  w.card.record.status = "Opened";
  assert.ok(await ops.prepareWithdrawCard("0", "alice", GACHA.toBase58()));
});

test("proceeds withdrawal refuses when there is nothing to withdraw", async () => {
  w.balance = 0n;
  await assert.rejects(new CardOps(w.deps).prepareWithdrawProceeds("0", "alice", GACHA.toBase58()), /no proceeds/);
});

// ---------- reconciler ----------

async function completeOrder() {
  const { p, id } = await paidOrder(w);
  await runUntilSettled(p, id);
  return id;
}

test("reconciler: a card that left without a record is released", async () => {
  await completeOrder();
  w.assetOwnerIs = "elsewhere";
  const f = await reconcile(w.deps);
  assert.deepEqual(f.map((x) => x.action), ["released"]);
  assert.deepEqual(w.releases, ["reconciled"]);
});

test("reconciler: an abandoned exit is cleared once no operation is live", async () => {
  await completeOrder();
  w.card.record.status = "Exiting";
  const f = await reconcile(w.deps);
  assert.deepEqual(f.map((x) => x.action), ["exit_cleared"]);
  assert.equal(w.card.record.status, "Opened");
});

test("reconciler: leaves an exit alone while its operation is live", async () => {
  await completeOrder();
  const op = await new CardOps(w.deps).prepareWithdrawCard("0", "alice", GACHA.toBase58());
  w.card.record.status = "Exiting";
  assert.deepEqual(await reconcile(w.deps), []);
  assert.equal(w.card.record.status, "Exiting");
  w.deps.db.updateOp(op.id, { expires_at: Date.now() - 1 });
  const f = await reconcile(w.deps);
  assert.deepEqual(f.map((x) => x.action), ["op_expired", "exit_cleared"]);
});

test("reconciler: a broadcast that landed after a timeout is recorded", async () => {
  await completeOrder();
  const op = await new CardOps(w.deps).prepareWithdrawCard("0", "alice", GACHA.toBase58());
  w.deps.db.updateOp(op.id, { tx_sig: "abc" });
  w.assetOwnerIs = "dest";
  const f = await reconcile(w.deps);
  assert.equal(f[0].action, "op_landed");
  assert.deepEqual(w.releases, ["withdrawn"]);
});

test("reconciler: flags released-but-still-here instead of guessing", async () => {
  await completeOrder();
  w.card.record.status = "Released";
  assert.deepEqual((await reconcile(w.deps)).map((x) => x.action), ["drift"]);
});

// ---------- readable card addresses ----------
import { createCardIndex } from "../src/card-index.js";
import { cardCode, cardSlug, packSlug } from "@mintent/shared";

test("card slugs come from the on-chain title, and a sealed pack has none", () => {
  assert.equal(cardSlug("2025 #222 Jamming Tower PSA 10 J"), "2025-222-jamming-tower-psa-10-j");
  assert.equal(cardSlug("Sold back: 2024 #119 Monkey D. Luffy PSA 10"), "2024-119-monkey-d-luffy-psa-10");
  assert.equal(cardSlug("Withdrawn: Café Crème"), "cafe-creme");
  assert.equal(cardSlug("Mintent pack #7 (sealed)"), null);
  assert.equal(cardSlug(null), null);
  assert.equal(packSlug("$25 Graded Card Pack"), "25-graded-card-pack");
});

test("the card index resolves slugs, codes and old token ids, numbering repeated names in mint order", async () => {
  const titles = ["Abra PSA 10", "Mintent pack #1 (sealed)", "Sold back: Abra PSA 10", "Withdrawn: Abra PSA 10", ...Array.from({ length: 150 }, (_, i) => `Card ${i}`)];
  let calls = 0;
  const index = createCardIndex({ async tokenPage(from, limit) { calls++; return titles.slice(from, from + limit).map((title, i) => ({ tokenId: String(from + i), title })); } }, "c.testnet");
  assert.equal(await index.resolve("abra-psa-10"), "0");
  assert.equal(await index.resolve("abra-psa-10-2"), "2");
  assert.equal(await index.resolve("abra-psa-10-3"), "3");
  assert.equal(await index.resolve("card-149"), "153", "tokens past the first page are found");
  assert.equal(await index.resolve(cardCode("c.testnet", "1")), "1", "a sealed pack resolves by its code");
  assert.equal(await index.resolve("2"), "2", "an old link with a token id still works");
  assert.equal(await index.resolve("999"), null);
  assert.equal(await index.resolve("no-such-card"), null);
  const sealed = await index.links("1");
  assert.equal(sealed.slug, null);
  assert.equal(sealed.path, `/open/${cardCode("c.testnet", "1")}`, "a sealed pack's link doesn't give the card away");
  assert.equal((await index.links("2")).path, "/cards/abra-psa-10-2");
  assert.ok(calls <= 6, `the index isn't rebuilt on every miss (${calls} pages read)`);
  assert.notEqual(cardCode("c.testnet", "1"), cardCode("other.testnet", "1"), "codes differ between contracts");
  assert.match(cardCode("c.testnet", "1"), /^[1-9A-HJ-NP-Za-km-z]{8}$/);
});

test("a pack minted since the index was built resolves by its code without reading the token list again", async () => {
  const titles = ["A", "B"];
  let calls = 0;
  const index = createCardIndex({ async tokenPage(from, limit) { calls++; return titles.slice(from, from + limit).map((title, i) => ({ tokenId: String(from + i), title })); } }, "c.testnet");
  assert.equal(await index.resolve("a"), "0");
  const before = calls;
  assert.equal(await index.resolve(cardCode("c.testnet", "7")), "7");
  assert.equal(calls, before, "no token-list read for a brand-new pack's code");
});
