// Per-network configuration. Every address here was verified: see docs/CONTEXT.md.
import type { NearNetwork } from "./near.js";

export interface MintentConfig {
  network: NearNetwork;
  nearRpc: string;
  mpcContract: string;
  solanaRpc: string;
  ccGacha: string;
  ccApi: string;
  /** The USDC mint Collector Crypt charges in on this cluster. */
  ccPaymentMint: string;
  /** Base URL of the 1Click API (or Tidepool, or "mock"). */
  oneClickBase: string;
  /** 1Click asset id a checkout settles into, on Solana, at the treasury address. */
  checkoutDestinationAsset: string;
  /** SPL mint of that asset, used to verify settlement on Solana. */
  checkoutMint: string;
  defaultPack: string;
  /** Added to the pack price in the checkout quote. Pays Solana fees and rent, and is Mintent's revenue. */
  serviceFeeBps: number;
  nonceAccounts: number;
}

export const CONFIGS: Record<NearNetwork, MintentConfig> = {
  testnet: {
    network: "testnet",
    nearRpc: "https://testnet-rpc.intea.rs",
    mpcContract: "v1.signer-prod.testnet",
    solanaRpc: "https://api.devnet.solana.com",
    ccGacha: "https://dev-gacha.collectorcrypt.com",
    ccApi: "https://dev-api.collectorcrypt.com",
    ccPaymentMint: "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr", // USDC-Dev
    oneClickBase: "https://www.usetidepool.tech", // community testnet of 1Click; test tokens only
    // Tidepool's own test USDC. It is NOT CC's USDC-Dev, so on testnet the checkout is settled and verified
    // but the pack is paid from the treasury's pre-stocked USDC-Dev (D-008).
    checkoutDestinationAsset: "nep141:sol-d48c1adc423a64867ac91ed2e1c0df76da323235.tp-omft.testnet",
    checkoutMint: "7pafEGXSmR35rLKNaD6inpfLYuEnRX9DyBc1c7M8r4Xr",
    defaultPack: "pokemon_25",
    serviceFeeBps: 100,
    nonceAccounts: 2,
  },
  mainnet: {
    network: "mainnet",
    nearRpc: "https://free.rpc.fastnear.com",
    mpcContract: "v1.signer",
    solanaRpc: "https://api.mainnet-beta.solana.com",
    ccGacha: "https://gacha.collectorcrypt.com",
    ccApi: "https://api.collectorcrypt.com",
    ccPaymentMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    oneClickBase: "https://1click.chaindefuser.com",
    checkoutDestinationAsset: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    checkoutMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    defaultPack: "pokemon_25",
    serviceFeeBps: 100,
    nonceAccounts: 3,
  },
};

export function loadConfig(env: Record<string, string | undefined> = process.env): MintentConfig {
  const network = (env.NEAR_NETWORK || "testnet") as NearNetwork;
  const base = CONFIGS[network];
  if (!base) throw new Error(`unknown NEAR_NETWORK ${network}`);
  // .env can hold a mainnet RPC while the relayer runs on testnet. Never point one network's relayer at another's Solana.
  const wrongCluster = network === "testnet" ? /mainnet/i : /devnet|testnet/i;
  const rpc = env.SOLANA_RPC_URL || "";
  if (wrongCluster.test(rpc) && network === "mainnet") throw new Error("SOLANA_RPC_URL is for a test network, but NEAR_NETWORK is mainnet");
  const solanaRpc = wrongCluster.test(rpc) ? "" : rpc;
  return {
    ...base,
    nearRpc: env.NEAR_RPC_URL || base.nearRpc,
    solanaRpc: solanaRpc || base.solanaRpc,
    oneClickBase: env.ONECLICK_BASE_URL || base.oneClickBase,
    serviceFeeBps: env.SERVICE_FEE_BPS ? Number(env.SERVICE_FEE_BPS) : base.serviceFeeBps,
  };
}
