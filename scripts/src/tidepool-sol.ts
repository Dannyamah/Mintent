// Get devnet SOL to a Solana address via Tidepool (community testnet 1Click, https://www.usetidepool.tech).
// Flow: faucet test USDC into the NEAR wallet -> EXACT_OUTPUT quote for 0.005 SOL (Tidepool's cap)
// delivered on Solana devnet -> fund the deposit address inside the verifier via ft_transfer_call -> poll status.
// Test tokens only. Never send a real 1Click JWT here.
// Usage: tsx src/tidepool-sol.ts <near-dev.testnet> <solana-address> [swaps=1]
import { loadAccount } from "./lib/mpc.js";

const TIDEPOOL = process.env.TIDEPOOL_BASE_URL ?? "https://www.usetidepool.tech";
const USDC = "usdc.tidepool-sandbox.testnet";
const VERIFIER = "verifier.tidepool-sandbox.testnet";
const SOL_ASSET = "nep141:sol.tp-omft.testnet";
const LAMPORTS = "5000000"; // 0.005 SOL, Tidepool's per-swap cap

const [dev, solAddress, swapsArg] = process.argv.slice(2);
if (!dev || !solAddress) throw new Error("usage: tidepool-sol <near-dev.testnet> <solana-address> [swaps]");
const swaps = Number(swapsArg ?? 1);
const account = loadAccount("testnet", dev);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${TIDEPOOL}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text) as T;
}

const faucet = await api<{ drips?: unknown[] }>("/v0/faucet", { accountId: dev, mode: "wallet" }).catch((e) => ({ error: String(e) }));
console.log("faucet:", JSON.stringify(faucet).slice(0, 200));

for (let i = 0; i < swaps; i++) {
  const q = await api<{ quote: { depositAddress: string; amountIn: string; amountOut: string } }>("/v0/quote", {
    dry: false,
    swapType: "EXACT_OUTPUT",
    slippageTolerance: 100,
    originAsset: `nep141:${USDC}`,
    depositType: "INTENTS",
    destinationAsset: SOL_ASSET,
    amount: LAMPORTS,
    recipient: solAddress,
    recipientType: "DESTINATION_CHAIN",
    refundTo: dev,
    refundType: "INTENTS",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  });
  const { depositAddress, amountIn, amountOut } = q.quote;
  console.log(`swap ${i + 1}: pay ${amountIn} USDC base units -> ${amountOut} lamports; deposit ${depositAddress}`);

  const tx = await account.callFunctionRaw({
    contractId: USDC,
    methodName: "ft_transfer_call",
    args: { receiver_id: VERIFIER, amount: amountIn, msg: depositAddress },
    deposit: 1n,
    gas: 100_000_000_000_000n,
  });
  const txHash = tx.transaction.hash;
  await api("/v0/deposit/submit", { txHash, depositAddress }).catch(() => undefined);

  for (let t = 0; t < 60; t++) {
    const s = await api<{ status: string; swapDetails?: unknown }>(`/v0/status?depositAddress=${depositAddress}`);
    if (["SUCCESS", "REFUNDED", "FAILED"].includes(s.status)) {
      console.log(`  status ${s.status}`, JSON.stringify(s.swapDetails ?? {}).slice(0, 300));
      break;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
