// Create the Keeper's own NEAR account as a sub-account, funded from its parent, and save its key to ~/.near-credentials.
// Mainnet spends real NEAR, so it needs approval first. Never prints the key.
// Usage: tsx src/create-keeper-account.ts <testnet|mainnet> <parent-account> <near-amount>
import { KeyPair, nearToYocto } from "near-api-js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAccount, type NearNetwork } from "@mintent/shared";

const [network, parent, amount] = process.argv.slice(2) as [NearNetwork, string, string];
if (!["testnet", "mainnet"].includes(network) || !parent || !Number(amount)) throw new Error("usage: create-keeper-account <testnet|mainnet> <parent> <near-amount>");
const accountId = `keeper.${parent}`;
const dir = join(homedir(), ".near-credentials", network);
const file = join(dir, `${accountId}.json`);
if (existsSync(file)) throw new Error(`${file} already exists`);

const key = KeyPair.fromRandom("ed25519");
mkdirSync(dir, { recursive: true });
// Save before creating, so a crash can't leave an account nobody holds the key to.
writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: key.getPublicKey().toString(), private_key: key.toString() }), { mode: 0o600 });
const created = await loadAccount(network, parent).createSubAccount({ accountOrPrefix: accountId, publicKey: key.getPublicKey(), nearToTransfer: nearToYocto(Number(amount)) } as never);
console.log(`created ${accountId} with ${amount} NEAR: ${(created as { transaction?: { hash: string } }).transaction?.hash ?? "ok"}`);
