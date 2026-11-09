// Testnet only. Gives a throwaway wallet test USDC and gas on Base Sepolia through Tidepool, so a test can act as a customer
// paying from another chain. Test tokens only.
// Usage: tsx src/fund-base-wallet.ts <near-account.testnet> <0x-address> <usdc-base-units>
import { loadAccount } from "@mintent/shared";

const TIDEPOOL = "https://www.usetidepool.tech";
const NEAR_USDC = "usdc.tidepool-sandbox.testnet";
const VERIFIER = "verifier.tidepool-sandbox.testnet";
const BASE_USDC = "nep141:base-0x38d81431b9f76d9699af7517040d5221d9dea252.tp-omft.testnet";
const BASE_ETH = "nep141:base.tp-omft.testnet";
const GAS_WEI = "300000000000000"; // 0.0003 test ETH: plenty for one token transfer

const [funder, address, usdc] = process.argv.slice(2);
if (!funder || !address || !usdc) throw new Error("usage: fund-base-wallet <near-account.testnet> <0x-address> <usdc-base-units>");
const account = loadAccount("testnet", funder);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${TIDEPOOL}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

for (const [destinationAsset, amount] of [[BASE_ETH, GAS_WEI], [BASE_USDC, usdc]] as const) {
  const { quote } = await api<{ quote: { depositAddress: string; amountIn: string } }>("/v0/quote", {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: `nep141:${NEAR_USDC}`,
    depositType: "INTENTS",
    destinationAsset,
    amount,
    recipient: address,
    recipientType: "DESTINATION_CHAIN",
    refundTo: funder,
    refundType: "INTENTS",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  const tx = await account.callFunctionRaw({ contractId: NEAR_USDC, methodName: "ft_transfer_call", args: { receiver_id: VERIFIER, amount: quote.amountIn, msg: quote.depositAddress }, deposit: 1n, gas: 100_000_000_000_000n });
  await api("/v0/deposit/submit", { txHash: tx.transaction.hash, depositAddress: quote.depositAddress }).catch(() => undefined);
  let status = "";
  for (let i = 0; i < 60 && !["SUCCESS", "REFUNDED", "FAILED"].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 4000));
    status = (await api<{ status: string }>(`/v0/status?depositAddress=${quote.depositAddress}`)).status;
  }
  console.log(`${destinationAsset}: ${status}`);
  if (status !== "SUCCESS") throw new Error(`funding swap ended ${status || "without finishing"}`);
}
