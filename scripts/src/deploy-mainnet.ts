// Deploy the mintent contract to an existing mainnet account and initialise it. Spends real NEAR, so it needs approval first.
// Refuses to run unless the file is the same code tested on testnet, the account has no contract yet, and the names are right.
// Usage: tsx src/deploy-mainnet.ts <contract.near> <owner.near> <relayer.near> <expected-code-hash>
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { loadAccount, NETWORKS, nearProvider } from "@mintent/shared";

const [contractId, ownerId, relayerId, expectedHash] = process.argv.slice(2);
if (!contractId || !ownerId || !relayerId || !expectedHash) throw new Error("usage: deploy-mainnet <contract.near> <owner.near> <relayer.near> <expected-code-hash>");
for (const id of [contractId, ownerId, relayerId]) if (!id.endsWith(".near")) throw new Error(`${id} isn't a mainnet account`);

const wasm = readFileSync(new URL("../../contracts/res/mintent.wasm", import.meta.url));
const hash = bs58.encode(createHash("sha256").update(wasm).digest());
if (hash !== expectedHash) throw new Error(`the contract file's hash is ${hash}, expected ${expectedHash}`);

const provider = nearProvider("mainnet");
const empty = "11111111111111111111111111111111";
const view = (accountId: string) => provider.query({ request_type: "view_account", finality: "final", account_id: accountId } as never) as unknown as Promise<{ amount: string; code_hash: string; storage_usage: number }>;
const before = await view(contractId);
if (before.code_hash !== empty) throw new Error(`${contractId} already has a contract: ${before.code_hash}`);
await view(ownerId);
await view(relayerId);

const contract = loadAccount("mainnet", contractId);
const deployed = await contract.deployContract(wasm);
console.log("deployed:", deployed.transaction.hash);
const init = await contract.callFunctionRaw({ contractId, methodName: "new", args: { owner_id: ownerId, relayer_id: relayerId, mpc_contract_id: NETWORKS.mainnet.mpc } });
console.log("initialised:", init.transaction.hash);

const after = await view(contractId);
console.log({ codeHash: after.code_hash, matches: after.code_hash === expectedHash, balanceNear: Number(BigInt(after.amount) / 10n ** 21n) / 1000, storageBytes: after.storage_usage });
const config = await provider.callFunction({ contractId, method: "get_config", args: {} } as never);
console.log(JSON.stringify(config));
process.exit(after.code_hash === expectedHash ? 0 : 1);
