// Testnet only. Acts as a customer on another chain: sends Tidepool test USDC on Solana devnet to a 1Click deposit address,
// from the treasury's stock of it, so the app's real "send to this address" path can be tested without a wallet.
// Usage: tsx src/pay-deposit-from-solana.ts <deposit-address> <amount-in-base-units>   (uses scripts/.demo-state.json)
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { ata, CONFIGS, confirm, createAtaIdempotentIx, loadAccount, transferCheckedIx } from "@mintent/shared";
import { createRuntime } from "@mintent/relayer";

const [depositArg, amountArg] = process.argv.slice(2);
if (!depositArg || !amountArg) throw new Error("usage: pay-deposit-from-solana <deposit-address> <amount-in-base-units>");
const cfg = CONFIGS.testnet;
const state = JSON.parse(readFileSync(new URL("../.demo-state.json", import.meta.url), "utf8"));
const d = await createRuntime({ contractId: state.contract, relayer: loadAccount("testnet", state.relayer), config: cfg, log: () => undefined });
const { chain, contract } = d;
const mint = new PublicKey(cfg.checkoutMint);
const deposit = new PublicKey(depositArg);
const instructions = [await createAtaIdempotentIx(chain.treasury, deposit, mint), transferCheckedIx(await ata(chain.treasury, mint), mint, await ata(deposit, mint), chain.treasury, BigInt(amountArg), 6)];

for (let attempt = 1; attempt <= 4; attempt++) {
  const { blockhash } = await chain.conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: chain.treasury, recentBlockhash: blockhash, instructions }).compileToV0Message());
  const sig = await contract.signForTreasury(tx.message.serialize());
  if (!(await chain.blockhashValid(blockhash))) continue; // MPC signing outlasted it
  tx.addSignature(chain.treasury, sig);
  console.log(await confirm(chain.conn, await chain.conn.sendRawTransaction(tx.serialize())));
  process.exit(0);
}
throw new Error("signing kept outlasting the blockhash");
