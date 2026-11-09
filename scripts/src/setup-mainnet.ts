// Prepare a deployed mainnet contract for orders: create the treasury's durable nonce accounts on Solana, then have the owner
// register them and allow USDC. Spends a little real SOL and NEAR, so it needs approval first. Safe to rerun: finished steps are skipped.
// Usage: tsx src/setup-mainnet.ts <contract.near> <owner.near> <relayer.near>   (reads SOLANA_RPC_URL from .env)
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { CONFIGS, confirm, loadAccount, loadConfig, nonceAccountFor, nonceSeed } from "@mintent/shared";
import { createRuntime } from "@mintent/relayer";

const [contractId, ownerId, relayerId] = process.argv.slice(2);
if (!contractId?.endsWith(".near") || !ownerId?.endsWith(".near") || !relayerId?.endsWith(".near")) throw new Error("usage: setup-mainnet <contract.near> <owner.near> <relayer.near>");
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  /* no .env: use the environment */
}
const config = loadConfig({ ...process.env, NEAR_NETWORK: "mainnet" });
if (!config.solanaRpc.includes("helius")) console.log("note: not using a Helius RPC");
const { chain, contract } = await createRuntime({ contractId, relayer: loadAccount("mainnet", relayerId), config, log: console.log });
const { conn, treasury } = chain;
const owner = loadAccount("mainnet", ownerId);

/** Treasury-signed transaction with a fresh blockhash, rebuilt if MPC signing outlasts it. */
async function treasurySend(instructions: TransactionInstruction[]): Promise<string> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: blockhash, instructions }).compileToV0Message());
    const sig = await contract.signForTreasury(tx.message.serialize());
    tx.addSignature(treasury, sig);
    if (!(await conn.isBlockhashValid(blockhash, { commitment: "processed" })).value) {
      console.log(`signing outlasted the blockhash, attempt ${attempt}`);
      continue;
    }
    return confirm(conn, await conn.sendRawTransaction(tx.serialize()));
  }
  throw new Error("MPC signing keeps outlasting the blockhash");
}

console.log({ treasury: treasury.toBase58(), sol: Number(await conn.getBalance(treasury)) / 1e9 });
const nonces: PublicKey[] = [];
for (let i = 1; i <= CONFIGS.mainnet.nonceAccounts; i++) {
  const nonce = await nonceAccountFor(treasury, i);
  nonces.push(nonce);
  if (await conn.getAccountInfo(nonce)) {
    console.log(`nonce ${i} exists: ${nonce.toBase58()}`);
    continue;
  }
  const lamports = Number(await conn.getMinimumBalanceForRentExemption(80));
  const started = Date.now();
  const sig = await treasurySend([
    SystemProgram.createAccountWithSeed({ fromPubkey: treasury, newAccountPubkey: nonce, basePubkey: treasury, seed: nonceSeed(i), lamports, space: 80, programId: SystemProgram.programId }),
    SystemProgram.nonceInitialize({ noncePubkey: nonce, authorizedPubkey: treasury }),
  ]);
  console.log(`nonce ${i} created: ${nonce.toBase58()} tx ${sig} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
}

const view = () => owner.provider.callFunction({ contractId, method: "get_config", args: {} } as never) as unknown as Promise<{ nonce_accounts: string[]; payment_mints: string[]; owner_id: string }>;
let current = await view();
if (current.owner_id !== ownerId) throw new Error(`the contract's owner is ${current.owner_id}, not ${ownerId}`);
for (const nonce of nonces) {
  if (current.nonce_accounts.includes(nonce.toBase58())) continue;
  const r = await owner.callFunctionRaw({ contractId, methodName: "add_nonce_account", args: { address: nonce.toBase58() }, gas: 30_000_000_000_000n });
  console.log(`registered nonce ${nonce.toBase58()}: ${r.transaction.hash}`);
}
if (!current.payment_mints.includes(config.ccPaymentMint)) {
  const r = await owner.callFunctionRaw({ contractId, methodName: "add_payment_mint", args: { address: config.ccPaymentMint }, gas: 30_000_000_000_000n });
  console.log(`allowed USDC: ${r.transaction.hash}`);
}
current = await view();
console.log(JSON.stringify(current));
console.log({ treasurySol: Number(await conn.getBalance(treasury)) / 1e9 });
const ready = nonces.every((n) => current.nonce_accounts.includes(n.toBase58())) && current.payment_mints.includes(config.ccPaymentMint);
console.log(ready ? "READY" : "NOT READY");
process.exit(ready ? 0 : 1);
