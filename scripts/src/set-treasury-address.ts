// Tell the contract its treasury's Solana address, so it can recognise Mintent's fee in a Keeper's payout. Owner-only, one-off.
// The address is derived from the contract by NEAR's signing network, so it can't be anything else. Mainnet needs approval.
// Usage: tsx src/set-treasury-address.ts <testnet|mainnet> <contract> <owner-account>
import { deriveSolanaAddress, loadAccount, type NearNetwork } from "@mintent/shared";

const [network, contract, owner] = process.argv.slice(2) as [NearNetwork, string, string];
if (!["testnet", "mainnet"].includes(network) || !contract || !owner) throw new Error("usage: set-treasury-address <testnet|mainnet> <contract> <owner>");
const treasury = await deriveSolanaAddress(network, contract, "treasury");
const r = await loadAccount(network, owner).callFunctionRaw({ contractId: contract, methodName: "set_treasury_address", args: { address: treasury }, gas: 30_000_000_000_000n });
console.log(`treasury ${treasury} set: ${r.transaction.hash}`);
