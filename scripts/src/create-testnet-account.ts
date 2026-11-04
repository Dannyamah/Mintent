// Creates a throwaway NEAR testnet dev account via the public faucet helper.
// Key is stored in ~/.near-credentials/testnet/<account>.json (never in the repo).
import { KeyPair } from "near-api-js";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const accountId = process.argv[2] ?? `mintent-dev-${Date.now().toString(36)}.testnet`;
const dir = join(homedir(), ".near-credentials", "testnet");
const file = join(dir, `${accountId}.json`);
if (existsSync(file)) throw new Error(`credentials already exist: ${file}`);

const kp = KeyPair.fromRandom("ed25519");
const res = await fetch("https://helper.nearprotocol.com/account", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: kp.getPublicKey().toString() }),
});
const body = await res.text();
if (!res.ok) throw new Error(`faucet helper ${res.status}: ${body.slice(0, 500)}`);
mkdirSync(dir, { recursive: true });
writeFileSync(file, JSON.stringify({ account_id: accountId, public_key: kp.getPublicKey().toString(), private_key: kp.toString() }), { mode: 0o600 });
console.log(JSON.stringify({ accountId, credentials: file }));
