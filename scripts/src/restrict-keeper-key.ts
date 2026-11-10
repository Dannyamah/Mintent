// Give the Keeper a function-call access key that can call only `keeper_sign` and `keeper_payout` on the Mintent contract, and
// prove on-chain that it can't do anything else. The hosted relayer then runs with this key only. The account's full-access
// key stays in ~/.near-credentials on the owner's machine, as the admin key, and never goes to the server.
// The new key is saved to ~/.near-credentials/<network>/<keeper>.function-call.json before it's added, and is never printed.
// Mainnet changes a real account, so it needs approval first.
// Usage: tsx src/restrict-keeper-key.ts <testnet|mainnet> <keeper-account> <contract>
import { Account, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadAccount, nearProvider, type NearNetwork } from "@mintent/shared";

const [network, keeperId, contract] = process.argv.slice(2) as [NearNetwork, string, string];
if (!["testnet", "mainnet"].includes(network) || !keeperId || !contract) throw new Error("usage: restrict-keeper-key <testnet|mainnet> <keeper-account> <contract>");
export const METHODS = ["keeper_sign", "keeper_payout"];
const ALLOWANCE = 250_000_000_000_000_000_000_000n; // 0.25 NEAR
const file = join(homedir(), ".near-credentials", network, `${keeperId}.function-call.json`);
const provider = nearProvider(network);

type Permission = "FullAccess" | { FunctionCall: { allowance: string | null; receiver_id: string; method_names: string[] } };
const permissionOf = async (publicKey: string) =>
  ((await provider.query({ request_type: "view_access_key", finality: "final", account_id: keeperId, public_key: publicKey } as never)) as unknown as { permission: Permission }).permission;

let key: KeyPair;
if (existsSync(file)) {
  key = KeyPair.fromString((JSON.parse(readFileSync(file, "utf8")) as { private_key: KeyPairString }).private_key);
  console.log(`using the function-call key already saved in ${file}`);
} else {
  key = KeyPair.fromRandom("ed25519");
  // Save before adding, so a crash can't leave a key on the account that nobody holds.
  writeFileSync(file, JSON.stringify({ account_id: keeperId, public_key: key.getPublicKey().toString(), private_key: key.toString() }), { mode: 0o600 });
}
const publicKey = key.getPublicKey().toString();

const existing = await permissionOf(publicKey).catch(() => null);
if (!existing) {
  const admin = loadAccount(network, keeperId);
  // The key can spend at most this much of the account's NEAR, on gas only. A Keeper call costs well under 0.01 NEAR. If it runs
  // out, the owner deletes this key file and runs the script again to add a fresh key.
  const r = await admin.addFunctionCallAccessKey({ publicKey, contractId: contract, methodNames: METHODS, allowance: ALLOWANCE });
  console.log(`added the function-call key: ${(r as { transaction?: { hash: string } }).transaction?.hash ?? "ok"}`);
}

let ok = true;
const check = (name: string, pass: boolean, detail = "") => {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  ok &&= pass;
};

let permission: Permission | null = null;
for (let i = 0; i < 20 && !permission; i++) {
  permission = await permissionOf(publicKey).catch(() => null);
  if (!permission) await new Promise((r) => setTimeout(r, 1500));
}
const fc = permission && permission !== "FullAccess" ? permission.FunctionCall : null;
check("the key is a function-call key, not a full-access key", Boolean(fc), JSON.stringify(permission));
check(`it can call only ${contract}`, fc?.receiver_id === contract, fc?.receiver_id);
check(`and only ${METHODS.join(" and ")}`, JSON.stringify([...(fc?.method_names ?? [])].sort()) === JSON.stringify([...METHODS].sort()), fc?.method_names.join(", "));

// Now try what a thief with this key would try. NEAR refuses each before it can run.
const thief = new Account(keeperId, provider, new KeyPairSigner(key));
const refused = async (name: string, attempt: () => Promise<unknown>, reason?: RegExp) => {
  try {
    await attempt();
    check(`refused: ${name}`, false, "it went through");
  } catch (e) {
    const why = String((e as Error).message ?? e).replace(/\s+/g, " ");
    check(`refused: ${name}`, !reason || reason.test(why), why.slice(0, 110));
  }
};
await refused("send the Keeper's NEAR to someone else", () => thief.transfer({ receiverId: contract, amount: 1n } as never));
await refused("add a full-access key to the account", () => thief.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey()));
await refused("transfer an NFT on the Mintent contract", () => thief.callFunction({ contractId: contract, methodName: "nft_transfer", args: { receiver_id: keeperId, token_id: "0" }, gas: 30_000_000_000_000n }), /does not allow method/i);
await refused("withdraw a card with the owner's method", () => thief.callFunction({ contractId: contract, methodName: "sign_for_card", args: { token_id: "0", payload_hex: "00" }, gas: 100_000_000_000_000n }), /does not allow method/i);
await refused("call any other contract", () => thief.callFunction({ contractId: network === "mainnet" ? "wrap.near" : "wrap.testnet", methodName: "near_deposit", args: {}, gas: 30_000_000_000_000n }));
// Allowed method, but nothing to sign: the contract itself refuses. This shows the key reaches the contract without a deposit.
await refused("a Keeper call for a token it has no permission on (the contract answers, not NEAR)", () => thief.callFunction({ contractId: contract, methodName: "keeper_sign", args: { token_id: "999999", payload_hex: "00" }, gas: 100_000_000_000_000n }), /no keeper/);

console.log(ok ? `\nthe Keeper can now run with ${file}: KEEPER_PRIVATE_KEY for the relayer` : "\nSOME CHECKS FAILED");
process.exit(ok ? 0 : 1);
