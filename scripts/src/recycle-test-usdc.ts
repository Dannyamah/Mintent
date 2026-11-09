// Testnet only. Each checkout leaves Tidepool test USDC in the treasury on Solana devnet, unused, because Collector Crypt's
// devnet charges a different token. This swaps it back to a NEAR account so test runs can continue without the faucet.
// Usage: tsx src/recycle-test-usdc.ts <amount-in-usdc> <recipient.testnet>   (uses scripts/.demo-state.json)
import { PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { ata, CONFIGS, confirm, createAtaIdempotentIx, loadAccount, sleep, transferCheckedIx } from "@mintent/shared";
import { createRuntime } from "@mintent/relayer";

const [amountArg, recipient] = process.argv.slice(2);
if (!amountArg || !recipient) throw new Error("usage: recycle-test-usdc <amount-in-usdc> <recipient.testnet>");
const cfg = CONFIGS.testnet;
const state = JSON.parse(readFileSync(new URL("../.demo-state.json", import.meta.url), "utf8"));
const d = await createRuntime({ contractId: state.contract, relayer: loadAccount("testnet", state.relayer), config: cfg });
const { chain, contract } = d;
const treasury = chain.treasury;
const mint = new PublicKey(cfg.checkoutMint);
const units = BigInt(Math.round(Number(amountArg) * 1e6));
const held = await chain.tokenBalance(treasury.toBase58(), cfg.checkoutMint);
console.log({ treasury: treasury.toBase58(), heldTestUsdc: Number(held) / 1e6 });
if (held < units) throw new Error(`treasury holds only ${Number(held) / 1e6}`);

const quote = await d.checkout.quote({
  originAsset: cfg.checkoutDestinationAsset,
  destinationAsset: "nep141:usdc.tidepool-sandbox.testnet",
  amountOut: ((units * 98n) / 100n).toString(),
  recipient,
  refundTo: treasury.toBase58(),
  depositType: "ORIGIN_CHAIN",
  refundType: "ORIGIN_CHAIN",
});
console.log({ depositAddress: quote.depositAddress, pay: quote.amountIn });
const deposit = new PublicKey(quote.depositAddress);
const instructions: TransactionInstruction[] = [
  await createAtaIdempotentIx(treasury, deposit, mint),
  transferCheckedIx(await ata(treasury, mint), mint, await ata(deposit, mint), treasury, BigInt(quote.amountIn), 6),
];

let sent = "";
for (let attempt = 1; attempt <= 4 && !sent; attempt++) {
  const { blockhash } = await chain.conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: treasury, recentBlockhash: blockhash, instructions }).compileToV0Message());
  const sig = await contract.signForTreasury(tx.message.serialize());
  if (!(await chain.blockhashValid(blockhash))) continue;
  tx.addSignature(treasury, sig);
  sent = await confirm(chain.conn, await chain.conn.sendRawTransaction(tx.serialize()));
}
if (!sent) throw new Error("signing kept outlasting the blockhash");
await d.checkout.submitDeposit(sent, quote.depositAddress).catch(() => undefined);
console.log({ depositTx: sent });

for (let i = 0; i < 80; i++) {
  const s = await d.checkout.status(quote.depositAddress);
  if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) {
    console.log({ status: s.status, amountOut: s.swapDetails?.amountOut, reason: s.swapDetails?.refundReason });
    process.exit(s.status === "SUCCESS" ? 0 : 1);
  }
  await sleep(4000);
}
throw new Error("timed out");
