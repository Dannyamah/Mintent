// Read-only. Runs the settlement search against the real treasury: for each recent paid order, does looking at what reached the
// treasury find the same transaction the reported hash did? Usage: tsx src/check-settlement-search.ts <relayer-db-path>
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { CONFIGS, loadAccount } from "@mintent/shared";
import { createRuntime } from "@mintent/relayer";

const [dbPath] = process.argv.slice(2);
if (!dbPath) throw new Error("usage: check-settlement-search <relayer-db-path>");
const cfg = CONFIGS.testnet;
const state = JSON.parse(readFileSync(new URL("../.demo-state.json", import.meta.url), "utf8"));
const { chain } = await createRuntime({ contractId: state.contract, relayer: loadAccount("testnet", state.relayer), config: cfg, log: () => undefined });
const treasury = chain.treasury.toBase58();
const recent = await chain.recentTokenTxs(treasury, cfg.checkoutMint);
console.log(`${recent.length} recent transactions on the treasury's test USDC account`);
const seen = new Set(recent.map((r) => r.sig));
const db = new DatabaseSync(dbPath, { readOnly: true });
const orders = db.prepare("SELECT token_id, settle_tx, amount_out, created_at FROM orders WHERE settle_tx IS NOT NULL ORDER BY created_at DESC LIMIT 6").all() as { token_id: string; settle_tx: string; amount_out: string; created_at: number }[];
let found = 0;
for (const o of orders) {
  const inList = seen.has(o.settle_tx);
  const delta = inList ? await chain.tokenDeltaInTx(o.settle_tx, treasury, cfg.checkoutMint) : null;
  const atMs = recent.find((r) => r.sig === o.settle_tx)?.atMs;
  const ok = inList && delta !== null && delta >= BigInt(o.amount_out) && atMs! >= o.created_at - 60_000;
  if (ok) found++;
  console.log(`token ${o.token_id}: ${ok ? "search finds it" : inList ? "listed, but wouldn't qualify" : "older than the search window"}  delta ${delta} of ${o.amount_out}`);
}
console.log(`${found} of ${orders.length} would be proven without a reported hash`);
process.exit(0);
