// Read-only check against production: mainnet 1Click dry quotes (no deposit address, no money) and CC mainnet machines.
// Confirms our request shape, asset ids and signature verification against the real API.
import { CcClient, CONFIGS } from "@mintent/shared";
import { HttpBackend, withServiceFee } from "@mintent/checkout";

const cfg = CONFIGS.mainnet;
const backend = new HttpBackend(cfg.oneClickBase, process.env.ONECLICK_JWT);
const cc = new CcClient(cfg.ccGacha, cfg.ccApi);
const machine = await cc.machine(cfg.defaultPack);
const out = withServiceFee(BigInt(machine.price) * 1_000_000n, cfg.serviceFeeBps);
console.log({ pack: machine.code, price: machine.price, ev: machine.ev, buybackPct: machine.instantBuyback, amountOutUnits: out.toString() });

const tokens = await backend.tokens();
const dest = tokens.find((t) => t.assetId === cfg.checkoutDestinationAsset);
console.log("destination asset:", dest?.symbol, dest?.blockchain);
if (!dest) throw new Error("destination asset not listed");

const PLACEHOLDER_RECIPIENT = "So11111111111111111111111111111111111111112";
const REFUNDS: Record<string, string> = {
  btc: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  sol: PLACEHOLDER_RECIPIENT,
  eth: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  base: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  arb: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  near: "wrap.near",
  doge: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L",
};
for (const [symbol, chain] of [["BTC", "btc"], ["SOL", "sol"], ["ETH", "eth"], ["USDC", "base"], ["USDC", "arb"], ["USDC", "near"], ["DOGE", "doge"]]) {
  const t = tokens.find((x) => x.symbol === symbol && x.blockchain === chain);
  if (!t) {
    console.log(symbol, chain, "not listed");
    continue;
  }
  try {
    const q = await backend.quote({ dry: true, originAsset: t.assetId, destinationAsset: cfg.checkoutDestinationAsset, amountOut: out.toString(), recipient: PLACEHOLDER_RECIPIENT, refundTo: REFUNDS[chain] });
    const inUsd = (Number(q.amountIn) / 10 ** t.decimals) * (t.price ?? 0);
    console.log(`${symbol.padEnd(5)} ${chain.padEnd(5)} pay ${q.amountInFormatted ?? q.amountIn} (~$${inUsd.toFixed(2)}, ${(100 * (inUsd / (Number(out) / 1e6) - 1)).toFixed(2)}% over) est ${q.timeEstimateSeconds ?? "?"} s; ${t.symbol === "BTC" ? "signature check skipped (SDK false negative)" : "signature verified"}`);
  } catch (e) {
    console.log(`${symbol.padEnd(5)} ${chain.padEnd(5)} FAILED: ${String(e).slice(0, 220)}`);
  }
}
