// Spike S2 (blocker 3 + the ownership story), Solana devnet + NEAR testnet, no real money.
//   pull <A|B|C>     mint a sealed token to the dev account, buy a CC devnet pack into its card address, open, record
//   handover         token A: nft_transfer dev -> bob; the old owner's sign_for_card must fail
//   sellback         token A: bob sells the card back via a cc_buyback quote (proceeds land in the card's own address)
//   withdraw         token A: bob moves the USDC from the card address to his own Chain Signatures Solana address
//   apibuyback       token B: standard CC /api/buyback (CC-built, partially signed, ~36 s window) signed by the owner
//   list             token C: list on the CC devnet marketplace via the marketplace API, then read the listing back
// Usage: tsx src/spike-s2.ts <dev.testnet> <bob.testnet> <contract.testnet> <step> [arg]
import { Connection, PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { deriveSolanaAddress, loadAccount } from "./lib/mpc.js";
import {
  ata, contractSign, coreTransferIx, createAtaIdempotentIx, readCoreAsset, sendAndConfirm, sendWithDurableNonce,
  setComputeUnitLimitIx, signCcTxWithRetry, sleep, transferCheckedIx, confirm,
} from "./lib/sol.js";

const [devId, bobId, contractId, step, arg] = process.argv.slice(2);
if (!devId || !bobId || !contractId || !step) throw new Error("usage: spike-s2 <dev> <bob> <contract> <step> [arg]");
const GACHA = "https://dev-gacha.collectorcrypt.com";
const CC_API = "https://dev-api.collectorcrypt.com";
const USDC_DEV = new PublicKey("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr");
const CC_BUYBACK_PROGRAM = new PublicKey("CcBuyM7sDhedBGLZxivBvgZVdqzrQAG66KYHgnTTEpLF");
const CC_BUYBACK_POLICY = new PublicKey("6UjEiB4XzrFmxxfzchy95Vygaeo11uvstBYJTqDTbHjq");
const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const SYSTEM = new PublicKey("11111111111111111111111111111111");

const conn = new Connection("https://api.devnet.solana.com", "confirmed");
const dev = loadAccount("testnet", devId);
const bob = loadAccount("testnet", bobId);
const STATE_FILE = new URL("../.spike-s2.json", import.meta.url);
const state: Record<string, any> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
const treasury = new PublicKey(state.treasury ??= await deriveSolanaAddress("testnet", contractId, "treasury"));
const accountFor = (id: string) => (id === bobId ? bob : dev);
const log = (o: unknown) => console.log(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));

async function json<T>(url: string, body?: unknown): Promise<{ status: number; data: T }> {
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const text = await r.text();
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: r.status, data };
}

async function pull(label: string) {
  const orderId = `s2-${label}-${Date.now()}`;
  const tokenId = await dev.callFunction<string>({ contractId, methodName: "mint_pack", args: { order_id: orderId, receiver_id: devId, pack_type: "pokemon_25" }, gas: 100_000_000_000_000n });
  const card = await deriveSolanaAddress("testnet", contractId, `card/${tokenId}`);
  let memo = "";
  const buy = await signCcTxWithRetry({
    conn, contractId, role: { kind: "treasury", relayer: dev }, signer: treasury,
    rebuild: async () => {
      const { status, data } = await json<any>(`${GACHA}/api/generatePack`, { playerAddress: treasury.toBase58(), packType: "pokemon_25", altPlayerAddress: card });
      if (!data?.transaction) throw new Error(`generatePack ${status} ${JSON.stringify(data)}`);
      memo = data.memo;
      return VersionedTransaction.deserialize(Buffer.from(data.transaction, "base64"));
    },
  });
  let opened: any;
  for (let i = 0; i < 60 && !opened; i++) {
    const { data } = await json<any>(`${GACHA}/api/openPack`, { memo });
    if (data?.nft_address) opened = data;
    else await sleep(2000);
  }
  if (!opened) throw new Error(`pack ${memo} did not open`);
  const { owner } = await readCoreAsset(conn, new PublicKey(opened.nft_address));
  const meta = (await json<any>(`${CC_API}/cards/publicNft/${opened.nft_address}`)).data;
  await dev.callFunction({
    contractId, methodName: "record_open", gas: 100_000_000_000_000n,
    args: { token_id: tokenId, memo, card_mint: opened.nft_address, card_name: opened.nftWon?.content?.metadata?.name ?? "card", rarity: String(opened.rarity), roll: String(opened.roll ?? 0), insured_value_usd_cents: String(Math.round(Number(meta?.insuredValue ?? 0) * 100)), media: null },
  });
  state[label] = { tokenId, orderId, card, memo, cardMint: opened.nft_address, buyTx: buy.sig, buyAttempts: buy.attempts, buyMpcMs: buy.mpcMs, deliveryTx: opened.transactionSignature, insuredValue: meta?.insuredValue, nftStandard: meta?.nftStandard, cardOwnerIsTokenAddress: owner.toBase58() === card, owner: devId };
  log({ [label]: state[label] });
}

async function handover() {
  const A = state.A;
  await dev.callFunction({ contractId, methodName: "nft_transfer", args: { receiver_id: bobId, token_id: A.tokenId }, deposit: 1n, gas: 30_000_000_000_000n });
  const view = await dev.provider.callFunction<any>({ contractId, method: "get_card", args: { token_id: A.tokenId } } as never);
  A.owner = view.owner_id;
  // The previous owner tries to sign for the card. This must fail on-chain.
  let denied = "";
  try {
    await contractSign(contractId, { kind: "card", owner: dev, tokenId: A.tokenId }, new Uint8Array(64).fill(7));
    denied = "NOT DENIED (bug!)";
  } catch (e) {
    denied = (String(e).match(/only the token owner[^"\\]*/) ?? [String(e).slice(0, 200)])[0];
  }
  A.oldOwnerAttempt = denied;
  log({ newOwner: A.owner, oldOwnerAttempt: denied });
}

async function sellback() {
  const A = state.A;
  const card = new PublicKey(A.card);
  const asset = new PublicKey(A.cardMint);
  const { status, data } = await json<any>(`${GACHA}/api/buyback`, { playerAddress: A.card, nftAddress: A.cardMint, sellerProgram: "mintent" });
  if (!data?.quote) throw new Error(`quote ${status} ${JSON.stringify(data)}`);
  const q = data.quote;
  log({ quote: { price: q.price, expiresAt: q.expiresAt, standard: q.standard, destinationOwner: q.destinationOwner, paymentMint: q.paymentMint, lut: q.addressLookupTable } });
  const tokenProgram = new PublicKey(q.tokenProgram);
  const paymentMint = new PublicKey(q.paymentMint);
  const sellerToken = await ata(card, paymentMint, tokenProgram);
  const { collection } = await readCoreAsset(conn, asset);

  const ed25519 = new TransactionInstruction({ programId: new PublicKey(q.ed25519Instruction.programId), keys: [], data: Buffer.from(q.ed25519Instruction.data, "base64") });
  // authorize_and_pay takes the QUOTE memo ("<pack memo>:buyback"); the pack memo alone fails with Ed25519MessageMismatch (6017).
  const memo = Buffer.from(String(q.memo), "utf8");
  const ixData = Buffer.alloc(8 + 8 + 8 + 8 + 4 + memo.length);
  Buffer.from([196, 1, 233, 204, 98, 232, 22, 54]).copy(ixData, 0);
  ixData.writeBigUInt64LE(BigInt(q.price), 8);
  ixData.writeBigUInt64LE(BigInt(q.quoteId), 16);
  ixData.writeBigInt64LE(BigInt(q.expiresAt), 24);
  ixData.writeUInt32LE(memo.length, 32);
  memo.copy(ixData, 36);
  const authorizeAndPay = new TransactionInstruction({
    programId: new PublicKey(q.ccProgram ?? CC_BUYBACK_PROGRAM),
    keys: [
      { pubkey: CC_BUYBACK_POLICY, isSigner: false, isWritable: false },
      { pubkey: card, isSigner: true, isWritable: false },
      { pubkey: asset, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.destinationOwner), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.treasury), isSigner: false, isWritable: true },
      { pubkey: sellerToken, isSigner: false, isWritable: true },
      { pubkey: paymentMint, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.quoteMarker), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(q.rentVault), isSigner: false, isWritable: true },
      { pubkey: SYSTEM, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.memoProgram), isSigner: false, isWritable: false },
    ],
    data: ixData,
  });
  const lut = q.addressLookupTable ? (await conn.getAddressLookupTable(new PublicKey(q.addressLookupTable))).value : null;
  const r = await sendWithDurableNonce({
    conn, contractId, treasury, relayer: dev,
    instructions: [
      setComputeUnitLimitIx(q.computeUnitLimit ?? 250_000),
      ed25519,
      await createAtaIdempotentIx(treasury, card, paymentMint, tokenProgram),
      coreTransferIx(asset, collection, treasury, card, new PublicKey(q.destinationOwner)),
      authorizeAndPay,
    ],
    cardSigners: [{ address: card, owner: accountFor(A.owner), tokenId: A.tokenId }],
  });
  await dev.callFunction({ contractId, methodName: "record_release", args: { token_id: A.tokenId, reason: "bought_back" }, gas: 30_000_000_000_000n });
  const bal = await conn.getTokenAccountBalance(sellerToken);
  Object.assign(A, { sellbackTx: r.sig, sellbackSigningMs: r.signingMs, sellbackPerSignerMs: r.perSignerMs, proceeds: bal.value.uiAmountString, assetOwnerAfter: (await readCoreAsset(conn, asset)).owner.toBase58() });
  log({ sellbackTx: r.sig, signingMs: r.signingMs, perSignerMs: r.perSignerMs, proceedsInCardAddress: bal.value.uiAmountString, assetNowOwnedBy: A.assetOwnerAfter });
}

async function withdraw() {
  const A = state.A;
  const card = new PublicKey(A.card);
  const payout = new PublicKey(await deriveSolanaAddress("testnet", bobId, "solana-1")); // bob's own Chain Signatures Solana address
  const src = await ata(card, USDC_DEV);
  const amount = BigInt((await conn.getTokenAccountBalance(src)).value.amount);
  const r = await sendWithDurableNonce({
    conn, contractId, treasury, relayer: dev,
    instructions: [await createAtaIdempotentIx(treasury, payout, USDC_DEV), transferCheckedIx(src, USDC_DEV, await ata(payout, USDC_DEV), card, amount, 6)],
    cardSigners: [{ address: card, owner: accountFor(A.owner), tokenId: A.tokenId }],
  });
  const got = await conn.getTokenAccountBalance(await ata(payout, USDC_DEV));
  Object.assign(A, { withdrawTx: r.sig, payoutAddress: payout.toBase58(), payoutBalance: got.value.uiAmountString });
  log({ withdrawTx: r.sig, payoutAddress: payout.toBase58(), payoutBalance: got.value.uiAmountString, signingMs: r.signingMs });
}

async function apibuyback() {
  const B = state.B;
  const card = new PublicKey(B.card);
  let feePayer = "";
  const r = await signCcTxWithRetry({
    conn, contractId, role: { kind: "card", owner: accountFor(B.owner), tokenId: B.tokenId }, signer: card,
    rebuild: async () => {
      const { status, data } = await json<any>(`${GACHA}/api/buyback`, { playerAddress: B.card, nftAddress: B.cardMint });
      if (!data?.serializedTransaction) throw new Error(`buyback ${status} ${JSON.stringify(data)}`);
      const tx = VersionedTransaction.deserialize(Buffer.from(data.serializedTransaction, "base64"));
      feePayer = tx.message.staticAccountKeys[0].toBase58();
      B.apiRefundAmount = data.refundAmount;
      return tx;
    },
  });
  await dev.callFunction({ contractId, methodName: "record_release", args: { token_id: B.tokenId, reason: "bought_back" }, gas: 30_000_000_000_000n });
  const bal = await conn.getTokenAccountBalance(await ata(card, USDC_DEV)).catch(() => null);
  Object.assign(B, { apiBuybackTx: r.sig, attempts: r.attempts, mpcMs: r.mpcMs, feePayer, proceeds: bal?.value.uiAmountString });
  log({ apiBuybackTx: r.sig, attempts: r.attempts, mpcMs: r.mpcMs, feePayer, refundAmount: B.apiRefundAmount, proceedsInCardAddress: B.proceeds });
}

async function list() {
  const C = state.C;
  const card = new PublicKey(C.card);
  const price = Number(arg ?? 30);
  let info: Record<string, unknown> = {};
  const r = await signCcTxWithRetry({
    conn, contractId, role: { kind: "card", owner: accountFor(C.owner), tokenId: C.tokenId }, signer: card,
    rebuild: async () => {
      const { status, data } = await json<any>(`${CC_API}/marketplace/list`, { wallet: C.card, nftAddress: C.cardMint, price, tokenStandard: "CoreNft" });
      if (typeof data !== "string") throw new Error(`list ${status} ${JSON.stringify(data)}`);
      const tx = VersionedTransaction.deserialize(Buffer.from(data, "base64"));
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      info = { feePayer: keys[0], requiredSigners: keys.slice(0, tx.message.header.numRequiredSignatures), presigned: tx.signatures.map((s) => s.some((b) => b !== 0)), msgBytes: tx.message.serialize().length };
      return tx;
    },
    send: async (tx) => {
      const { status, data } = await json<any>(`${CC_API}/marketplace/broadcast`, { wallet: C.card, signedTransaction: Buffer.from(tx.serialize()).toString("base64") });
      if (!data?.signature) throw new Error(`broadcast ${status} ${JSON.stringify(data)}`);
      return confirm(conn, data.signature);
    },
  });
  await sleep(2000);
  const market = (await json<any>(`${CC_API}/cards/publicNft/${C.cardMint}/market`)).data;
  Object.assign(C, { listTx: r.sig, listInfo: info, listing: market?.listing ?? null });
  log({ listTx: r.sig, attempts: r.attempts, mpcMs: r.mpcMs, txShape: info, listing: market?.listing ?? null, status: market?.status });
}

// CC marketplace program (from the listing tx) and its on-chain Anchor IDL: cancel_core_listing.
const CC_MARKET = new PublicKey("CcmRKTuZCGJBWQwMHvDYApBRvSZNHqGJXkznqpDTSQUr");

async function cancel() {
  const C = state.C;
  const card = new PublicKey(C.card);
  const asset = new PublicKey(C.cardMint);
  const [listingPda] = await PublicKey.findProgramAddress([Buffer.from("listing"), asset.toBytes(), card.toBytes()], CC_MARKET);
  const [marketPda] = await PublicKey.findProgramAddress([Buffer.from("market")], CC_MARKET);
  const acc = await conn.getAccountInfo(listingPda);
  if (!acc) throw new Error(`no listing account at ${listingPda.toBase58()}`);
  // Listing: disc(8) seller(32) nft(32) collection(32) bump(1) price(8) collection_type(1) created(8) updated(8) rent_payer(32)
  const d = Buffer.from(acc.data);
  const listingCollection = new PublicKey(d.subarray(72, 104));
  const rentPayer = new PublicKey(d.subarray(130, 162));
  const ix = new TransactionInstruction({
    programId: CC_MARKET,
    keys: [
      { pubkey: card, isSigner: true, isWritable: true }, // seller
      { pubkey: treasury, isSigner: true, isWritable: true }, // rent_payer (unused by the program, required in the list)
      { pubkey: rentPayer, isSigner: false, isWritable: true }, // rent_receiver = listing.rent_payer
      { pubkey: listingPda, isSigner: false, isWritable: true },
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: listingCollection, isSigner: false, isWritable: true },
      { pubkey: marketPda, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"), isSigner: false, isWritable: false },
      { pubkey: SYSTEM, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([58, 30, 81, 251, 75, 37, 173, 211]),
  });
  const r = await sendWithDurableNonce({ conn, contractId, treasury, relayer: dev, instructions: [ix], cardSigners: [{ address: card, owner: accountFor(C.owner), tokenId: C.tokenId }] });
  await sleep(3000);
  const market = (await json<any>(`${CC_API}/cards/publicNft/${C.cardMint}/market`)).data;
  Object.assign(C, { cancelTx: r.sig, listingAfterCancel: market?.listing ?? null, listingAccountClosed: !(await conn.getAccountInfo(listingPda)) });
  log({ cancelTx: r.sig, signingMs: r.signingMs, listingAccountClosed: C.listingAccountClosed, apiListingAfter: market?.listing?.status ?? null, rentReceiver: rentPayer.toBase58() });
}

const steps: Record<string, () => Promise<void>> = { handover, sellback, withdraw, apibuyback, list, cancel, pull: () => pull(arg ?? "A") };
if (!steps[step]) throw new Error(`unknown step ${step}`);
await steps[step]();
save();
void sendAndConfirm;
