// Independently re-check that every action a Keeper took on a token stayed inside the owner's permission: from public data only.
// NearBlocks is used only to find the token's transactions. Every fact is then read from NEAR RPC and Solana RPC, the Solana
// messages the Keeper had signed are decoded here, and each is matched to the transaction that landed on Solana.
// Exit code 1 if anything is outside the permission. Usage: tsx src/verify-keeper.ts <contract> <tokenId> [testnet|mainnet]
import { Connection, PublicKey, VersionedMessage } from "@solana/web3.js";
import { ata, CONFIGS, deriveSolanaAddress, exitFee, nearProvider, NETWORKS, type CardView, type NearNetwork } from "@mintent/shared";

const [contract, tokenId, networkArg] = process.argv.slice(2);
if (!contract || !tokenId) throw new Error("usage: verify-keeper <contract> <tokenId> [testnet|mainnet]");
const network = (networkArg ?? (contract.endsWith(".near") ? "mainnet" : "testnet")) as NearNetwork;
const cfg = CONFIGS[network];
const CC_BUYBACK = "CcBuyM7sDhedBGLZxivBvgZVdqzrQAG66KYHgnTTEpLF";
const PAY = [196, 1, 233, 204, 98, 232, 22, 54];
const INDEXER = network === "mainnet" ? "https://api.nearblocks.io" : "https://api-testnet.nearblocks.io";

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  ok &&= pass;
};

async function rpc<T>(method: string, params: unknown): Promise<T> {
  for (const url of [NETWORKS[network].rpc, ...NETWORKS[network].rpcFallbacks]) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15_000) }).catch(() => null);
    const j = r?.ok ? ((await r.json()) as { result?: T }) : null;
    if (j?.result) return j.result;
  }
  throw new Error(`NEAR RPC ${method} failed on every endpoint`);
}

interface Found { hash: string; signer: string; method: string; ok: boolean }
/**
 * The contract's Keeper-related transactions, found through the indexer. Its public API returns the latest 100 and doesn't page,
 * so a token whose history is older than that is reported as incomplete rather than passed.
 */
async function findTransactions(sinceMs: number): Promise<{ found: Found[]; complete: boolean }> {
  const r = await fetch(`${INDEXER}/v3/accounts/${contract}/txns?limit=100`, { signal: AbortSignal.timeout(30_000) });
  const j = (await r.json()) as { data?: { transaction_hash: string; signer_account_id: string; block_timestamp: string; actions: { method?: string }[]; outcomes: { status: boolean } }[]; message?: string };
  if (!j.data) throw new Error(`the indexer didn't answer: ${j.message ?? r.status}. Try again in a minute.`);
  const seen = new Set<string>();
  const found: Found[] = [];
  for (const t of j.data) {
    const method = t.actions[0]?.method ?? "";
    if (seen.has(t.transaction_hash) || !["grant_keeper", "revoke_keeper", "keeper_sign", "keeper_payout"].includes(method)) continue;
    seen.add(t.transaction_hash);
    found.push({ hash: t.transaction_hash, signer: t.signer_account_id, method, ok: t.outcomes.status });
  }
  const oldest = Math.min(...j.data.map((t) => Number(BigInt(t.block_timestamp) / 1_000_000n)));
  return { found, complete: j.data.length < 100 || oldest < sinceMs };
}

interface Tx { args: Record<string, string | null | boolean>; blockHash: string; atMs: number; height: number }
async function readTransaction(f: Found): Promise<Tx> {
  const t = await rpc<{ transaction: { actions: { FunctionCall: { args: string } }[] }; transaction_outcome: { block_hash: string } }>("tx", { tx_hash: f.hash, sender_account_id: f.signer, wait_until: "FINAL" });
  return { args: JSON.parse(Buffer.from(t.transaction.actions[0].FunctionCall.args, "base64").toString()), blockHash: t.transaction_outcome.block_hash, atMs: 0, height: 0 };
}

/** Run `f` over `items`, a few at a time: public RPCs are slow one by one, and rate-limit floods. */
async function pool<T, R>(items: T[], f: (x: T) => Promise<R>, size = 6): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await f(items[i]);
  }));
  return out;
}

const near = nearProvider(network);
const card = (await near.callFunction({ contractId: contract, method: "get_card", args: { token_id: tokenId } } as never)) as unknown as CardView | null;
if (!card?.record.card_mint) throw new Error(`token ${tokenId} has no card`);
const cardAddress = new PublicKey(await deriveSolanaAddress(network, contract, card.solana_path));
const treasury = new PublicKey(await deriveSolanaAddress(network, contract, "treasury"));
const usdc = new PublicKey(cfg.ccPaymentMint);
const conn = new Connection(process.env.SOLANA_RPC_URL && !/mainnet/i.test(process.env.SOLANA_RPC_URL) === (network === "testnet") ? process.env.SOLANA_RPC_URL : cfg.solanaRpc, "confirmed");
console.log(`token ${tokenId} on ${contract}: card ${card.record.card_mint}, held by ${cardAddress.toBase58()}, now ${card.record.status}`);

const token = (await near.callFunction({ contractId: contract, method: "nft_token", args: { token_id: tokenId } } as never)) as unknown as { metadata?: { issued_at?: string } } | null;
const { found: all, complete } = await findTransactions(Number(token?.metadata?.issued_at ?? 0) - 60_000);
check("the indexer covers this token's whole history", complete, complete ? "" : "older than the contract's latest 100 transactions");
const read = await pool(all, async (f) => ({ ...f, ...(await readTransaction(f)) }));
const mine = read.filter((t) => t.args.token_id === tokenId);
// Block times only for this token's transactions: they order the permission changes and check the deadline.
await pool(mine, async (t) => {
  const block = await rpc<{ header: { timestamp: number; height: number } }>("block", { block_id: t.blockHash });
  t.atMs = Math.floor(block.header.timestamp / 1e6);
  t.height = block.header.height;
});
mine.sort((a, b) => a.height - b.height);
const grants = mine.filter((t) => t.ok && (t.method === "grant_keeper" || t.method === "revoke_keeper"));
const actions = mine.filter((t) => t.method === "keeper_sign" || t.method === "keeper_payout");
console.log(`found ${grants.length} permission change(s) and ${actions.length} Keeper request(s), ${actions.filter((a) => !a.ok).length} of them refused by the contract`);
if (!actions.some((a) => a.ok)) check("the Keeper acted on this token", false, "no accepted Keeper request found");

// Every signature the card address gave on Solana, to match each Keeper request to the transaction that landed.
const landed = new Map<string, boolean>();
for (const s of await conn.getSignaturesForAddress(cardAddress, { limit: 100 })) {
  if (s.err) continue;
  const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
  if (tx) landed.set(Buffer.from(tx.transaction.message.serialize()).toString("hex"), !tx.meta?.err);
}

for (const a of actions.filter((x) => x.ok)) {
  const grant = [...grants].reverse().find((g) => g.height < a.height);
  console.log(`\n${a.method} ${a.hash} at ${new Date(a.atMs).toISOString()}`);
  check("a live permission named this Keeper", grant?.method === "grant_keeper" && grant.args.agent_id === a.signer && a.atMs < Number(grant.args.expires_ms), grant ? `${grant.method} ${grant.hash.slice(0, 10)}…` : "none");
  if (grant?.method !== "grant_keeper") continue;
  const hex = String(a.args.payload_hex);
  const msg = VersionedMessage.deserialize(Buffer.from(hex, "hex"));
  const keys = msg.staticAccountKeys.map((k) => k.toBase58());
  const ixs = msg.compiledInstructions.map((ix) => ({ program: keys[ix.programIdIndex], accounts: ix.accountKeyIndexes.map((i) => keys[i]), data: Buffer.from(ix.data) }));

  if (a.method === "keeper_sign") {
    const pay = ixs.find((ix) => ix.program === CC_BUYBACK && PAY.every((b, i) => ix.data[i] === b));
    const price = pay ? pay.data.readBigUInt64LE(8) : -1n;
    check("it was a sell-back to Collector Crypt", Boolean(pay));
    check("of this token's card, by the card's own address", pay?.accounts[2] === card.record.card_mint && pay?.accounts[1] === cardAddress.toBase58());
    check("at or above the owner's minimum", price >= BigInt(String(grant.args.min_price)), `$${Number(price) / 1e6} vs $${Number(grant.args.min_price) / 1e6}`);
    check("with the money paid into the NFT's own address", pay?.accounts[5] === (await ata(cardAddress, usdc)).toBase58());
  } else {
    const transfers = ixs.filter((ix) => ix.data[0] === 12 && ix.data.length === 10).map((ix) => ({ to: ix.accounts[2], amount: ix.data.readBigUInt64LE(1) }));
    const payout = String(grant.args.payout ?? "");
    const ownerAta = payout ? (await ata(new PublicKey(payout), usdc)).toBase58() : "";
    const net = transfers.find((t) => t.to === ownerAta)?.amount ?? -1n;
    const treasuryAta = (await ata(treasury, usdc)).toBase58();
    const feePaid = transfers.find((t) => t.to === treasuryAta)?.amount ?? -1n;
    check("the owner had chosen a payout address", Boolean(payout), payout);
    check("exactly two transfers: to the owner, and Mintent's fee", transfers.length === 2 && net > 0n && feePaid >= 0n);
    check("the fee is exactly Mintent's exit fee", feePaid === exitFee(net + feePaid), `$${Number(feePaid) / 1e6} on $${Number(net + feePaid) / 1e6}`);
  }
  check("the signed transaction landed on Solana and succeeded", landed.get(hex) === true);
}

console.log(ok ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(ok ? 0 : 1);
