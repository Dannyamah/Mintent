// Write each Railway service's variables to deploy/.railway/<service>.env, for pasting into the service's Variables > Raw Editor.
// The files hold private keys: they're readable only by you, git ignores them, and this script never prints a value.
// Usage: tsx src/railway-vars.ts <relayer-testnet-url> <relayer-mainnet-url> <web-testnet-url> <web-mainnet-url>
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [relayerTestnet, relayerMainnet, webTestnet, webMainnet] = process.argv.slice(2).map((u) => u?.replace(/\/$/, ""));
if (![relayerTestnet, relayerMainnet, webTestnet, webMainnet].every((u) => u?.startsWith("https://"))) {
  throw new Error("usage: railway-vars <relayer-testnet-url> <relayer-mainnet-url> <web-testnet-url> <web-mainnet-url>  (all https://)");
}

const root = new URL("../../", import.meta.url).pathname;
const key = (network: string, account: string) => (JSON.parse(readFileSync(join(homedir(), ".near-credentials", network, `${account}.json`), "utf8")) as { private_key: string }).private_key;
const envFile = (path: string) => Object.fromEntries(readFileSync(join(root, path), "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)=\s*([^#\s]*)/)).filter(Boolean).map((m) => [m![1], m![2]]));
const dotEnv = envFile(".env");
const webEnv = envFile("apps/web/.env.local");
const demo = JSON.parse(readFileSync(join(root, "scripts/.demo-state.json"), "utf8")) as { contract: string; relayer: string };
const FUNDER = "mintent-dev-mw21w9ki.testnet";
// The Keeper runs only where its account exists. Mainnet's is created separately, after approval.
const keeperVars = (network: string, account: string): Record<string, string> => {
  try {
    // Only the function-call key from restrict-keeper-key.ts goes to the server; the full-access key stays on this machine.
    return { KEEPER_ACCOUNT: account, KEEPER_PRIVATE_KEY: key(network, `${account}.function-call`) };
  } catch {
    console.log(`no function-call key for ${account} (run restrict-keeper-key.ts): the ${network} relayer runs without a Keeper`);
    return {};
  }
};
if (!/mainnet/i.test(dotEnv.SOLANA_RPC_URL ?? "")) throw new Error("SOLANA_RPC_URL in .env should be your mainnet Helius URL");

const services: Record<string, Record<string, string>> = {
  "relayer-testnet": {
    RAILWAY_DOCKERFILE_PATH: "deploy/relayer.Dockerfile",
    PORT: "8080",
    NEAR_NETWORK: "testnet",
    MINTENT_CONTRACT_ID: demo.contract,
    RELAYER_ACCOUNT: demo.relayer,
    RELAYER_PRIVATE_KEY: key("testnet", demo.relayer),
    DEMO_FUNDER: FUNDER,
    DEMO_FUNDER_PRIVATE_KEY: key("testnet", FUNDER),
    RELAYER_DB: "/data/relayer.sqlite",
    WEB_ORIGIN: webTestnet,
    ...keeperVars("testnet", "keeper.mintent-dev-mw21w9ki.testnet"),
  },
  "relayer-mainnet": {
    RAILWAY_DOCKERFILE_PATH: "deploy/relayer.Dockerfile",
    PORT: "8080",
    NEAR_NETWORK: "mainnet",
    MINTENT_CONTRACT_ID: "mintent.xinju.near",
    RELAYER_ACCOUNT: "relayer.xinju.near",
    RELAYER_PRIVATE_KEY: key("mainnet", "relayer.xinju.near"),
    SOLANA_RPC_URL: dotEnv.SOLANA_RPC_URL,
    ...(dotEnv.ONECLICK_JWT ? { ONECLICK_JWT: dotEnv.ONECLICK_JWT } : {}),
    RELAYER_DB: "/data/relayer.sqlite",
    WEB_ORIGIN: webMainnet,
    ...keeperVars("mainnet", "keeper.xinju.near"),
  },
  "web-testnet": {
    RAILWAY_DOCKERFILE_PATH: "deploy/web.Dockerfile",
    PORT: "8080",
    VITE_PRIVY_APP_ID: webEnv.VITE_PRIVY_APP_ID,
    VITE_RELAYER_URL: relayerTestnet,
    VITE_MINTENT_CONTRACT: demo.contract,
    VITE_MAINNET_URL: webMainnet,
  },
  "web-mainnet": {
    RAILWAY_DOCKERFILE_PATH: "deploy/web.Dockerfile",
    PORT: "8080",
    VITE_PRIVY_APP_ID: webEnv.VITE_PRIVY_APP_ID,
    VITE_RELAYER_URL: relayerMainnet,
    VITE_MINTENT_CONTRACT: "mintent.xinju.near",
    VITE_TESTNET_URL: webTestnet,
  },
};

const dir = join(root, "deploy/.railway");
mkdirSync(dir, { recursive: true, mode: 0o700 });
for (const [name, vars] of Object.entries(services)) {
  const missing = Object.entries(vars).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`${name}: missing ${missing.join(", ")}`);
  const file = join(dir, `${name}.env`);
  writeFileSync(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  console.log(`wrote deploy/.railway/${name}.env: ${Object.keys(vars).join(", ")}`);
}
console.log("Paste each file into its service's Variables > Raw Editor. The relayer files contain private keys: don't share them.");
