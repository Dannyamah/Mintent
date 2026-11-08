// Full Mintent flow from nothing, on NEAR testnet, Tidepool, Solana devnet and Collector Crypt's devnet.
// No real money: it creates its own accounts, contract and treasury. It needs test USDC from DEMO_FUNDER.
// State is saved so a rerun resumes. `--fresh` starts over.
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Account } from "near-api-js";
import { ata, CONFIGS, confirm, coreTransferIx, createTestnetAccount, deriveSolanaAddress, faucetAirdropIx, loadAccount, nonceAccountFor, nonceSeed, readCoreAsset, sleep, verifyEd25519 } from "@mintent/shared";
import { CardOps, createRuntime, OrderPipeline, reconcile } from "@mintent/relayer";
import { verifyPull } from "./verify-pull.js";

const STATE = new URL("../.demo-state.json", import.meta.url);
if (process.argv.includes("--fresh")) {
  for (const f of ["../.demo-state.json", "../.demo-relayer.sqlite", "../.demo-relayer.sqlite-shm", "../.demo-relayer.sqlite-wal"]) rmSync(new URL(f, import.meta.url), { force: true });
}
const state: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
const save = () => writeFileSync(STATE, JSON.stringify(state, null, 2));
const cfg = CONFIGS.testnet;
const TP = cfg.oneClickBase;
const TP_USDC = "usdc.tidepool-sandbox.testnet";
const TP_VERIFIER = "verifier.tidepool-sandbox.testnet";
const started = Date.now();
const results: [string, boolean, string][] = [];
const say = (m: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${m}`);
const check = (name: string, pass: boolean, detail = "") => {
  results.push([name, pass, detail]);
  console.log(`        ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

async function tp<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${TP}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) throw new Error(`Tidepool ${path} ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}

// ---------- bootstrap ----------
say("Bootstrapping throwaway accounts");
state.suffix ??= Date.now().toString(36);
for (const role of ["relayer", "contract", "alice", "bob"]) {
  state[role] ??= `mintent-${role.slice(0, 3)}-${state.suffix}.testnet`;
  await createTestnetAccount(state[role]);
  await sleep(500);
}
save();
const relayer = loadAccount("testnet", state.relayer);
const alice = loadAccount("testnet", state.alice);
const bob = loadAccount("testnet", state.bob);
const contractAcct = loadAccount("testnet", state.contract);

if (!state.deployed) {
  say(`Deploying the contract from contracts/res/mintent.wasm to ${state.contract}`);
  await contractAcct.deployContract(readFileSync(new URL("../../contracts/res/mintent.wasm", import.meta.url)));
  await contractAcct.callFunction({ contractId: state.contract, methodName: "new", args: { owner_id: state.relayer, relayer_id: state.relayer, mpc_contract_id: cfg.mpcContract } }).catch((e) => {
    if (!/already been initialized|already initialized/i.test(String(e))) throw e;
  });
  state.deployed = true;
  save();
}
const d = await createRuntime({ contractId: state.contract, relayer, dbPath: new URL("../.demo-relayer.sqlite", import.meta.url).pathname, config: cfg, log: (m) => say(`  relayer: ${m}`) });
const { chain, contract, db } = d;
const treasury = chain.treasury;
const conn = chain.conn;
say(`Treasury (MPC-controlled, path "treasury"): ${treasury.toBase58()}`);

// Tidepool's faucet became site-only on 8 Nov 2026, so test USDC comes from an account you already funded at
// https://app.usetidepool.tech/faucet. Set DEMO_FUNDER to that account (its key in ~/.near-credentials/testnet).
async function drip(accountId: string, amount: bigint) {
  const have = BigInt(await relayer.provider.callFunction({ contractId: TP_USDC, method: "ft_balance_of", args: { account_id: accountId } } as never).catch(() => "0") as unknown as string);
  if (have >= amount) return;
  const funderId = process.env.DEMO_FUNDER;
  if (!funderId) throw new Error(`${accountId} needs ${amount} test USDC. Claim some at https://app.usetidepool.tech/faucet and set DEMO_FUNDER=<that account>. See README, "Tier 2".`);
  const funder = loadAccount("testnet", funderId);
  await funder.callFunction({ contractId: TP_USDC, methodName: "storage_deposit", args: { account_id: accountId, registration_only: true }, deposit: 1_250_000_000_000_000_000_000n, gas: 30_000_000_000_000n });
  await funder.callFunction({ contractId: TP_USDC, methodName: "ft_transfer", args: { receiver_id: accountId, amount: (amount - have).toString() }, deposit: 1n, gas: 30_000_000_000_000n });
}

/** Pay a Tidepool quote from a NEAR wallet: credit the deposit address inside the verifier. */
async function payIntents(payer: Account, depositAddress: string, amount: string) {
  const tx = await payer.callFunctionRaw({ contractId: TP_USDC, methodName: "ft_transfer_call", args: { receiver_id: TP_VERIFIER, amount, msg: depositAddress }, deposit: 1n, gas: 100_000_000_000_000n });
  await tp("/v0/deposit/submit", { txHash: tx.transaction.hash, depositAddress }).catch(() => undefined);
}

async function solToTreasury() {
  const q = await tp<any>("/v0/quote", { dry: false, swapType: "EXACT_OUTPUT", slippageTolerance: 100, originAsset: `nep141:${TP_USDC}`, depositType: "INTENTS", destinationAsset: "nep141:sol.tp-omft.testnet", amount: "5000000", recipient: treasury.toBase58(), recipientType: "DESTINATION_CHAIN", refundTo: state.relayer, refundType: "INTENTS", deadline: new Date(Date.now() + 1800000).toISOString() });
  await payIntents(relayer, q.quote.depositAddress, q.quote.amountIn);
  for (let i = 0; i < 60; i++) {
    const s = await tp<any>(`/v0/status?depositAddress=${q.quote.depositAddress}`);
    if (s.status === "SUCCESS") return;
    if (s.status === "REFUNDED" || s.status === "FAILED") throw new Error(`SOL swap ${s.status}`);
    await sleep(3000);
  }
  throw new Error("SOL swap timed out");
}

if (BigInt(await conn.getBalance(treasury)) < 12_000_000n && !state.solDone) {
  say("Funding the treasury with devnet SOL through Tidepool (3 swaps of 0.005 SOL)");
  await drip(state.relayer, 2_000_000n);
  for (let i = 0; i < 3; i++) await solToTreasury();
  state.solDone = true;
  save();
}
say(`Treasury SOL: ${Number(await conn.getBalance(treasury)) / 1e9}`);

/** Treasury-signed transaction with a fresh blockhash, rebuilt if MPC signing outlasts it. */
async function treasurySend(instructions: TransactionInstruction[]): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: blockhash, instructions }).compileToV0Message());
    const sig = await contract.signForTreasury(tx.message.serialize());
    tx.addSignature(treasury, sig);
    if (!(await conn.isBlockhashValid(blockhash, { commitment: "processed" })).value) {
      if (attempt >= 4) throw new Error("MPC signing keeps outlasting the blockhash");
      continue;
    }
    return confirm(conn, await conn.sendRawTransaction(tx.serialize()));
  }
}

for (let i = 1; i <= cfg.nonceAccounts; i++) {
  const nonce = await nonceAccountFor(treasury, i);
  if (!(await conn.getAccountInfo(nonce))) {
    say(`Creating durable nonce account ${i}: ${nonce.toBase58()}`);
    const lamports = Number(await conn.getMinimumBalanceForRentExemption(80));
    await treasurySend([
      SystemProgram.createAccountWithSeed({ fromPubkey: treasury, newAccountPubkey: nonce, basePubkey: treasury, seed: nonceSeed(i), lamports, space: 80, programId: SystemProgram.programId }),
      SystemProgram.nonceInitialize({ noncePubkey: nonce, authorizedPubkey: treasury }),
    ]);
  }
  await relayer.callFunction({ contractId: state.contract, methodName: "add_nonce_account", args: { address: nonce.toBase58() }, gas: 30_000_000_000_000n });
}
await relayer.callFunction({ contractId: state.contract, methodName: "add_payment_mint", args: { address: cfg.ccPaymentMint }, gas: 30_000_000_000_000n });

const ccMint = new PublicKey(cfg.ccPaymentMint);
if ((await chain.tokenBalance(treasury.toBase58(), cfg.ccPaymentMint)) < 60_000_000n) {
  say("Claiming USDC-Dev for the treasury (the token Collector Crypt's devnet charges)");
  await treasurySend([await faucetAirdropIx(ccMint, treasury, 200_000_000n)]);
}
say(`Treasury USDC-Dev: ${Number(await chain.tokenBalance(treasury.toBase58(), cfg.ccPaymentMint)) / 1e6}`);

// ---------- buy ----------
const pipeline = new OrderPipeline(d);
const ops = new CardOps(d);

async function buyPack(label: string): Promise<{ tokenId: string; card: string; mint: string; memo: string }> {
  if (state[label]) return state[label];
  let orderId: string | undefined = state[`${label}Order`];
  if (!orderId) {
    say(`${label}: alice starts a checkout for a ${cfg.defaultPack} pack, paying from NEAR USDC through Tidepool`);
    const { order, quote } = await pipeline.createOrder({ buyer: state.alice, packType: cfg.defaultPack, originAsset: `nep141:${TP_USDC}`, refundTo: state.alice, depositType: "INTENTS", refundType: "INTENTS" });
    say(`${label}: quote: pay ${Number(quote.amountIn) / 1e6} test USDC so the treasury receives exactly ${Number(order.amount_out) / 1e6} on Solana (pack ${Number(order.price_units) / 1e6} + 1% fee)`);
    await drip(state.alice, BigInt(quote.amountIn));
    orderId = order.id;
    state[`${label}Order`] = orderId;
    save();
    await payIntents(alice, order.id, quote.amountIn);
  } else {
    say(`${label}: resuming order ${orderId}`);
    if (d.db.order(orderId)?.state === "needs_attention") d.db.updateOrder(orderId, { state: "awaiting_payment", attempts: 0 });
  }
  const order = { id: orderId };
  let o = await pipeline.advance(order.id);
  const t0 = Date.now();
  while (!["complete", "refunded", "payment_failed", "needs_attention"].includes(o.state)) {
    if (Date.now() - t0 > 15 * 60_000) throw new Error(`order stuck in ${o.state}: ${o.last_error}`);
    await sleep(3000);
    o = await pipeline.advance(order.id);
  }
  if (o.state !== "complete") throw new Error(`order ended as ${o.state}: ${o.last_error}`);
  say(`${label}: card delivered in ${((Date.now() - t0) / 1000).toFixed(0)} s: "${o.card_name}" (${o.rarity}, insured $${(o.insured_cents ?? 0) / 100}), token ${o.token_id}`);
  check(`${label}: checkout settled and verified`, o.checkout_status === "SUCCESS");
  const { owner } = await chain.assetOwner(o.card_mint!);
  check(`${label}: Solana says the card is owned by the token's address`, owner === o.card_address, owner);
  const near = await contract.getCard(o.token_id!);
  check(`${label}: NEAR says the token is Opened and owned by alice`, near?.record.status === "Opened" && near.owner_id === state.alice);
  state[label] = { tokenId: o.token_id, card: o.card_address, mint: o.card_mint, memo: o.memo };
  save();
  return state[label];
}

const A = await buyPack("packA");
const B = await buyPack("packB");

// ---------- attacks ----------
say(`ATTACK on token ${B.tokenId}: alice has the card transfer signed, then tries to sell the NFT to bob`);
const attacker = new PublicKey(await deriveSolanaAddress("testnet", state.alice, "attacker"));
const { collection } = await readCoreAsset(conn, new PublicKey(B.mint));
if (!state.attackDone) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const attackTx = new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: blockhash, instructions: [coreTransferIx(new PublicKey(B.mint), collection, treasury, new PublicKey(B.card), attacker)] }).compileToV0Message());
  const attackSig = await contract.signForCard(alice, B.tokenId, attackTx.message.serialize());
  check("attack: alice obtained a card signature while she owned the NFT", verifyEd25519(B.card, attackTx.message.serialize(), attackSig));
  const blocked = await contract.transfer(alice, state.bob, B.tokenId).then(() => "transferred", (e) => String(e));
  check("attack: the NFT sale is REFUSED while that signature could land", /token is locked/.test(blocked), (blocked.match(/token is locked[^"\\]*/) ?? [blocked.slice(0, 100)])[0]);
  const after = await contract.getCard(B.tokenId);
  check("attack: alice still owns the NFT and it shows Exiting, so nobody can buy it unaware", after?.owner_id === state.alice && after?.record.status === "Exiting" && after?.transferable === false);
  state.attackDone = true;
  save();
}

say("ATTACK: lingering rights that would survive a sale must be refused outright");
const refused = async (name: string, ix: any, why: RegExp) => {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message()).message.serialize();
  const r = await contract.checkCardMessage(Buffer.from(msg).toString("hex")).then((x) => JSON.stringify(x), (e) => String(e));
  check(`policy refuses: ${name}`, why.test(r), (r.match(why) ?? [r.slice(0, 80)])[0]);
};
const cardB = new PublicKey(B.card);
await refused("Core plugin (a TransferDelegate that outlives the owner)", { programId: new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"), keys: [{ pubkey: new PublicKey(B.mint), isSigner: false, isWritable: true }, { pubkey: cardB, isSigner: true, isWritable: false }], data: Buffer.from([2, 3, 0]) }, /only Core TransferV1 is allowed/);
await refused("SPL Approve on the proceeds account", { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), keys: [{ pubkey: await ata(cardB, ccMint), isSigner: false, isWritable: true }, { pubkey: attacker, isSigner: false, isWritable: false }, { pubkey: cardB, isSigner: true, isWritable: false }], data: Buffer.from([4, 1, 0, 0, 0, 0, 0, 0, 0]) }, /only SPL TransferChecked is allowed/);
await refused("a durable nonce the seller controls (never expires)", SystemProgram.nonceAdvance({ noncePubkey: attacker, authorizedPubkey: cardB }), /durable nonce account not allowed/);
await refused("a marketplace listing (survives the sale)", { programId: new PublicKey("CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr"), keys: [{ pubkey: cardB, isSigner: true, isWritable: true }], data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]) }, /program not allowed/);

say("Reconciler: the abandoned exit never landed, so the token returns to Opened (still time-locked)");
const findings = await reconcile(d);
check("reconciler restored the token after the abandoned exit", findings.some((f) => f.tokenId === B.tokenId && f.action === "exit_cleared") || (await contract.getCard(B.tokenId))?.record.status === "Opened", JSON.stringify(findings));

// ---------- the honest path ----------
if (!state.handover) {
  say(`HANDOVER: alice transfers token ${A.tokenId} to bob on NEAR. No Solana transaction happens.`);
  await contract.transfer(alice, state.bob, A.tokenId);
  state.handover = true;
  save();
}
const afterHandover = await contract.getCard(A.tokenId);
check("handover: NEAR says bob owns the token", afterHandover?.owner_id === state.bob);
if (!state.sold) check("handover: on Solana the card did not move", (await chain.assetOwner(A.mint)).owner === A.card);
const old = await contract.signForCard(alice, A.tokenId, Buffer.from(new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: (await conn.getLatestBlockhash("confirmed")).blockhash, instructions: [coreTransferIx(new PublicKey(A.mint), collection, treasury, new PublicKey(A.card), attacker)] }).compileToV0Message()).message.serialize())).then(() => "signed", (e) => String(e));
check("handover: the old owner's new signing request is rejected", /only the token owner/.test(old));

if (!state.sold) {
  say(`SELL-BACK: bob sells the card back through a Collector Crypt signed quote`);
  const op = await ops.prepareSellback(A.tokenId, state.bob);
  say(`  bob signs with his own NEAR key (sign_for_card)`);
  const sig = await contract.signForCard(bob, A.tokenId, Buffer.from(op.message_hex, "hex"));
  const t0 = Date.now();
  const done = await ops.finalize(op.id, Buffer.from(sig).toString("hex"));
  say(`  landed in ${((Date.now() - t0) / 1000).toFixed(0)} s after bob's signature: ${explorer(done.tx_sig!)}`);
  state.sellTx = done.tx_sig;
  state.sold = true;
  save();
}
const proceeds = await chain.tokenBalance(A.card, cfg.ccPaymentMint);
if (!state.withdrawn) check("sell-back: USDC is now held by the NFT's own address", proceeds > 0n, `${Number(proceeds) / 1e6} USDC-Dev`);
check("sell-back: the card went back to Collector Crypt", (await chain.assetOwner(A.mint)).owner !== A.card);
check("sell-back: NEAR records the release", (await contract.getCard(A.tokenId))?.record.status === "Released");

const bobWallet = await deriveSolanaAddress("testnet", state.bob, "solana-1");
if (!state.withdrawn) {
  say(`WITHDRAW: bob moves the proceeds to his own Solana address ${bobWallet}`);
  const op = await ops.prepareWithdrawProceeds(A.tokenId, state.bob, bobWallet);
  const sig = await contract.signForCard(bob, A.tokenId, Buffer.from(op.message_hex, "hex"));
  const done = await ops.finalize(op.id, Buffer.from(sig).toString("hex"));
  say(`  ${explorer(done.tx_sig!)}`);
  state.withdrawTx = done.tx_sig;
  state.withdrawn = true;
  save();
}
check("withdraw: bob's own address received the USDC", (await chain.tokenBalance(bobWallet, cfg.ccPaymentMint)) > 0n);

// ---------- withdraw the card itself: how an owner redeems the slab or lists it elsewhere ----------
const aliceWallet = await deriveSolanaAddress("testnet", state.alice, "solana-1");
if (!state.cardOut) {
  say(`WITHDRAW CARD: alice moves token ${B.tokenId}'s card to her own Solana address ${aliceWallet}`);
  const op = await ops.prepareWithdrawCard(B.tokenId, state.alice, aliceWallet);
  const sig = await contract.signForCard(alice, B.tokenId, Buffer.from(op.message_hex, "hex"));
  const done = await ops.finalize(op.id, Buffer.from(sig).toString("hex"));
  say(`  ${explorer(done.tx_sig!)}`);
  state.cardOutTx = done.tx_sig;
  state.cardOut = true;
  save();
}
check("withdraw card: Solana says alice's own address holds the card", (await chain.assetOwner(B.mint)).owner === aliceWallet);
check("withdraw card: NEAR records the release", (await contract.getCard(B.tokenId))?.record.status === "Released");

// ---------- independent verification ----------
say(`Independent check of token ${A.tokenId} and ${B.tokenId} from public data only`);
check(`verify:pull token ${A.tokenId}`, await verifyPull(state.contract, A.tokenId, "testnet", (l) => console.log(`      ${l}`)));
check(`verify:pull token ${B.tokenId}`, await verifyPull(state.contract, B.tokenId, "testnet", (l) => console.log(`      ${l}`)));

const failed = results.filter((r) => !r[1]);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${((Date.now() - started) / 60000).toFixed(1)} min. Contract: ${state.contract}`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f[0]));
  process.exit(1);
}
process.exit(0);
