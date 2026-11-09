// Replace a deployed Mintent contract's code with contracts/res/mintent.wasm, keeping its state. Needs the contract account's own key.
// Checks the new code is the expected build, and that the existing state still reads afterwards. Mainnet needs approval first.
// Usage: tsx src/upgrade-contract.ts <testnet|mainnet> <contract-account> <expected-code-hash>
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import bs58 from "bs58";
import { loadAccount, nearProvider, type NearNetwork } from "@mintent/shared";

const [network, contractId, expectedHash] = process.argv.slice(2) as [NearNetwork, string, string];
if (!["testnet", "mainnet"].includes(network) || !contractId || !expectedHash) throw new Error("usage: upgrade-contract <testnet|mainnet> <contract> <expected-code-hash>");

const wasm = readFileSync(new URL("../../contracts/res/mintent.wasm", import.meta.url));
const hash = bs58.encode(createHash("sha256").update(wasm).digest());
if (hash !== expectedHash) throw new Error(`contracts/res/mintent.wasm hashes to ${hash}, expected ${expectedHash}`);

const provider = nearProvider(network);
const view = <T>(method: string, args: Record<string, unknown> = {}) => provider.callFunction({ contractId, method, args } as never) as unknown as Promise<T>;
const before = await view<{ next_token_id: number; owner_id: string }>("get_config");
const account = loadAccount(network, contractId);
const deployed = await account.deployContract(wasm);
console.log("upgraded:", deployed.transaction.hash);

const after = await view<{ next_token_id: number; owner_id: string }>("get_config");
// RPCs can answer from a block or two before the upgrade, so wait for the new code to show.
let state = { code_hash: "" };
for (let i = 0; i < 10 && state.code_hash !== expectedHash; i++) {
  if (i) await new Promise((r) => setTimeout(r, 2000));
  state = (await provider.query({ request_type: "view_account", finality: "final", account_id: contractId } as never)) as unknown as { code_hash: string };
}
const sample = before.next_token_id > 0 ? await view<{ token_id: string; keeper: unknown } | null>("get_card", { token_id: "0" }) : null;
console.log({ codeHash: state.code_hash, matches: state.code_hash === expectedHash, tokens: after.next_token_id, owner: after.owner_id, stateKept: after.next_token_id === before.next_token_id && after.owner_id === before.owner_id, token0Reads: sample ? "keeper" in sample : "no tokens" });
process.exit(state.code_hash === expectedHash && after.next_token_id === before.next_token_id ? 0 : 1);
