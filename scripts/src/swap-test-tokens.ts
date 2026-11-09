// Testnet only. Swap one Tidepool test token for another on NEAR, through Tidepool's 1Click API, e.g. spare test USDT into the
// test USDC the app's "Pay with test USDC" button spends. Test tokens only.
// Usage: tsx src/swap-test-tokens.ts <account.testnet> <from-token> <to-token> <amount-in-base-units>
//   e.g. tsx src/swap-test-tokens.ts mintent-dev-mw21w9ki.testnet usdt usdc 150000000
import { loadAccount } from "@mintent/shared";

const TIDEPOOL = "https://www.usetidepool.tech";
const VERIFIER = "verifier.tidepool-sandbox.testnet";
const [accountId, from, to, amount] = process.argv.slice(2);
if (!accountId?.endsWith(".testnet") || !from || !to || !amount) throw new Error("usage: swap-test-tokens <account.testnet> <from-token> <to-token> <amount>");
const fromContract = `${from}.tidepool-sandbox.testnet`;
const account = loadAccount("testnet", accountId);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${TIDEPOOL}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

const { quote } = await api<{ quote: { depositAddress: string; amountIn: string; amountOut: string } }>("/v0/quote", {
  dry: false,
  swapType: "EXACT_INPUT",
  slippageTolerance: 100,
  originAsset: `nep141:${fromContract}`,
  depositType: "INTENTS",
  destinationAsset: `nep141:${to}.tidepool-sandbox.testnet`,
  amount,
  recipient: accountId,
  recipientType: "DESTINATION_CHAIN",
  refundTo: accountId,
  refundType: "INTENTS",
  deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
});
console.log(`quote: ${quote.amountIn} ${from} -> ${quote.amountOut} ${to}`);
const tx = await account.callFunctionRaw({ contractId: fromContract, methodName: "ft_transfer_call", args: { receiver_id: VERIFIER, amount: quote.amountIn, msg: quote.depositAddress }, deposit: 1n, gas: 100_000_000_000_000n });
await api("/v0/deposit/submit", { txHash: tx.transaction.hash, depositAddress: quote.depositAddress }).catch(() => undefined);
let status = "";
for (let i = 0; i < 60 && !["SUCCESS", "REFUNDED", "FAILED"].includes(status); i++) {
  await new Promise((r) => setTimeout(r, 4000));
  status = (await api<{ status: string }>(`/v0/status?depositAddress=${quote.depositAddress}`)).status;
}
console.log(`status: ${status || "still processing"}`);
process.exit(status === "SUCCESS" ? 0 : 1);
