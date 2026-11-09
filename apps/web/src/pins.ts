// What the app decides for itself and never takes from the relayer, because the signing check depends on it.
import type { Health } from "./api";

export const PINS = {
  testnet: {
    nearRpcs: ["https://testnet-rpc.intea.rs", "https://near-testnet.drpc.org", "https://test.rpc.fastnear.com", "https://api.zan.top/near-testnet"],
    mpc: "v1.signer-prod.testnet",
    usdcMint: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr", // Collector Crypt's USDC-Dev
    swapOrigin: "nep141:sol-d48c1adc423a64867ac91ed2e1c0df76da323235.tp-omft.testnet",
  },
  mainnet: {
    nearRpcs: ["https://free.rpc.fastnear.com", "https://near.drpc.org", "https://rpc.mainnet.fastnear.com"],
    mpc: "v1.signer",
    usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    swapOrigin: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  },
} as const;

export type PinnedNetwork = keyof typeof PINS;

const builtFor = (import.meta.env?.VITE_MINTENT_CONTRACT as string | undefined) || null;

/**
 * Which contract and network to trust. A relayer that could name its own contract could also name its own signing rules, so a
 * mainnet build must have the contract fixed at build time. A testnet build may follow the relayer, so anyone can run the demo.
 */
export function trustedDeployment(health: Pick<Health, "contract" | "network">): { contract: string; network: PinnedNetwork } {
  if (builtFor && builtFor !== health.contract) throw new Error(`This app is built for ${builtFor}, but the service names ${health.contract}.`);
  if (health.network === "mainnet" && !builtFor) throw new Error("This build has no contract fixed for mainnet, so it can't sign.");
  const network: PinnedNetwork = (builtFor ?? health.contract).endsWith(".near") ? "mainnet" : "testnet";
  if (network !== health.network) throw new Error(`The service says ${health.network}, but this contract is on ${network}.`);
  return { contract: builtFor ?? health.contract, network };
}
