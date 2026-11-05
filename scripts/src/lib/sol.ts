// Solana helpers for Mintent: MPC signing through the mintent contract, durable-nonce transactions,
// confirmation, and the instructions Mintent builds itself (Core transfer, ATA, SPL transfer).
// Uses @solana/web3.js 3.x (PublicKey has toBytes(), findProgramAddress is async, block heights are bigint).
import {
  Connection, PublicKey, SystemProgram, TransactionInstruction, TransactionMessage, VersionedTransaction,
  type AddressLookupTableAccount,
} from "@solana/web3.js";
import type { Account } from "near-api-js";

export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
export const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");
export const NONCE_SEED = "mintent-nonce-1";

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

export async function nonceAccountFor(treasury: PublicKey): Promise<PublicKey> {
  return PublicKey.createWithSeed(treasury, NONCE_SEED, SystemProgram.programId);
}

/**
 * Build a v0 transaction that uses the treasury's durable nonce (so slow MPC signing can't expire it),
 * collect every required MPC signature through the contract, then send and confirm.
 * `signers` must cover every required signer in the message (treasury is always the fee payer).
 */
export async function sendWithDurableNonce(opts: {
  conn: Connection;
  contractId: string;
  treasury: PublicKey;
  relayer: Account;
  instructions: TransactionInstruction[];
  cardSigners?: { address: PublicKey; owner: Account; tokenId: string }[];
  lookupTables?: AddressLookupTableAccount[];
}): Promise<{ sig: string; signingMs: number; perSignerMs: Record<string, number> }> {
  const { conn, contractId, treasury, relayer, instructions, cardSigners = [], lookupTables } = opts;
  const noncePk = await nonceAccountFor(treasury);
  const nonce = await conn.getNonce(noncePk);
  if (!nonce) throw new Error(`nonce account ${noncePk.toBase58()} missing`);
  const advance = SystemProgram.nonceAdvance({ noncePubkey: noncePk, authorizedPubkey: treasury });
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: treasury, recentBlockhash: nonce.nonce, instructions: [advance, ...instructions] }).compileToV0Message(lookupTables),
  );
  const msg = tx.message.serialize();
  if (msg.length > 1232) throw new Error(`message is ${msg.length} bytes (> 1232)`);
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
