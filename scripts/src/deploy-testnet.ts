// Deploy the mintent contract to a testnet sub-account of the dev account and initialise it.
// Usage: tsx src/deploy-testnet.ts <dev-account.testnet> [prefix=app]
// Build first: (cd contracts/mintent && cargo near build non-reproducible-wasm)
import { KeyPair, nearToYocto } from "near-api-js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAccount, NETWORKS } from "./lib/mpc.js";

const dev = process.argv[2];
const prefix = process.argv[3] ?? "app";
if (!dev) throw new Error("usage: deploy-testnet <dev-account.testnet> [prefix]");
const contractId = `${prefix}.${dev}`;
const wasmPath = new URL("../../contracts/target/near/mintent/mintent.wasm", import.meta.url);
const credDir = join(homedir(), ".near-credentials", "testnet");
const credFile = join(credDir, `${contractId}.json`);

const devAccount = loadAccount("testnet", dev);
if (!existsSync(credFile)) {
  const kp = KeyPair.fromRandom("ed25519");
  await devAccount.createSubAccount({ accountOrPrefix: contractId, publicKey: kp.getPublicKey(), nearToTransfer: nearToYocto(Number(process.env.FUND_NEAR ?? 3.5)) } as never);
  mkdirSync(credDir, { recursive: true });
  writeFileSync(credFile, JSON.stringify({ account_id: contractId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
  console.log("created", contractId);
}
const contract = loadAccount("testnet", contractId);
const deployed = await contract.deployContract(readFileSync(wasmPath));
console.log("deployed", deployed.transaction.hash);
try {
  await contract.callFunction({
    contractId,
    methodName: "new",
    args: { owner_id: dev, relayer_id: dev, mpc_contract_id: NETWORKS.testnet.mpc },
  });
  console.log("initialised: owner = relayer =", dev);
} catch (e) {
  console.log("init skipped (already initialised?):", String(e).slice(0, 200));
}
console.log(JSON.stringify({ contractId }));
