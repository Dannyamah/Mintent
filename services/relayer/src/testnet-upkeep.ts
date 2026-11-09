// Testnet only: keep the public demo running without anyone topping it up by hand.
// - Every test purchase leaves Tidepool test USDC in the treasury on Solana devnet, unused, because Collector Crypt's devnet charges
//   a different token. Swap it back to the funder on NEAR when the funder runs low.
// - Every action costs the treasury a little devnet SOL, and devnet's faucet is closed. Buy more through Tidepool when it runs low.
// - Cap free test payments, so one visitor can't drain the funder for everyone else.
// None of this exists on mainnet, where buyers pay with their own money.
import { PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import type { Account } from "near-api-js";
import { ata, confirm, createAtaIdempotentIx, transferCheckedIx } from "@mintent/shared";
import type { Deps } from "./deps.js";
import type { createRuntime } from "./runtime.js";

export const TESTNET_USDC = "usdc.tidepool-sandbox.testnet";
export const TESTNET_VERIFIER = "verifier.tidepool-sandbox.testnet";
const TESTNET_SOL = "nep141:sol.tp-omft.testnet";

const FUNDER_LOW = 80_000_000n; // 80 test USDC: about 3 packs
const TREASURY_KEEP = 5_000_000n;
const TREASURY_MIN_TO_RECYCLE = 30_000_000n;
const SOL_LOW = 10_000_000; // lamports: 0.01 devnet SOL
const SOL_PER_SWAP = "5000000"; // Tidepool's per-swap cap, 0.005 SOL

export interface TestPayLimits {
  perVisitorPerDay: number;
  perAccountPerDay: number;
  allPerDay: number;
}

export function testPayLimits(env: Record<string, string | undefined> = process.env): TestPayLimits {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return { perVisitorPerDay: n(env.TEST_PAY_PER_VISITOR, 3), perAccountPerDay: n(env.TEST_PAY_PER_ACCOUNT, 3), allPerDay: n(env.TEST_PAY_PER_DAY, 40) };
}

/** Null if this test payment is allowed, otherwise a plain reason. */
export function testPayRefusal(counts: { visitor: number; account: number; all: number }, limits: TestPayLimits): string | null {
  if (counts.all >= limits.allPerDay) return "Today's free test packs have all been used. Please come back tomorrow.";
  if (counts.visitor >= limits.perVisitorPerDay || counts.account >= limits.perAccountPerDay) return `You've opened today's ${limits.perVisitorPerDay} free test packs. Please come back tomorrow.`;
  return null;
}

async function nearUsdc(funder: Account): Promise<bigint> {
  const raw = await funder.provider.callFunction({ contractId: TESTNET_USDC, method: "ft_balance_of", args: { account_id: funder.accountId } } as never);
  return BigInt(String(raw));
}

async function waitForSwap(d: Deps, depositAddress: string): Promise<string> {
  for (let i = 0; i < 60; i++) {
    const s = await d.checkout.status(depositAddress);
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) return s.status;
    await new Promise((r) => setTimeout(r, 4000));
  }
  return "TIMEOUT";
}

export function createTestnetUpkeep(d: Awaited<ReturnType<typeof createRuntime>>, funder: Account) {
  const { chain, config, contract, checkout, log } = d;
  const treasury = chain.treasury;
  let running = false;

  /** Treasury-signed Solana transaction, rebuilt if MPC signing outlasts the blockhash. */
  async function treasurySend(instructions: TransactionInstruction[]): Promise<string> {
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { blockhash } = await chain.conn.getLatestBlockhash("confirmed");
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: blockhash, instructions }).compileToV0Message());
      tx.addSignature(treasury, await contract.signForTreasury(tx.message.serialize()));
      if (!(await chain.blockhashValid(blockhash))) continue;
      return confirm(chain.conn, await chain.conn.sendRawTransaction(tx.serialize()));
    }
    throw new Error("MPC signing keeps outlasting the blockhash");
  }

  async function recycleUsdc(): Promise<void> {
    if ((await nearUsdc(funder)) >= FUNDER_LOW) return;
    const held = await chain.tokenBalance(treasury.toBase58(), config.checkoutMint);
    if (held < TREASURY_MIN_TO_RECYCLE) return;
    const units = held - TREASURY_KEEP;
    const quote = await checkout.quote({ originAsset: config.checkoutDestinationAsset, destinationAsset: `nep141:${TESTNET_USDC}`, amountOut: ((units * 98n) / 100n).toString(), recipient: funder.accountId, refundTo: treasury.toBase58(), depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN" });
    if (BigInt(quote.amountIn) > units) throw new Error(`recycle quote wants ${quote.amountIn}, holding ${units}`);
    const mint = new PublicKey(config.checkoutMint);
    const deposit = new PublicKey(quote.depositAddress);
    const sig = await treasurySend([await createAtaIdempotentIx(treasury, deposit, mint), transferCheckedIx(await ata(treasury, mint), mint, await ata(deposit, mint), treasury, BigInt(quote.amountIn), 6)]);
    await checkout.submitDeposit(sig, quote.depositAddress).catch(() => undefined);
    log(`upkeep: recycled ${Number(quote.amountIn) / 1e6} test USDC to ${funder.accountId}: ${await waitForSwap(d, quote.depositAddress)}`);
  }

  async function topUpSol(): Promise<void> {
    for (let i = 0; i < 2 && (await chain.conn.getBalance(treasury)) < SOL_LOW; i++) {
      const quote = await checkout.quote({ originAsset: `nep141:${TESTNET_USDC}`, destinationAsset: TESTNET_SOL, amountOut: SOL_PER_SWAP, recipient: treasury.toBase58(), refundTo: funder.accountId, depositType: "INTENTS", refundType: "INTENTS" });
      const tx = await funder.callFunctionRaw({ contractId: TESTNET_USDC, methodName: "ft_transfer_call", args: { receiver_id: TESTNET_VERIFIER, amount: quote.amountIn, msg: quote.depositAddress }, deposit: 1n, gas: 100_000_000_000_000n });
      await checkout.submitDeposit(tx.transaction.hash, quote.depositAddress).catch(() => undefined);
      log(`upkeep: bought 0.005 devnet SOL for the treasury: ${await waitForSwap(d, quote.depositAddress)}`);
    }
  }

  return async function upkeep(): Promise<void> {
    if (running) return;
    running = true;
    try {
      await topUpSol().catch((e) => log(`upkeep: SOL top-up failed: ${e}`));
      await recycleUsdc().catch((e) => log(`upkeep: recycle failed: ${e}`));
    } finally {
      running = false;
    }
  };
}
