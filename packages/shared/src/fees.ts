// Mintent's fee when USDC leaves an NFT: 1%, at least $0.25. It covers the Solana rent and fees the treasury pays for withdrawals
// and cash-outs. Withdrawing the card itself is free. The web app pins the same rule (apps/web/src/verifyMessage.ts) and a test
// keeps the two equal, because the app refuses to sign a fee that doesn't match.
export const EXIT_FEE_BPS = 100n;
export const EXIT_FEE_MIN_UNITS = 250_000n; // $0.25 in USDC base units

/** The fee on moving `total` USDC base units out of an NFT's address. */
export function exitFee(total: bigint): bigint {
  const percent = (total * EXIT_FEE_BPS + 9_999n) / 10_000n;
  return percent > EXIT_FEE_MIN_UNITS ? percent : EXIT_FEE_MIN_UNITS;
}

/** What the owner receives, or null when the amount doesn't cover the fee. */
export function afterExitFee(total: bigint): { fee: bigint; net: bigint } | null {
  const fee = exitFee(total);
  return total > fee ? { fee, net: total - fee } : null;
}
