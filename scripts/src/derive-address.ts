// Print the Solana address the NEAR MPC network derives for (predecessor, path).
// Usage: tsx src/derive-address.ts <predecessor-account> <path> [testnet|mainnet]
import { deriveSolanaAddress, type NearNetwork } from "./lib/mpc.js";
const [predecessor, path, network = "testnet"] = process.argv.slice(2);
if (!predecessor || !path) throw new Error("usage: derive-address <predecessor> <path> [network]");
console.log(await deriveSolanaAddress(network as NearNetwork, predecessor, path));
