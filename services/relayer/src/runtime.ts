// Wires the relayer to real networks.
import { Connection, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import type { Account } from "near-api-js";
import { ata, CcClient, confirm, createAtaIdempotentIx, faucetAirdropIx, loadConfig, MintentContract, transferCheckedIx, type MintentConfig } from "@mintent/shared";
import { createBackend } from "@mintent/checkout";
import { Db } from "./db.js";
import { SolanaChain, type Deps, type Sponsor } from "./deps.js";

// NEAR checks an account's balance against the gas it attaches at about 10x the current gas price, and refunds what's
// unused. Measured on testnet at price 1e8: 30 Tgas needed 0.0309 NEAR, and 100 Tgas needed 0.1009 NEAR.
// So the float isn't spent: only the burn is, a fraction of this per signature.
const CARD_SIGN_GAS = 50_000_000_000_000n; // 50 Tgas, what the app attaches to sign_for_card
const PESSIMISTIC_MULTIPLIER = 10n;
const TEST_TREASURY_MIN = 100_000_000n; // 100 USDC-Dev (devnet faucet token)
const TEST_TREASURY_TOP_UP = 200_000_000n;
export function sponsorAmounts(gasPriceYocto: bigint): { min: bigint; topUp: bigint } {
  const needed = CARD_SIGN_GAS * gasPriceYocto * PESSIMISTIC_MULTIPLIER;
  return { min: (needed * 12n) / 10n, topUp: needed * 2n };
}

export function nearSponsor(relayer: Account): Sponsor {
  return {
    async ensureFunded(account) {
      let balance = 0n;
      try {
        const q = (await relayer.provider.viewAccount({ accountId: account, finality: "final" } as never)) as unknown as { amount: string | bigint };
        balance = BigInt(q.amount);
      } catch {
        balance = 0n; // a new implicit account: the transfer below creates it
      }
      const price = (await relayer.provider.viewGasPrice()) as unknown as { gas_price?: string; gasPrice?: bigint };
      const { min, topUp } = sponsorAmounts(BigInt(price.gas_price ?? price.gasPrice ?? 1_000_000_000n));
      if (balance >= min) return;
      await relayer.transfer({ receiverId: account, amount: topUp } as never);
      // Return only once nodes can see the account, or the customer's first transaction fails right after this.
      for (let i = 0; i < 12; i++) {
        const seen = await relayer.provider.viewAccount({ accountId: account, finality: "final" } as never).then(() => true, () => false);
        if (seen) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
  };
}

/** Fetch images a few at a time, so the image service has them cached before anyone asks. */
export async function warmImages(urls: string[]): Promise<void> {
  const queue = [...urls];
  await Promise.all(
    Array.from({ length: 6 }, async () => {
      for (let url = queue.shift(); url; url = queue.shift()) await fetch(url, { signal: AbortSignal.timeout(15_000) }).then((r) => r.arrayBuffer()).catch(() => undefined);
    }),
  );
}

export async function createRuntime(opts: { contractId: string; relayer: Account; dbPath?: string; config?: MintentConfig; oneClickJwt?: string; log?: Deps["log"] }): Promise<Deps & { contract: MintentContract; chain: SolanaChain }> {
  const config = opts.config ?? loadConfig();
  const conn = new Connection(config.solanaRpc, "confirmed");
  const contract = new MintentContract(opts.contractId, opts.relayer);
  const chain = await SolanaChain.create(conn, config.network, opts.contractId);
  // Hosted logs are read in a dashboard, so keys inside RPC URLs never reach them.
  const log = opts.log ?? ((m: string) => console.log(`[relayer] ${m.replace(/(api[-_]?key=)[^&\s"']+/gi, "$1***")}`));
  let toppingUp = false;
  const topUpTestTreasury = async () => {
    if (toppingUp || (await chain.tokenBalance(chain.treasury.toBase58(), config.ccPaymentMint)) >= TEST_TREASURY_MIN) return;
    toppingUp = true;
    try {
      const ix = await faucetAirdropIx(new PublicKey(config.ccPaymentMint), chain.treasury, TEST_TREASURY_TOP_UP);
      for (let attempt = 1; attempt <= 4; attempt++) {
        const { blockhash } = await conn.getLatestBlockhash("confirmed");
        const tx = new VersionedTransaction(new TransactionMessage({ payerKey: chain.treasury, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message());
        tx.addSignature(chain.treasury, await contract.signForTreasury(tx.message.serialize()));
        if (!(await conn.isBlockhashValid(blockhash, { commitment: "processed" })).value) continue; // MPC signing outlasted it
        log(`treasury topped up with test USDC-Dev: ${await confirm(conn, await conn.sendRawTransaction(tx.serialize()))}`);
        return;
      }
      throw new Error("MPC signing keeps outlasting the blockhash");
    } finally {
      toppingUp = false;
    }
  };
  // Testnet only: see CardOps.prepareCashOut.
  const fundTestCashOut = async (depositAddress: string, amount: bigint) => {
    const mint = new PublicKey(config.checkoutMint);
    const deposit = new PublicKey(depositAddress);
    const instructions = [await createAtaIdempotentIx(chain.treasury, deposit, mint), transferCheckedIx(await ata(chain.treasury, mint), mint, await ata(deposit, mint), chain.treasury, amount, 6)];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      const tx = new VersionedTransaction(new TransactionMessage({ payerKey: chain.treasury, recentBlockhash: blockhash, instructions }).compileToV0Message());
      tx.addSignature(chain.treasury, await contract.signForTreasury(tx.message.serialize()));
      if (!(await conn.isBlockhashValid(blockhash, { commitment: "processed" })).value) continue; // MPC signing outlasted it
      return confirm(conn, await conn.sendRawTransaction(tx.serialize()));
    }
    throw new Error("MPC signing keeps outlasting the blockhash");
  };
  return {
    config,
    db: new Db(opts.dbPath ?? ":memory:"),
    checkout: createBackend(config.oneClickBase, opts.oneClickJwt),
    cc: new CcClient(config.ccGacha, config.ccApi),
    contract,
    chain,
    sponsor: nearSponsor(opts.relayer),
    warmImages,
    ...(config.network === "testnet" ? { topUpTestTreasury, fundTestCashOut } : {}),
    log,
  };
}
