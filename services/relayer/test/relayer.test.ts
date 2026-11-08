import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign, createPublicKey } from "node:crypto";
import { beforeEach, test } from "node:test";
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { MockBackend } from "@mintent/checkout";
import { COMPUTE_BUDGET, MEMO_PROGRAM, MPL_CORE, TOKEN_PROGRAM, transferCheckedIx, type CardView } from "@mintent/shared";
import { CardOps, Db, isSolanaSignature, OrderPipeline, reconcile, type Chain, type ContractApi, type Deps } from "../src/index.ts";

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
    deps: null as never,
  };
  const contract: ContractApi = {
    getCard: async () => w.card,
    getOrderToken: async (id) => w.minted.get(id) ?? null,
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
    tokenDeltaInTx: async () => w.settledDelta,
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
      openPack: async () => ({ nftAddress: MINT, rarity: "Rare", roll: 7, cardName: "Card", deliveryTx: "delivery" }),
      buybackQuote: async () => { throw new Error("not used"); },
      card: async () => ({ insuredValue: "21.69", frontImage: "img" }),
      verifyUrl: (m: string) => m,
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
