// One-click payment on real test networks: a throwaway wallet on Base Sepolia, injected the way MetaMask injects itself, signs in
// through Privy, then pays for a pack with the "Pay from your wallet" button. The wallet really sends the USDC: nothing is mocked
// except the extension's window, which forwards every request to a real Base Sepolia wallet.
// Needs the relayer and web app running, and a funder with test USDC. Usage: node e2e/onepay.mjs <outDir> [appUrl] [relayerUrl]
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const [out, url = "http://localhost:5173/", api = "http://localhost:8787"] = process.argv.slice(2);
const account = privateKeyToAccount(generatePrivateKey()); // test tokens only, for this run
const pub = createPublicClient({ chain: baseSepolia, transport: http() });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });
const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${m}`);
let failures = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`       ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

log(`funding ${account.address} on Base Sepolia with test USDC and gas`);
execFileSync("npx", ["tsx", "src/fund-base-wallet.ts", "mintent-dev-mw21w9ki.testnet", account.address, "26500000"], { cwd: new URL("../../../scripts/", import.meta.url).pathname, stdio: "inherit" });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const sent = [];
await page.exposeFunction("__wallet", async (method, params) => {
  if (method === "personal_sign") return account.signMessage({ message: { raw: params[0] } });
  if (method === "eth_sendTransaction") {
    const tx = params[0];
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined });
    sent.push(hash);
    return hash;
  }
  return pub.request({ method, params });
});
await page.addInitScript((address) => {
  let chainId = "0x1";
  const handlers = {};
  const emit = (event, value) => (handlers[event] ?? []).forEach((h) => h(value));
  const provider = {
    isMetaMask: true,
    on(event, h) { (handlers[event] ??= []).push(h); },
    removeListener(event, h) { handlers[event] = (handlers[event] ?? []).filter((x) => x !== h); },
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
      if (method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
      if (method === "eth_chainId") return chainId;
      if (method === "net_version") return String(parseInt(chainId, 16));
      if (method === "wallet_switchEthereumChain") {
        const next = params[0].chainId.toLowerCase();
        if (next !== "0x14a34" && next !== "0x1") throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        chainId = next;
        emit("chainChanged", chainId);
        return null;
      }
      if (method === "wallet_addEthereumChain") return null;
      if (method === "eth_sendTransaction" && chainId !== "0x14a34") throw new Error(`test wallet is on ${chainId}, not Base Sepolia`);
      return window.__wallet(method, params ?? []);
    },
  };
  window.ethereum = provider;
  const info = { uuid: "7f3e2c1a-0000-4000-8000-000000000002", name: "MetaMask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "io.metamask" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, account.address);

try {
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".sheet button")].some((b) => /Connect a wallet/.test(b.textContent) && !b.disabled), null, { timeout: 45000 });
  await page.getByRole("button", { name: "Connect a wallet" }).click();
  await page.getByRole("button", { name: /MetaMask/ }).first().click({ timeout: 20000 });
  await page.locator(".acct__id").waitFor({ timeout: 60000 });
  const buyer = await page.locator(".acct__id").getAttribute("data-account");
  log(`signed in with the wallet; NEAR account ${buyer}`);

  await page.locator("#packs").scrollIntoViewIfNeeded();
  await page.locator(".pack-card .btn--primary").first().click();
  await page.waitForSelector(".asset");
  await page.locator(".assets__search input").fill("base");
  await page.locator(".asset", { hasText: "USDC" }).first().click();
  check("the refund address is the connected wallet", (await page.locator("#refund").inputValue()).toLowerCase() === account.address.toLowerCase());
  await page.locator(".check input").check();
  await page.getByRole("button", { name: "Get payment details" }).click();
  const pay = page.getByRole("button", { name: /from your wallet/ });
  await pay.waitFor({ timeout: 60000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/onepay-button.png` });
  check("checkout offers to pay straight from the connected wallet", true, await pay.innerText());
  const deposit = await page.locator(".pay__addr code").first().getAttribute("title");

  await pay.click();
  for (let i = 0; i < 90 && !sent.length; i++) await page.waitForTimeout(1000); // the wallet signs and broadcasts
  const receipt = sent[0] ? await pub.waitForTransactionReceipt({ hash: sent[0] }) : null;
  check("the wallet sent the payment on Base Sepolia", receipt?.status === "success", sent[0] ? `https://sepolia.basescan.org/tx/${sent[0]}` : "nothing sent");
  check("to the checkout's deposit address", receipt?.logs?.some((l) => l.topics?.[2]?.toLowerCase().endsWith(deposit.slice(2).toLowerCase())), deposit);

  await Promise.race([
    page.waitForURL(/#\/reveal\//, { timeout: 8 * 60000 }),
    page.locator(".sheet .error").waitFor({ timeout: 8 * 60000 }).then(async () => { throw new Error(`order failed: ${await page.locator(".sheet .error").innerText()}`); }),
  ]);
  const tokenId = page.url().split("/").pop();
  const order = await (await fetch(`${api}/orders/${deposit}`)).json();
  check("the payment became a card, owned by the wallet user's NEAR account", order.state === "complete" && order.buyer === buyer, `token ${tokenId}`);
  check("no page errors", errors.length === 0, errors.join("; "));
} catch (e) {
  failures++;
  console.log(`       FAIL  ${String(e).slice(0, 600)}`);
  await page.screenshot({ path: `${out}/onepay-failure.png` }).catch(() => undefined);
}
await browser.close();
console.log(failures ? `\n${failures} FAILED in ${((Date.now() - started) / 60000).toFixed(1)} min` : `\nALL PASSED in ${((Date.now() - started) / 60000).toFixed(1)} min`);
process.exit(failures ? 1 : 0);
