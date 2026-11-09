// The one piece of Ethereum encoding the app needs: an ERC-20 transfer(to, amount) call.
const pad = (hex: string) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");

export function erc20Transfer(to: string, amount: bigint): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error(`not an Ethereum address: ${to}`);
  if (amount <= 0n) throw new Error("amount must be positive");
  return `0xa9059cbb${pad(to)}${pad(amount.toString(16))}`;
}
