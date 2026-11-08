// Wires the relayer to real networks.
import { Connection } from "@solana/web3.js";
import type { Account } from "near-api-js";
import { CcClient, loadConfig, MintentContract, type MintentConfig } from "@mintent/shared";
import { createBackend } from "@mintent/checkout";
import { Db } from "./db.js";
import { SolanaChain, type Deps, type Sponsor } from "./deps.js";

const SPONSOR_MIN_YOCTO = 30_000_000_000_000_000_000_000n; // 0.03 NEAR
const SPONSOR_TOPUP_YOCTO = 50_000_000_000_000_000_000_000n; // 0.05 NEAR, enough for several card signatures

export function nearSponsor(relayer: Account): Sponsor {
  return {
    async ensureFunded(account) {
      let balance = 0n;
      try {
        const q = (await relayer.provider.viewAccount({ accountId: account, blockQuery: { finality: "final" } } as never)) as unknown as { amount: string | bigint };
        balance = BigInt(q.amount);
      } catch {
        balance = 0n; // a new implicit account: the transfer below creates it
      }
      if (balance < SPONSOR_MIN_YOCTO) await relayer.transfer({ receiverId: account, amount: SPONSOR_TOPUP_YOCTO } as never);
    },
  };
}

export async function createRuntime(opts: { contractId: string; relayer: Account; dbPath?: string; config?: MintentConfig; oneClickJwt?: string; log?: Deps["log"] }): Promise<Deps & { contract: MintentContract; chain: SolanaChain }> {
  const config = opts.config ?? loadConfig();
  const conn = new Connection(config.solanaRpc, "confirmed");
  return {
    config,
    db: new Db(opts.dbPath ?? ":memory:"),
    checkout: createBackend(config.oneClickBase, opts.oneClickJwt),
    cc: new CcClient(config.ccGacha, config.ccApi),
    contract: new MintentContract(opts.contractId, opts.relayer),
    chain: await SolanaChain.create(conn, config.network, opts.contractId),
    sponsor: nearSponsor(opts.relayer),
    log: opts.log ?? ((m) => console.log(`[relayer] ${m}`)),
  };
}
