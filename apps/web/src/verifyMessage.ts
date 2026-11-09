// Read the Solana message the relayer prepared, and refuse to sign unless it does exactly what the owner asked. The contract's
// policy limits what can ever be signed. This decides whether it matches this request. A compromised relayer could otherwise
// use a signature for one action to do another. It takes no input from the relayer except the message itself.
//
// Accounts created through the Associated Token program aren't derived here: that program fails the transaction if the account
// isn't the right one for its owner and mint, so checking the owner it names is enough.

const SYSTEM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const ED25519 = "Ed25519SigVerify111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const CC_BUYBACK = "CcBuyM7sDhedBGLZxivBvgZVdqzrQAG66KYHgnTTEpLF";
const CC_AUTHORIZE_AND_PAY = [196, 1, 233, 204, 98, 232, 22, 54];

/** The message doesn't match what the owner asked for. Its text is shown to them, so it's in plain words. */
export class MessageRefused extends Error {}

const refuse = (why: string): never => {
  throw new MessageRefused(`We stopped this before signing, because the transaction doesn't match what you asked for (${why}). Nothing was signed. Please try again, and contact us if this keeps happening.`);
};

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = BASE58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export interface ParsedInstruction {
  program: string;
  accounts: string[];
  data: Uint8Array;
}

export interface ParsedMessage {
  keys: string[];
  signers: number;
  instructions: ParsedInstruction[];
}

/** Strict: anything it doesn't fully understand is refused, including lookup tables, which could hide accounts. */
export function parseMessage(hex: string): ParsedMessage {
  if (!/^([0-9a-f]{2})+$/i.test(hex)) refuse("unreadable message");
  const b = Uint8Array.from(hex.match(/../g)!, (x) => parseInt(x, 16));
  let i = 0;
  const byte = () => {
    if (i >= b.length) refuse("message ends early");
    return b[i++];
  };
  const compact = () => {
    let value = 0;
    for (let shift = 0; shift < 21; shift += 7) {
      const x = byte();
      value |= (x & 0x7f) << shift;
      if (!(x & 0x80)) return value;
    }
    return refuse("bad length in message");
  };
  const take = (n: number) => {
    if (i + n > b.length) refuse("message ends early");
    i += n;
    return b.subarray(i - n, i);
  };

  let versioned = false;
  if (b[0] & 0x80) {
    if ((b[0] & 0x7f) !== 0) refuse("unknown message version");
    versioned = true;
    i = 1;
  }
  const signers = byte();
  byte();
  byte();
  const keys = Array.from({ length: compact() }, () => base58(take(32)));
  take(32); // the durable nonce, stored in the blockhash slot
  const key = (index: number) => keys[index] ?? refuse("instruction names an unknown account");
  const instructions = Array.from({ length: compact() }, () => {
    const program = key(byte());
    const accounts = Array.from({ length: compact() }, () => key(byte()));
    return { program, accounts, data: take(compact()).slice() };
  });
  if (versioned && compact() !== 0) refuse("message uses lookup tables");
  if (i !== b.length) refuse("unexpected data after the message");
  return { keys, signers, instructions };
}

export interface MessageContext {
  /** The NFT's Solana address, derived by NEAR's signing network. */
  card: string;
  treasury: string;
  /** Mintent's durable nonce accounts, from the contract. */
  nonceAccounts: string[];
  /** The USDC this network uses, pinned in the app. */
  usdcMint: string;
  /** The card this NFT holds, from the contract. */
  asset: string | null;
}

/** Mintent's exit fee, pinned in the app: 1%, at least $0.25. Must equal packages/shared/src/fees.ts (a test checks). */
export function exitFee(total: bigint): bigint {
  const percent = (total * 100n + 9_999n) / 10_000n;
  return percent > 250_000n ? percent : 250_000n;
}

export type MessageIntent =
  | { kind: "withdrawCard"; destination: string }
  /** `total` leaves the NFT: total minus the fee to `destination`, and the fee to the treasury. */
  | { kind: "sendUsdc"; destination: string; total: string }
  | { kind: "sellback"; price: string };

const u64 = (data: Uint8Array, at: number) => new DataView(data.buffer, data.byteOffset).getBigUint64(at, true);
const dataIs = (data: Uint8Array, expected: number[]) => data.length >= expected.length && expected.every((x, i) => data[i] === x);

/** Everything but the nonce step and fee settings, after checking those and who signs. */
function steps(m: ParsedMessage, ctx: MessageContext): ParsedInstruction[] {
  if (m.keys[0] !== ctx.treasury) refuse("someone else pays its fees");
  const signers = m.keys.slice(0, m.signers);
  if (signers.length !== 2 || !signers.includes(ctx.card)) refuse("unexpected signers");

  const [nonce, ...rest] = m.instructions;
  if (nonce?.program !== SYSTEM || !dataIs(nonce.data, [4, 0, 0, 0]) || nonce.data.length !== 4) refuse("it doesn't start with a nonce step");
  if (!ctx.nonceAccounts.includes(nonce.accounts[0]) || nonce.accounts[2] !== ctx.treasury) refuse("it uses a nonce account that isn't Mintent's");

  return rest.filter((ix) => {
    if (ix.program !== COMPUTE_BUDGET) return true;
    // Limits and fee settings only. They're paid by the treasury, and can't touch the owner's assets.
    if (ix.data[0] !== 2 && ix.data[0] !== 3) refuse("unexpected fee setting");
    return false;
  });
}

function checkCardTransfer(ix: ParsedInstruction, ctx: MessageContext, destination: string | null): string {
  if (ix.program !== CORE || ix.data.length !== 2 || !dataIs(ix.data, [14, 0])) refuse("unexpected step instead of a card transfer");
  if (!ctx.asset || ix.accounts[0] !== ctx.asset) refuse("it moves a different card");
  if (ix.accounts[3] !== ctx.card) refuse("the card isn't moved by this NFT's address");
  if (destination && ix.accounts[4] !== destination) refuse("the card goes to a different address");
  return ix.accounts[4] ?? refuse("the card has no destination");
}

/** Returns the account the new token account is for. */
function checkTokenAccount(ix: ParsedInstruction, ctx: MessageContext, owner: string, why = "the money goes to a different address"): string {
  if (ix.program !== ATA || ix.data.length !== 1 || ix.data[0] !== 1) refuse("unexpected step instead of creating a token account");
  if (ix.accounts[2] !== owner) refuse(why);
  if (ix.accounts[3] !== ctx.usdcMint) refuse("it uses a different coin");
  if (ix.accounts[5] !== TOKEN) refuse("it uses an unexpected token program");
  return ix.accounts[1];
}

export function checkMessage(hex: string, ctx: MessageContext, intent: MessageIntent): void {
  const s = steps(parseMessage(hex), ctx);

  if (intent.kind === "withdrawCard") {
    if (s.length !== 1) refuse("it has extra steps");
    checkCardTransfer(s[0], ctx, intent.destination);
    return;
  }

  if (intent.kind === "sendUsdc") {
    if (s.length !== 4) refuse("it has extra steps");
    const usdcTo = (create: ParsedInstruction, pay: ParsedInstruction, owner: string, why: string) => {
      const account = checkTokenAccount(create, ctx, owner, why);
      if (pay.program !== TOKEN || pay.data[0] !== 12 || pay.data.length !== 10) refuse("unexpected step instead of a USDC transfer");
      if (pay.accounts[1] !== ctx.usdcMint) refuse("it sends a different coin");
      if (pay.accounts[2] !== account) refuse(why);
      if (pay.accounts[3] !== ctx.card) refuse("the money isn't sent by this NFT's address");
      return u64(pay.data, 1);
    };
    const net = usdcTo(s[0], s[1], intent.destination, "the money goes to a different address");
    const fee = usdcTo(s[2], s[3], ctx.treasury, "the fee goes to a different address");
    const total = BigInt(intent.total);
    if (fee !== exitFee(total)) refuse("the fee is different");
    if (net + fee !== total) refuse("the amount is different");
    return;
  }

  // Collector Crypt's program rejects a different destination, price or quote (scripts/src/spike-sellback-binding.ts), so what's
  // left to check here is that the money comes back to this NFT and the transaction does nothing else.
  if (s.length !== 4) refuse("it has extra steps");
  if (s[0].program !== ED25519) refuse("it has no signed quote from Collector Crypt");
  const proceeds = checkTokenAccount(s[1], ctx, ctx.card);
  const destination = checkCardTransfer(s[2], ctx, null);
  const pay = s[3];
  if (pay.program !== CC_BUYBACK || !dataIs(pay.data, CC_AUTHORIZE_AND_PAY)) refuse("it isn't paid by Collector Crypt's program");
  if (pay.accounts[1] !== ctx.card || pay.accounts[2] !== ctx.asset) refuse("the payment is for a different card");
  if (pay.accounts[3] !== destination) refuse("the card and the payment name different destinations");
  if (pay.accounts[5] !== proceeds) refuse("the money goes to a different address");
  if (pay.accounts[6] !== ctx.usdcMint) refuse("it pays in a different coin");
  if (u64(pay.data, 8).toString() !== intent.price) refuse("the price is different");
}

/** The price in a sell-back message, so the app shows the number that will really be signed, not one the relayer reports. */
export function sellbackPrice(hex: string): string | null {
  try {
    const pay = parseMessage(hex).instructions.find((ix) => ix.program === CC_BUYBACK && dataIs(ix.data, CC_AUTHORIZE_AND_PAY));
    return pay ? u64(pay.data, 8).toString() : null;
  } catch {
    return null;
  }
}

export interface CashOutExpectation {
  depositAddress: string;
  recipient: string;
  destinationAsset: string;
  originAsset: string;
  amountIn: string;
  refundTo: string;
}

/**
 * The swap's deposit address decides where the money ends up, so the quote behind it must name what the owner chose. On mainnet
 * the caller also checks 1Click's signature, which is what stops the relayer inventing a quote.
 */
export function checkCashOutQuote(raw: unknown, expected: CashOutExpectation): void {
  const r = raw as { quote?: { depositAddress?: string }; quoteRequest?: Record<string, unknown> } | null;
  const q = r?.quoteRequest;
  if (!q || !r?.quote) return refuse("there's no quote to check");
  if (r.quote.depositAddress !== expected.depositAddress) refuse("the deposit address isn't the quote's");
  if (q.recipient !== expected.recipient) refuse("the swap pays a different address");
  if (q.destinationAsset !== expected.destinationAsset) refuse("the swap pays a different coin");
  if (q.originAsset !== expected.originAsset) refuse("the swap starts from a different coin");
  if (q.amount !== expected.amountIn || q.swapType !== "EXACT_INPUT") refuse("the swap is for a different amount");
  if (q.recipientType !== "DESTINATION_CHAIN") refuse("the swap pays out somewhere else");
  if (q.refundTo !== expected.refundTo) refuse("refunds go to a different address");
}
