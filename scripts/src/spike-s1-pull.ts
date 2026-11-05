// Spike S1 (full): a real Collector Crypt devnet pull into a Chain-Signatures card address, then move the card out.
// Every Solana signature for Mintent addresses comes from the NEAR MPC network via the mintent contract.
// State is saved to .spike-s1.json so steps can be resumed. Devnet/testnet only.
// Usage: tsx src/spike-s1-pull.ts <dev.testnet> <contract.testnet> [step...]
//   steps: usdc | mint | buy | open | inspect | transfer   (default: all, in order)
import {
  Connection, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction, TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { deriveSolanaAddress, loadAccount, verifyEd25519 } from "./lib/mpc.js";

const [dev, contractId, ...stepArgs] = process.argv.slice(2);
if (!dev || !contractId) throw new Error("usage: spike-s1-pull <dev.testnet> <contract.testnet> [steps]");
const STEPS = stepArgs.length ? stepArgs : ["usdc", "mint", "buy", "open", "inspect", "transfer"];
const STATE_FILE = new URL("../.spike-s1.json", import.meta.url);
const state: Record<string, any> = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : {};
const save = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

const GACHA = "https://dev-gacha.collectorcrypt.com";
const CC_API = "https://dev-api.collectorcrypt.com";
const sol = new Connection("https://api.devnet.solana.com", "confirmed");
const account = loadAccount("testnet", dev);

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const USDC_DEV = new PublicKey("Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr");
const FAUCET_PROGRAM = new PublicKey("4sN8PnN2ki2W4TFXAfzR645FWs8nimmsYeNtxM8RBK6A"); // spl-token-faucet.com (Anchor)

const ata = async (owner: PublicKey, mint: PublicKey): Promise<PublicKey> =>
  (await PublicKey.findProgramAddress([owner.toBytes(), TOKEN_PROGRAM.toBytes(), mint.toBytes()], ATA_PROGRAM))[0];

/** Ask the mintent contract for an MPC signature. method = sign_for_treasury | sign_for_card */
async function contractSign(method: "sign_for_treasury" | "sign_for_card", msg: Uint8Array, tokenId?: string): Promise<{ sig: Uint8Array; ms: number }> {
  const t = Date.now();
  const args: Record<string, string> = { payload_hex: Buffer.from(msg).toString("hex") };
  if (tokenId !== undefined) args.token_id = tokenId;
  const res = (await account.callFunction({ contractId, methodName: method, args, deposit: 1n, gas: 100_000_000_000_000n })) as { signature?: number[] };
  if (!Array.isArray(res?.signature) || res.signature.length !== 64) throw new Error(`bad MPC response ${JSON.stringify(res)}`);
  return { sig: Uint8Array.from(res.signature), ms: Date.now() - t };
}

async function sendSigned(tx: VersionedTransaction): Promise<string> {
  const sig = await sol.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 60; i++) {
    const st = (await sol.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`tx ${sig} not confirmed in 60 s`);
}

/** Build (fresh blockhash) -> MPC-sign as treasury -> send. Rebuilds and retries if the blockhash expires while signing. */
async function signAndSendAsTreasury(instructions: TransactionInstruction[], tries = 3): Promise<{ sig: string; mpcMs: number; windowS: number }> {
  for (let i = 1; ; i++) {
    const { blockhash, lastValidBlockHeight } = await sol.getLatestBlockhash("confirmed");
    const h0 = Number(await sol.getBlockHeight());
    const t0 = Date.now();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: blockhash, instructions }).compileToV0Message());
    const { sig, ms } = await contractSign("sign_for_treasury", tx.message.serialize());
    tx.addSignature(treasury, sig);
    const h1 = Number(await sol.getBlockHeight());
    const blocksLeft = Number(lastValidBlockHeight) - h1;
    const blocksPerSec = (h1 - h0) / ((Date.now() - t0) / 1000);
    console.log({ attempt: i, mpcMs: ms, blocksLeft, blocksPerSec: blocksPerSec.toFixed(2) });
    try {
      return { sig: await sendSigned(tx), mpcMs: ms, windowS: (Number(lastValidBlockHeight) - h0) / blocksPerSec };
    } catch (e) {
      if (i >= tries || !/Blockhash not found|block height exceeded/i.test(String(e))) throw e;
    }
  }
}

state.treasury ??= await deriveSolanaAddress("testnet", contractId, "treasury");
const treasury = new PublicKey(state.treasury);
console.log({ treasury: state.treasury, solLamports: await sol.getBalance(treasury) });

for (const step of STEPS) {
  console.log(`\n== ${step}`);
  if (step === "usdc") {
    // Anchor `airdrop(mint_bump: u8, amount: u64)`; mint_bump 255 read from a live faucet tx.
    const disc = createHash("sha256").update("global:airdrop").digest().subarray(0, 8);
    const data = Buffer.alloc(17);
    disc.copy(data, 0);
    data.writeUInt8(255, 8);
    data.writeBigUInt64LE(100_000_000n, 9); // 100 USDC-Dev
    const ix = new TransactionInstruction({
      programId: FAUCET_PROGRAM,
      keys: [
        { pubkey: USDC_DEV, isSigner: false, isWritable: true },
        { pubkey: await ata(treasury, USDC_DEV), isSigner: false, isWritable: true },
        { pubkey: treasury, isSigner: true, isWritable: false },
        { pubkey: treasury, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: ATA_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      ],
      data,
    });
    const { blockhash } = await sol.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
    const { sig, ms } = await contractSign("sign_for_treasury", tx.message.serialize());
    tx.addSignature(treasury, sig);
    state.usdcTx = await sendSigned(tx);
    console.log({ mpcMs: ms, usdcTx: state.usdcTx, usdcBalance: (await sol.getTokenAccountBalance(await ata(treasury, USDC_DEV))).value.uiAmountString });
  }

  if (step === "nonce") {
    // Durable nonce owned by the treasury, created with a seed so only the treasury signs.
    // Lets transactions that need several MPC signatures (~12 s each) avoid blockhash expiry.
    const NONCE_SEED = "mintent-nonce-1";
    const nonce = await PublicKey.createWithSeed(treasury, NONCE_SEED, SystemProgram.programId);
    if (!(await sol.getAccountInfo(nonce))) {
      const { NONCE_ACCOUNT_LENGTH } = await import("@solana/web3.js");
      const lamports = await sol.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
      const ixs = [
        SystemProgram.createAccountWithSeed({ fromPubkey: treasury, newAccountPubkey: nonce, basePubkey: treasury, seed: NONCE_SEED, lamports: Number(lamports), space: NONCE_ACCOUNT_LENGTH, programId: SystemProgram.programId }),
        SystemProgram.nonceInitialize({ noncePubkey: nonce, authorizedPubkey: treasury }),
      ];
      const r = await signAndSendAsTreasury(ixs);
      state.nonceTx = r.sig;
      console.log({ nonceTx: state.nonceTx, approxBlockhashWindowSeconds: r.windowS.toFixed(1) });
    }
    state.nonceAccount = nonce.toBase58();
    console.log({ nonceAccount: state.nonceAccount, nonceValue: await sol.getNonce(nonce) });
  }

  if (step === "mint") {
    state.orderId = `spike-${Date.now()}`;
    state.tokenId = await account.callFunction<string>({ contractId, methodName: "mint_pack", args: { order_id: state.orderId, receiver_id: dev, pack_type: "pokemon_25" }, gas: 100_000_000_000_000n });
    state.card = await deriveSolanaAddress("testnet", contractId, `card/${state.tokenId}`);
    console.log({ tokenId: state.tokenId, card: state.card });
  }

  if (step === "buy") {
    const t0 = Date.now();
    const r = await fetch(`${GACHA}/api/generatePack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ playerAddress: state.treasury, packType: "pokemon_25", altPlayerAddress: state.card }),
    });
    const gp = (await r.json()) as { memo?: string; transaction?: string };
    if (!gp.transaction) throw new Error(`generatePack ${r.status} ${JSON.stringify(gp)}`);
    const tx = VersionedTransaction.deserialize(Buffer.from(gp.transaction, "base64"));
    const msg = tx.message.serialize();
    const { sig, ms } = await contractSign("sign_for_treasury", msg);
    if (!verifyEd25519(state.treasury, msg, sig)) throw new Error("treasury signature invalid");
    tx.addSignature(treasury, sig);
    state.memo = gp.memo;
    state.buyTx = await sendSigned(tx);
    console.log({ memo: state.memo, mpcMs: ms, totalMs: Date.now() - t0, buyTx: state.buyTx });
  }

  if (step === "open") {
    for (let i = 0; i < 60; i++) {
      const r = await fetch(`${GACHA}/api/openPack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ memo: state.memo }) });
      const o = (await r.json()) as Record<string, any>;
      if (o.nft_address) {
        Object.assign(state, { cardMint: o.nft_address, rarity: o.rarity, roll: o.roll, cardName: o.nftWon?.content?.metadata?.name, deliveryTx: o.transactionSignature });
        console.log({ cardMint: state.cardMint, rarity: state.rarity, roll: state.roll, cardName: state.cardName, deliveryTx: state.deliveryTx });
        break;
      }
      if (o.code !== "WAITING_FOR_WEBHOOK") console.log("openPack:", r.status, JSON.stringify(o).slice(0, 300));
      await new Promise((res) => setTimeout(res, 2000));
    }
    if (!state.cardMint) throw new Error("pack did not open");
  }

  if (step === "inspect") {
    const info = await sol.getAccountInfo(new PublicKey(state.cardMint));
    state.cardProgram = info?.owner.toBase58();
    const meta = await fetch(`${CC_API}/cards/publicNft/${state.cardMint}`).then((r) => r.json()).catch(() => ({})) as Record<string, any>;
    state.nftStandard = meta.nftStandard ?? (state.cardProgram === MPL_CORE.toBase58() ? "core" : "unknown");
    state.insuredValue = meta.insuredValue;
    // Who holds it?
    if (state.cardProgram === MPL_CORE.toBase58()) {
      state.cardOwner = new PublicKey(info!.data.subarray(1, 33)).toBase58(); // mpl-core AssetV1: key(1) | owner(32) | update_authority...
    } else {
      const largest = await sol.getTokenLargestAccounts(new PublicKey(state.cardMint));
      const holderAcc = largest.value.find((a) => a.uiAmount === 1);
      const parsed = holderAcc ? await sol.getParsedAccountInfo(holderAcc.address) : null;
      state.cardOwner = (parsed?.value?.data as any)?.parsed?.info?.owner;
    }
    console.log({ cardProgram: state.cardProgram, nftStandard: state.nftStandard, insuredValue: state.insuredValue, cardOwner: state.cardOwner, ownerIsTokenAddress: state.cardOwner === state.card });
  }

  if (step === "record") {
    await account.callFunction({
      contractId, methodName: "record_open", gas: 100_000_000_000_000n,
      args: { token_id: state.tokenId, memo: state.memo, card_mint: state.cardMint, card_name: state.cardName ?? "card", rarity: String(state.rarity), roll: String(state.roll ?? 0), insured_value_usd_cents: String(Math.round(Number(state.insuredValue ?? 0) * 100)), media: null },
    });
    console.log("recorded on NEAR");
  }

  if (step === "transfer") {
    if (state.cardProgram !== MPL_CORE.toBase58()) throw new Error(`transfer for ${state.nftStandard} not implemented yet (Core only so far)`);
    // mpl-core TransferV1: data [14, compression_proof: Option<None>=0]
    // accounts: asset(w), collection(opt), payer(w,s), authority(s, opt), new_owner, system_program(opt), log_wrapper(opt)
    const info = await sol.getAccountInfo(new PublicKey(state.cardMint));
    const uaTag = info!.data[33]; // UpdateAuthority enum: 0 None, 1 Address, 2 Collection
    const collection = uaTag === 2 ? new PublicKey(info!.data.subarray(34, 66)) : MPL_CORE;
    const card = new PublicKey(state.card);
    const dest = treasury; // move it to the treasury (any address works for the test)
    const ix = new TransactionInstruction({
      programId: MPL_CORE,
      keys: [
        { pubkey: new PublicKey(state.cardMint), isSigner: false, isWritable: true },
        { pubkey: collection, isSigner: false, isWritable: false },
        { pubkey: treasury, isSigner: true, isWritable: true },
        { pubkey: card, isSigner: true, isWritable: false },
        { pubkey: dest, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE, isSigner: false, isWritable: false },
        { pubkey: MPL_CORE, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([14, 0]),
    });
    if (!state.nonceAccount) throw new Error("run the nonce step first");
    const noncePk = new PublicKey(state.nonceAccount);
    const nonceInfo = await sol.getNonce(noncePk);
    const tBh = Date.now();
    const advance = SystemProgram.nonceAdvance({ noncePubkey: noncePk, authorizedPubkey: treasury });
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: nonceInfo!.nonce, instructions: [advance, ix] }).compileToV0Message());
    const msg = tx.message.serialize();
    const owner = await contractSign("sign_for_card", msg, state.tokenId); // token owner (dev) asks for the card key
    const payer = await contractSign("sign_for_treasury", msg);
    tx.addSignature(card, owner.sig);
    tx.addSignature(treasury, payer.sig);
    console.log({ secondsSpentSigning: (Date.now() - tBh) / 1000, durableNonce: nonceInfo!.nonce });
    state.transferTx = await sendSigned(tx);
    const after = await sol.getAccountInfo(new PublicKey(state.cardMint));
    console.log({ transferTx: state.transferTx, ownerMpcMs: owner.ms, payerMpcMs: payer.ms, newOwner: new PublicKey(after!.data.subarray(1, 33)).toBase58() });
  }
  save();
}
save();
