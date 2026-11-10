// Sign in with a Solana wallet (registered through the Wallet Standard, as Jupiter, Phantom and Solflare do) through Privy's real
// service. Prints Privy's sign-in requests so a failure shows its real reason. Usage: node e2e/solsignin.mjs <outDir> [appUrl]
import { generateKeyPairSync, sign } from "node:crypto";
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/"] = process.argv.slice(2);
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (b) => { let n = 0n; for (const x of b) n = (n << 8n) + BigInt(x); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of b) { if (x) break; s = "1" + s; } return s; };
const address = base58(pub);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text().slice(0, 300)}`));
page.on("response", async (r) => {
  if (/privy\.io\/api\/v1\/(siws|siwe|users|sessions)/.test(r.url())) console.log(`privy ${r.request().method()} ${r.url().replace(/^.*api\/v1/, "")} -> ${r.status()} ${r.status() >= 400 ? (await r.text().catch(() => "")).slice(0, 300) : ""}`);
});
await page.exposeFunction("__solSign", (hex) => sign(null, Buffer.from(hex, "hex"), privateKey).toString("hex"));
await page.addInitScript(({ address, pubHex }) => {
  const bytes = new Uint8Array(pubHex.match(/../g).map((h) => parseInt(h, 16)));
  const chains = ["solana:mainnet", "solana:devnet", "solana:testnet"];
  const account = { address, publicKey: bytes, chains, features: ["solana:signMessage", "solana:signTransaction", "solana:signAndSendTransaction"] };
  const listeners = {};
  const toHex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
  const fromHex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
  const wallet = {
    version: "1.0.0", name: "Jupiter", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=", chains, accounts: [],
    features: {
      "standard:connect": { version: "1.0.0", connect: async () => { wallet.accounts = [account]; (listeners.change ?? []).forEach((f) => f({ accounts: wallet.accounts })); return { accounts: wallet.accounts }; } },
      "standard:disconnect": { version: "1.0.0", disconnect: async () => { wallet.accounts = []; } },
      "standard:events": { version: "1.0.0", on: (e, f) => { (listeners[e] ??= []).push(f); return () => {}; } },
      "solana:signMessage": { version: "1.0.0", signMessage: async (...inputs) => Promise.all(inputs.map(async ({ message }) => ({ signedMessage: message, signature: fromHex(await window.__solSign(toHex(message))) }))) },
      "solana:signTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signTransaction: async () => { throw new Error("not in this test"); } },
      "solana:signAndSendTransaction": { version: "1.0.0", supportedTransactionVersions: ["legacy", 0], signAndSendTransaction: async () => { throw new Error("not in this test"); } },
    },
  };
  const register = (cb) => cb({ register: () => () => {} }) ;
  const api = { register: (...ws) => { ws; return () => {}; } };
  window.addEventListener("wallet-standard:app-ready", ({ detail }) => detail.register(wallet));
  window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { bubbles: false, cancelable: false, detail: ({ register }) => register(wallet) }));
  void register; void api;
}, { address, pubHex: pub.toString("hex") });

let ok = false;
try {
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".sheet button")].some((b) => /Connect a wallet/.test(b.textContent) && !b.disabled), null, { timeout: 45000 });
  await page.getByRole("button", { name: "Connect a wallet" }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/sol-list.png` });
  await page.getByRole("button", { name: /Jupiter/ }).first().click({ timeout: 20000 });
  await page.waitForTimeout(1500);
  const more = page.getByRole("button", { name: /^Solana$/ });
  if (await more.count()) await more.first().click();
  const r = await Promise.race([
    page.locator(".acct__id").waitFor({ timeout: 60000 }).then(() => "signed in"),
    page.getByText("Could not log in with wallet").waitFor({ timeout: 60000 }).then(() => "Could not log in with wallet"),
  ]).catch((e) => String(e).slice(0, 200));
  console.log(`result: ${r}`);
  ok = r === "signed in";
  if (ok) console.log(`NEAR account ${await page.locator(".acct__id").getAttribute("data-account")}`);
} catch (e) { console.log(`error ${String(e).slice(0, 400)}`); }
await page.screenshot({ path: `${out}/sol-result.png` });
console.log(errors.slice(0, 8).join("\n"));
await browser.close();
process.exit(ok ? 0 : 1);
