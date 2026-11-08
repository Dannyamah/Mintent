// Solana helpers for Mintent: MPC signing through the mintent contract, durable-nonce transactions,
// confirmation, and the instructions Mintent builds itself (Core transfer, ATA, SPL transfer).
// Uses @solana/web3.js 3.x (PublicKey has toBytes(), findProgramAddress is async, block heights are bigint).
import {
  Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import type { Account } from "near-api-js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const FAUCET_PROGRAM = new PublicKey("4sN8PnN2ki2W4TFXAfzR645FWs8nimmsYeNtxM8RBK6A"); // spl-token-faucet.com
export const CC_BUYBACK_POLICY = new PublicKey("6UjEiB4XzrFmxxfzchy95Vygaeo11uvstBYJTqDTbHjq");
export const SYSVAR_INSTRUCTIONS = new PublicKey("Sysvar1nstructions1111111111111111111111111");

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function ata(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM): Promise<PublicKey> {
  return (await PublicKey.findProgramAddress([owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ATA_PROGRAM))[0];
}

/** ATA program CreateIdempotent (instruction 1). */
export async function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM): Promise<TransactionInstruction> {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: await ata(owner, mint, tokenProgram), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** SPL Token TransferChecked (instruction 12). */
export function transferCheckedIx(source: PublicKey, mint: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint, decimals: number, tokenProgram = TOKEN_PROGRAM): TransactionInstruction {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeUInt8(decimals, 9);
  return new TransactionInstruction({
    programId: tokenProgram,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

export function setComputeUnitLimitIx(units: number): TransactionInstruction {
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(units, 1);
  return new TransactionInstruction({ programId: COMPUTE_BUDGET, keys: [], data });
}

/** mpl-core AssetV1 layout: key(1) | owner(32) | update_authority tag(1) [+ pubkey(32)] ... */
export async function readCoreAsset(conn: Connection, asset: PublicKey): Promise<{ owner: PublicKey; collection: PublicKey | null }> {
  const info = await conn.getAccountInfo(asset);
  if (!info) throw new Error(`asset ${asset.toBase58()} not found`);
  if (!info.owner.equals(MPL_CORE)) throw new Error(`asset ${asset.toBase58()} is not an mpl-core asset (owner ${info.owner.toBase58()})`);
  const owner = new PublicKey(info.data.subarray(1, 33));
  const collection = info.data[33] === 2 ? new PublicKey(info.data.subarray(34, 66)) : null;
  return { owner, collection };
}

/** mpl-core TransferV1 (discriminator 14, compression_proof = None). Unused optional accounts are passed as the program id. */
export function coreTransferIx(asset: PublicKey, collection: PublicKey | null, payer: PublicKey, authority: PublicKey, newOwner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MPL_CORE,
    keys: [
      { pubkey: asset, isSigner: false, isWritable: true },
      { pubkey: collection ?? MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
      { pubkey: newOwner, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      { pubkey: MPL_CORE, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([14, 0]),
  });
}

/** cc_buyback authorize_and_pay. The memo must be the quote's memo, not the pack's (else Ed25519MessageMismatch). */
export function authorizeAndPayIx(q: { price: string; quoteId: string; expiresAt: number; memo: string; ccProgram: string; destinationOwner: string; treasury: string; paymentMint: string; quoteMarker: string; rentVault: string; tokenProgram: string; memoProgram: string }, seller: PublicKey, asset: PublicKey, sellerToken: PublicKey): TransactionInstruction {
  const memo = Buffer.from(q.memo, "utf8");
  const data = Buffer.alloc(36 + memo.length);
  Buffer.from([196, 1, 233, 204, 98, 232, 22, 54]).copy(data, 0);
  data.writeBigUInt64LE(BigInt(q.price), 8);
  data.writeBigUInt64LE(BigInt(q.quoteId), 16);
  data.writeBigInt64LE(BigInt(q.expiresAt), 24);
  data.writeUInt32LE(memo.length, 32);
  memo.copy(data, 36);
  return new TransactionInstruction({
    programId: new PublicKey(q.ccProgram),
    keys: [
      { pubkey: CC_BUYBACK_POLICY, isSigner: false, isWritable: false },
      { pubkey: seller, isSigner: true, isWritable: false },
      { pubkey: asset, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.destinationOwner), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.treasury), isSigner: false, isWritable: true },
      { pubkey: sellerToken, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(q.paymentMint), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.quoteMarker), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(q.rentVault), isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.tokenProgram), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(q.memoProgram), isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** spl-token-faucet.com airdrop (devnet only). Mint bump 255 is for USDC-Dev. */
export async function faucetAirdropIx(mint: PublicKey, receiver: PublicKey, amount: bigint): Promise<TransactionInstruction> {
  const data = Buffer.alloc(17);
  Buffer.from([0x71, 0xad, 0x24, 0xee, 0x26, 0x98, 0x16, 0x75]).copy(data, 0);
  data.writeUInt8(255, 8);
  data.writeBigUInt64LE(amount, 9);
  return new TransactionInstruction({
    programId: FAUCET_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: await ata(receiver, mint), isSigner: false, isWritable: true },
      { pubkey: receiver, isSigner: true, isWritable: false },
      { pubkey: receiver, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("SysvarRent111111111111111111111111111111111"), isSigner: false, isWritable: false },
    ],
    data,
  });
}

export type SignerRole = { kind: "treasury"; relayer: Account } | { kind: "card"; owner: Account; tokenId: string };

/** Ask the mintent contract for an MPC signature over `msg`. */
export async function contractSign(contractId: string, role: SignerRole, msg: Uint8Array): Promise<{ sig: Uint8Array; ms: number }> {
  const t = Date.now();
  const payload_hex = Buffer.from(msg).toString("hex");
  const [account, methodName, args] =
    role.kind === "treasury"
      ? [role.relayer, "sign_for_treasury", { payload_hex }]
      : [role.owner, "sign_for_card", { token_id: role.tokenId, payload_hex }];
  const res = (await account.callFunction({ contractId, methodName, args, deposit: 1n, gas: 100_000_000_000_000n })) as { signature?: number[] };
  if (!Array.isArray(res?.signature) || res.signature.length !== 64) throw new Error(`bad MPC response ${JSON.stringify(res)}`);
  return { sig: Uint8Array.from(res.signature), ms: Date.now() - t };
}

export async function confirm(conn: Connection, sig: string, timeoutS = 60): Promise<string> {
  for (let i = 0; i < timeoutS; i++) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await sleep(1000);
  }
  throw new Error(`tx ${sig} not confirmed in ${timeoutS} s`);
}

export async function sendAndConfirm(conn: Connection, tx: VersionedTransaction): Promise<string> {
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5n });
  return confirm(conn, sig);
}

/** Seeds are mintent-nonce-1, -2, ... */
export function nonceSeed(index: number): string {
  return `mintent-nonce-${index}`;
}

export async function nonceAccountFor(treasury: PublicKey, index = 1): Promise<PublicKey> {
  return PublicKey.createWithSeed(treasury, nonceSeed(index), SystemProgram.programId);
}

/** Build a v0 message that uses a durable nonce. The nonce account's authority (the treasury) must also sign. */
export async function buildNonceTx(opts: { conn: Connection; treasury: PublicKey; nonceAccount: PublicKey; instructions: TransactionInstruction[] }): Promise<VersionedTransaction> {
  const nonce = await opts.conn.getNonce(opts.nonceAccount);
  if (!nonce) throw new Error(`nonce account ${opts.nonceAccount.toBase58()} missing`);
  const advance = SystemProgram.nonceAdvance({ noncePubkey: opts.nonceAccount, authorizedPubkey: opts.treasury });
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: opts.treasury, recentBlockhash: nonce.nonce, instructions: [advance, ...opts.instructions] }).compileToV0Message());
  const size = tx.message.serialize().length;
  if (size > 1232) throw new Error(`message is ${size} bytes (> 1232)`);
  return tx;
}

/**
 * Build a v0 transaction with the treasury's durable nonce, collect every MPC signature through the
 * contract, then send and confirm.
 */
export async function sendWithDurableNonce(opts: {
  conn: Connection;
  contractId: string;
  treasury: PublicKey;
  relayer: Account;
  instructions: TransactionInstruction[];
  cardSigners?: { address: PublicKey; owner: Account; tokenId: string }[];
  nonceIndex?: number;
}): Promise<{ sig: string; signingMs: number; perSignerMs: Record<string, number> }> {
  const { conn, contractId, treasury, relayer, instructions, cardSigners = [], nonceIndex = 1 } = opts;
  const tx = await buildNonceTx({ conn, treasury, nonceAccount: await nonceAccountFor(treasury, nonceIndex), instructions });
  const msg = tx.message.serialize();
  const t0 = Date.now();
  const perSignerMs: Record<string, number> = {};
  for (const c of cardSigners) {
    const { sig, ms } = await contractSign(contractId, { kind: "card", owner: c.owner, tokenId: c.tokenId }, msg);
    tx.addSignature(c.address, sig);
    perSignerMs[`card/${c.tokenId}`] = ms;
  }
  const t = await contractSign(contractId, { kind: "treasury", relayer }, msg);
  tx.addSignature(treasury, t.sig);
  perSignerMs.treasury = t.ms;
  return { sig: await sendAndConfirm(conn, tx), signingMs: Date.now() - t0, perSignerMs };
}

/** Most a pack transaction may cost the treasury in priority fees. CC makes a player holding >= 0.01 SOL its fee payer. */
export const MAX_PACK_PRIORITY_LAMPORTS = 100_000n;

/**
 * Refuse to sign a CC-built pack transaction unless it does exactly what we expect: a compute budget with a capped
 * priority fee, a memo and one USDC TransferChecked by the treasury of at most `maxAmount`.
 * A compromised API can't drain the treasury.
 */
export function assertSafePackTx(tx: VersionedTransaction, treasury: PublicKey, mint: PublicKey, maxAmount: bigint): { amount: bigint; feePayer: string } {
  const m = tx.message;
  if ("addressTableLookups" in m && (m.addressTableLookups?.length ?? 0) > 0) throw new Error("pack tx uses lookup tables");
  const keys = m.staticAccountKeys;
  const t = treasury.toBase58();
  const signerCount = m.header.numRequiredSignatures;
  if (!keys.slice(0, signerCount).some((k) => k.toBase58() === t)) throw new Error("treasury is not a signer of the pack tx");
  let amount: bigint | null = null;
  let unitLimit = 200_000n * BigInt(m.compiledInstructions.length);
  let microLamportsPerUnit = 0n;
  for (const ix of m.compiledInstructions) {
    const program = keys[ix.programIdIndex].toBase58();
    const data = Buffer.from(ix.data);
    if (program === COMPUTE_BUDGET.toBase58()) {
      if (data[0] === 2) unitLimit = BigInt(data.readUInt32LE(1));
      else if (data[0] === 3) microLamportsPerUnit = data.readBigUInt64LE(1);
      else throw new Error(`unexpected compute budget instruction in pack tx: ${data[0]}`);
      continue;
    }
    if (program === MEMO_PROGRAM.toBase58()) continue;
    if (program !== TOKEN_PROGRAM.toBase58() || data[0] !== 12 || amount !== null) throw new Error(`unexpected instruction in pack tx: ${program} ${data.toString("hex").slice(0, 16)}`);
    const accts = ix.accountKeyIndexes.map((i) => keys[i].toBase58());
    if (accts[1] !== mint.toBase58()) throw new Error(`pack tx charges mint ${accts[1]}`);
    if (accts[3] !== t) throw new Error("pack tx transfer authority is not the treasury");
    amount = data.readBigUInt64LE(1);
  }
  if (amount === null) throw new Error("pack tx has no payment");
  if (amount > maxAmount) throw new Error(`pack tx charges ${amount}, more than ${maxAmount}`);
  const priorityLamports = (unitLimit * microLamportsPerUnit) / 1_000_000n;
  if (keys[0].toBase58() === t && priorityLamports > MAX_PACK_PRIORITY_LAMPORTS) throw new Error(`pack tx priority fee ${priorityLamports} lamports is above the cap`);
  return { amount, feePayer: keys[0].toBase58() };
}

/**
 * Sign a CC-built partially-signed transaction (one MPC signature for `signer`) and send it.
 * CC transactions carry their own blockhash, so on expiry we ask `rebuild` for a fresh one (up to `tries`).
 */
export async function signCcTxWithRetry(opts: {
  conn: Connection;
  contractId: string;
  role: SignerRole;
  signer: PublicKey;
  rebuild: () => Promise<VersionedTransaction>;
  send?: (tx: VersionedTransaction) => Promise<string>;
  tries?: number;
}): Promise<{ sig: string; attempts: number; mpcMs: number[] }> {
  const { conn, contractId, role, signer, rebuild, tries = 3 } = opts;
  const send = opts.send ?? ((tx) => sendAndConfirm(conn, tx));
  const mpcMs: number[] = [];
  for (let i = 1; ; i++) {
    const tx = await rebuild();
    const { sig, ms } = await contractSign(contractId, role, tx.message.serialize());
    mpcMs.push(ms);
    tx.addSignature(signer, sig);
    try {
      return { sig: await send(tx), attempts: i, mpcMs };
    } catch (e) {
      const expired = /Blockhash not found|block height exceeded|BLOCKHASH_EXPIRED|expired/i.test(String(e));
      if (!expired || i >= tries) throw e;
      console.log(`  attempt ${i} expired after ${ms} ms of MPC signing; rebuilding`);
    }
  }
}
