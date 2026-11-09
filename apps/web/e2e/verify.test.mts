// The signing check: real message shapes, built with the same helpers the relayer uses, must pass, and every tampered one must
// be refused. Offline. Run: pnpm --filter @mintent/web test
import assert from "node:assert/strict";
import { test } from "node:test";
import { PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, type AddressLookupTableAccount } from "@solana/web3.js";
import { ata, authorizeAndPayIx, coreTransferIx, createAtaIdempotentIx, setComputeUnitLimitIx, TOKEN_PROGRAM, transferCheckedIx } from "@mintent/shared";
import { afterExitFee, exitFee as sharedExitFee } from "@mintent/shared";
import { checkCashOutQuote, checkMessage, exitFee, MessageRefused, parseMessage, sellbackPrice, type MessageContext } from "../src/verifyMessage.ts";

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
const FEE = 250_000n;
const pay = async (to: PublicKey, amount: bigint, mint = usdc, authority = card) => [await createAtaIdempotentIx(treasury, to, mint), transferCheckedIx(await ata(authority, mint), mint, await ata(to, mint), authority, amount, 6)];
/** What the relayer builds: the owner's share, then the fee to the treasury. */
const send = async (to = dest, amount = AMOUNT - FEE, mint = usdc, authority = card, fee = FEE, feeTo = treasury) => [...(await pay(to, amount, mint, authority)), ...(await pay(feeTo, fee, mint, authority))];
const sendIntent = { kind: "sendUsdc", destination: dest.toBase58(), total: AMOUNT.toString() } as const;

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
  checkMessage(message(await send(treasury)), ctx, { ...sendIntent, destination: treasury.toBase58() }); // testnet cash-out deposit
});

test("sending USDC: another destination, amount or coin is refused", async () => {
  refused(() => checkMessage(message([]), ctx, sendIntent), /signers/); // nothing for the NFT to sign
  const toAttacker = await send(attacker);
  refused(() => checkMessage(message(toAttacker), ctx, sendIntent), /different address/);
  const more = await send(dest, AMOUNT - FEE + 1n);
  refused(() => checkMessage(message(more), ctx, sendIntent), /amount is different/);
  const otherCoin = await send(dest, AMOUNT - FEE, key());
  refused(() => checkMessage(message(otherCoin), ctx, sendIntent), /different coin/);
});

test("the classic swap: create the right account, then pay another one", async () => {
  const [createOk, , ...feeSteps] = await send();
  const [, payAttacker] = await send(attacker);
  refused(() => checkMessage(message([createOk, payAttacker, ...feeSteps]), ctx, sendIntent), /different address/);
});

test("the fee must be exactly Mintent's, and only go to the treasury", async () => {
  const higher = await send(dest, AMOUNT - FEE - 1n, usdc, card, FEE + 1n);
  refused(() => checkMessage(message(higher), ctx, sendIntent), /fee is different/);
  const stolen = await send(dest, AMOUNT - FEE, usdc, card, FEE, attacker);
  refused(() => checkMessage(message(stolen), ctx, sendIntent), /fee goes to a different address/);
  const noFee = await pay(dest, AMOUNT);
  refused(() => checkMessage(message(noFee), ctx, sendIntent), /signers|extra steps/);
  // 1% above the minimum.
  const big = 100_000_000n;
  checkMessage(message(await send(dest, big - 1_000_000n, usdc, card, 1_000_000n)), ctx, { ...sendIntent, total: big.toString() });
});

test("the app's fee rule is the relayer's", () => {
  for (const total of [1n, 250_000n, 15_300_000n, 25_000_000n, 99_999_999n, 100_000_000n, 100_000_001n, 10n ** 12n]) assert.equal(exitFee(total), sharedExitFee(total));
  assert.equal(afterExitFee(15_300_000n)?.net, 15_050_000n);
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

test("one-click payment encodes a standard ERC-20 transfer, and refuses bad input", async () => {
  const { erc20Transfer } = await import("../src/evm.ts");
  const data = erc20Transfer("0x5674A57440f8a32588e621dB7e39a387D98DDE3D", 25_568_980n);
  assert.equal(data, "0xa9059cbb0000000000000000000000005674a57440f8a32588e621db7e39a387d98dde3d" + (25_568_980).toString(16).padStart(64, "0"));
  assert.equal(data.length, 2 + 8 + 128);
  assert.throws(() => erc20Transfer("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", 1n), /not an Ethereum address/);
  assert.throws(() => erc20Transfer("0x5674A57440f8a32588e621dB7e39a387D98DDE3D", 0n), /positive/);
});
