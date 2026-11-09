// The signing check: real message shapes, built with the same helpers the relayer uses, must pass, and every tampered one must
// be refused. Offline. Run: pnpm --filter @mintent/web test
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, type AddressLookupTableAccount } from "@solana/web3.js";
import { ata, authorizeAndPayIx, coreTransferIx, createAtaIdempotentIx, setComputeUnitLimitIx, TOKEN_PROGRAM, transferCheckedIx } from "@mintent/shared";
import { checkCashOutQuote, checkMessage, MessageRefused, parseMessage, sellbackPrice, type MessageContext } from "../src/verifyMessage.ts";

const key = () => new PublicKey(crypto.getRandomValues(new Uint8Array(32)));
const treasury = key();
const card = key();
const nonce = key();
const usdc = key();
const asset = key();
const collection = key();
const dest = key();
const attacker = key();
const ccDestination = key();
const NONCE_VALUE = key().toBase58();
const CC_PROGRAM = "CcBuyM7sDhedBGLZxivBvgZVdqzrQAG66KYHgnTTEpLF";

const ctx: MessageContext = { card: card.toBase58(), treasury: treasury.toBase58(), nonceAccounts: [nonce.toBase58()], usdcMint: usdc.toBase58(), asset: asset.toBase58() };

const advance = (account = nonce) => SystemProgram.nonceAdvance({ noncePubkey: account, authorizedPubkey: treasury });

function message(instructions: TransactionInstruction[], opts: { payer?: PublicKey; lookups?: AddressLookupTableAccount[]; trailing?: boolean; noAdvance?: boolean } = {}): string {
  const m = new TransactionMessage({ payerKey: opts.payer ?? treasury, recentBlockhash: NONCE_VALUE, instructions: opts.noAdvance ? instructions : [advance(), ...instructions] }).compileToV0Message(opts.lookups);
  return Buffer.from(m.serialize()).toString("hex") + (opts.trailing ? "00" : "");
}

const refused = (fn: () => void, why: RegExp) => assert.throws(fn, (e: Error) => e instanceof MessageRefused && why.test(e.message) && /Nothing was signed/.test(e.message));

const AMOUNT = 15_300_000n;
const send = async (to = dest, amount = AMOUNT, mint = usdc, authority = card) => [await createAtaIdempotentIx(treasury, to, mint), transferCheckedIx(await ata(authority, mint), mint, await ata(to, mint), authority, amount, 6)];
const sendIntent = { kind: "sendUsdc", destination: dest.toBase58(), amount: AMOUNT.toString() } as const;

const quote = { price: AMOUNT.toString(), quoteId: "61414", expiresAt: 1794235565, memo: "cc-x:buyback", ccProgram: CC_PROGRAM, destinationOwner: ccDestination.toBase58(), treasury: key().toBase58(), quoteMarker: key().toBase58(), rentVault: key().toBase58(), paymentMint: usdc.toBase58(), tokenProgram: TOKEN_PROGRAM.toBase58(), memoProgram: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" };
const ed25519 = () => new TransactionInstruction({ programId: new PublicKey("Ed25519SigVerify111111111111111111111111111"), keys: [], data: Buffer.alloc(144) });
const sellback = async (o: { to?: PublicKey; payDest?: string; seller?: PublicKey; moved?: PublicKey; proceedsOwner?: PublicKey; price?: string; extra?: TransactionInstruction[]; program?: string } = {}) => {
  const q = { ...quote, price: o.price ?? quote.price, destinationOwner: o.payDest ?? quote.destinationOwner, ccProgram: o.program ?? CC_PROGRAM };
  const owner = o.proceedsOwner ?? card;
  return [setComputeUnitLimitIx(250_000), ed25519(), await createAtaIdempotentIx(treasury, owner, usdc), coreTransferIx(o.moved ?? asset, collection, treasury, card, o.to ?? ccDestination), authorizeAndPayIx(q as never, o.seller ?? card, o.moved ?? asset, await ata(owner, usdc)), ...(o.extra ?? [])];
};
const sellIntent = { kind: "sellback", price: AMOUNT.toString() } as const;

test("an honest withdrawal of the card passes", () => {
  checkMessage(message([coreTransferIx(asset, collection, treasury, card, dest)]), ctx, { kind: "withdrawCard", destination: dest.toBase58() });
});

test("withdrawing the card: another destination or another card is refused", () => {
  const intent = { kind: "withdrawCard", destination: dest.toBase58() } as const;
  refused(() => checkMessage(message([coreTransferIx(asset, collection, treasury, card, attacker)]), ctx, intent), /different address/);
  refused(() => checkMessage(message([coreTransferIx(key(), collection, treasury, card, dest)]), ctx, intent), /different card/);
});

test("an honest USDC transfer passes, for a withdrawal and a cash-out deposit", async () => {
  checkMessage(message(await send()), ctx, sendIntent);
  checkMessage(message(await send(treasury)), ctx, { ...sendIntent, destination: treasury.toBase58() });
});

test("sending USDC: another destination, amount or coin is refused", async () => {
  refused(() => checkMessage(message([]), ctx, sendIntent), /signers/); // nothing for the NFT to sign
  const toAttacker = await send(attacker);
  refused(() => checkMessage(message(toAttacker), ctx, sendIntent), /different address/);
  const more = await send(dest, AMOUNT + 1n);
  refused(() => checkMessage(message(more), ctx, sendIntent), /amount is different/);
  const otherCoin = await send(dest, AMOUNT, key());
  refused(() => checkMessage(message(otherCoin), ctx, sendIntent), /different coin/);
});

test("the classic swap: create the right account, then pay another one", async () => {
  const [createOk] = await send();
  const [, payAttacker] = await send(attacker);
  refused(() => checkMessage(message([createOk, payAttacker]), ctx, sendIntent), /different address/);
});

test("a card transfer can't hide in a USDC transfer, or the reverse", async () => {
  const usdcSteps = await send();
  const move = coreTransferIx(asset, collection, treasury, card, attacker);
  refused(() => checkMessage(message([...usdcSteps, move]), ctx, sendIntent), /extra steps/);
  refused(() => checkMessage(message([move, ...usdcSteps]), ctx, sendIntent), /extra steps/);
  refused(() => checkMessage(message([coreTransferIx(asset, collection, treasury, card, dest), ...usdcSteps]), ctx, { kind: "withdrawCard", destination: dest.toBase58() }), /extra steps/);
  // A USDC-shaped message when the owner asked to move the card.
  refused(() => checkMessage(message([move]), ctx, sendIntent), /extra steps/);
});

test("an honest sell-back passes, and its price can be read for display", async () => {
  const hex = message(await sellback());
  checkMessage(hex, ctx, sellIntent);
  assert.equal(sellbackPrice(hex), AMOUNT.toString());
});

test("a sell-back whose money or card goes elsewhere is refused", async () => {
  const proceeds = await sellback({ proceedsOwner: attacker });
  refused(() => checkMessage(message(proceeds), ctx, sellIntent), /different address/);
  const split = await sellback({ to: attacker });
  refused(() => checkMessage(message(split), ctx, sellIntent), /different destinations/);
  const otherCard = await sellback({ moved: key() });
  refused(() => checkMessage(message(otherCard), ctx, sellIntent), /different card/);
  const seller = await sellback({ seller: key() });
  refused(() => checkMessage(message(seller), ctx, sellIntent), /signers/);
  const lower = await sellback({ price: "1" });
  refused(() => checkMessage(message(lower), ctx, sellIntent), /price is different/);
  const fake = await sellback({ program: key().toBase58() });
  refused(() => checkMessage(message(fake), ctx, sellIntent), /Collector Crypt's program/);
  const extra = await sellback({ extra: await send(attacker) });
  refused(() => checkMessage(message(extra), ctx, sellIntent), /extra steps/);
});

test("the fee payer, signers and nonce must be Mintent's", async () => {
  const s = await send();
  const asPayer = (p: PublicKey) => message(s, { payer: p });
  refused(() => checkMessage(asPayer(attacker), ctx, sendIntent), /pays its fees/);
  refused(() => checkMessage(message(s, { noAdvance: true }), ctx, sendIntent), /nonce step/);
  refused(() => checkMessage(message([advance(key()), ...s], { noAdvance: true }), ctx, sendIntent), /nonce account/);
  // A second instruction signed by someone else adds a signer the owner never agreed to.
  const stranger = new TransactionInstruction({ programId: new PublicKey("ComputeBudget111111111111111111111111111111"), keys: [{ pubkey: attacker, isSigner: true, isWritable: false }], data: Buffer.from([2, 0, 0, 0, 0]) });
  refused(() => checkMessage(message([stranger, ...s]), ctx, sendIntent), /signers/);
});

test("anything the parser doesn't fully understand is refused", async () => {
  const s = await send();
  refused(() => checkMessage(message(s, { trailing: true }), ctx, sendIntent), /after the message/);
  refused(() => checkMessage("zz", ctx, sendIntent), /unreadable/);
  refused(() => checkMessage(message(s).slice(0, 40), ctx, sendIntent), /ends early/);
  refused(() => checkMessage(`81${message(s).slice(2)}`, ctx, sendIntent), /version/);

  const table = { key: key(), state: { addresses: [dest, await ata(dest, usdc)], deactivationSlot: 2n ** 64n - 1n, lastExtendedSlot: 0, lastExtendedSlotStartIndex: 0 }, isActive: () => true } as unknown as AddressLookupTableAccount;
  refused(() => checkMessage(message(s, { lookups: [table] }), ctx, sendIntent), /unknown account|lookup tables/);
  assert.equal(sellbackPrice("zz"), null);
  assert.equal(parseMessage(message(s)).signers, 2);
});

const goodQuote = () => ({ quote: { depositAddress: "dep" }, quoteRequest: { recipient: "me", destinationAsset: "asset", originAsset: "usdc", amount: "100", swapType: "EXACT_INPUT", recipientType: "DESTINATION_CHAIN", refundTo: "nft" } });
const expected = { depositAddress: "dep", recipient: "me", destinationAsset: "asset", originAsset: "usdc", amountIn: "100", refundTo: "nft" };

test("a cash-out quote must name what the owner chose", () => {
  checkCashOutQuote(goodQuote(), expected);
  refused(() => checkCashOutQuote(null, expected), /no quote/);
  for (const [field, value, why] of [["recipient", "attacker", /different address/], ["destinationAsset", "other", /different coin/], ["originAsset", "other", /different coin/], ["amount", "1", /different amount/], ["swapType", "EXACT_OUTPUT", /different amount/], ["recipientType", "INTENTS", /somewhere else/], ["refundTo", "attacker", /Refunds|refunds/]] as const) {
    const q = goodQuote();
    (q.quoteRequest as Record<string, string>)[field] = value;
    refused(() => checkCashOutQuote(q, expected), why);
  }
  const q = goodQuote();
  q.quote.depositAddress = "other";
  refused(() => checkCashOutQuote(q, expected), /deposit address/);
});
