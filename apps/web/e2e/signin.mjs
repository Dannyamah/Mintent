// Every way in and out, in a real browser with Privy's real service: connecting a wallet (a throwaway Ethereum wallet injected
// the way MetaMask injects itself, signing Privy's real sign-in message), the test account, and sign-out for each.
// Usage: node e2e/signin.mjs <outDir> [appUrl]
import { chromium } from "playwright-core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const [out, url = "http://localhost:5173/"] = process.argv.slice(2);
const wallet = privateKeyToAccount(generatePrivateKey());
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(m.text().slice(0, 300)));
const ok = (name) => console.log(`ok  ${name}`);
const acct = page.locator(".acct__id");
const accountId = () => acct.getAttribute("data-account");
const signInBtn = page.getByRole("button", { name: "Sign in", exact: true });
const signOut = async () => {
  await page.locator(".acct__btn").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await signInBtn.waitFor({ timeout: 20000 });
};

await page.exposeFunction("__personalSign", (hex) => wallet.signMessage({ message: { raw: hex } }));
await page.addInitScript((address) => {
  const provider = {
    isMetaMask: true,
    on() {},
    removeListener() {},
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [address];
      if (method === "wallet_requestPermissions") return [{ parentCapability: "eth_accounts" }];
      if (method === "eth_chainId") return "0x1";
      if (method === "net_version") return "1";
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      if (method === "personal_sign") return window.__personalSign(params[0]);
      throw new Error(`unsupported ${method}`);
    },
  };
  window.ethereum = provider;
  const info = { uuid: "7f3e2c1a-0000-4000-8000-000000000001", name: "MetaMask", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "io.metamask" };
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: Object.freeze({ info, provider }) }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
}, wallet.address);

try {
  // A test account can sign out, and comes back as the same account with its key intact.
  await page.goto(url);
  await signInBtn.click();
  await page.getByRole("button", { name: "Create my test account" }).click();
  await acct.waitFor();
  const testId = await accountId();
  await signOut();
  await page.reload();
  await signInBtn.waitFor({ timeout: 20000 });
  ok("a test account can sign out, and stays signed out after a reload");
  await signInBtn.click();
  await page.getByRole("button", { name: "Continue with my test account" }).click();
  await acct.waitFor();
  if ((await accountId()) !== testId) throw new Error("the test account changed after signing back in");
  ok("signing back in returns the same test account");
  await signOut();

  // Connecting a wallet.
  await signInBtn.click();
  const connect = page.getByRole("button", { name: "Connect a wallet" });
  await connect.waitFor({ timeout: 45000 });
  await page.getByRole("button", { name: "Continue with email" }).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll(".sheet button")].some((b) => /Connect a wallet/.test(b.textContent) && !b.disabled), null, { timeout: 45000 });
  ok("the sign-in sheet offers both email and a wallet");
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/signin-sheet.png` });
  await connect.click();
  const metamask = page.getByRole("button", { name: /MetaMask/ }).first();
  await metamask.waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/signin-wallets.png` });
  ok("Privy lists the wallet it found");
  await metamask.click();
  await acct.waitFor({ timeout: 60000 });
  const id = await accountId();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`not an implicit account: ${id}`);
  if (id === testId) throw new Error("the wallet login reused the test account");
  ok(`signed in with wallet ${wallet.address}; NEAR account ${id}`);

  await page.locator(".acct__btn").click();
  await page.locator(".menu__login").waitFor();
  const shown = await page.locator(".menu__login").innerText();
  if (!shown.includes(wallet.address.slice(0, 6))) throw new Error(`menu doesn't name the wallet: ${shown}`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/signin-menu.png` });
  await page.keyboard.press("Escape");
  ok("the account menu names the wallet");

  await page.reload();
  await acct.waitFor({ timeout: 45000 });
  if ((await accountId()) !== id) throw new Error("account changed after reload");
  ok("the session and account survive a reload");

  // The checkout offers the signed-in wallet for refunds on a matching chain.
  await page.locator("#packs").scrollIntoViewIfNeeded();
  await page.locator(".pack-card .btn--primary").first().click();
  await page.waitForSelector(".asset");
  await page.locator(".assets__search input").fill("base");
  await page.locator(".asset", { hasText: "USDC" }).first().click();
  const refund = await page.locator("#refund").inputValue();
  if (refund.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`refund address wasn't filled in: ${refund}`);
  ok("checkout fills in the wallet as the refund address on a matching chain");
  await page.locator(".check input").check();
  await page.locator("#refund").fill("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
  await page.getByRole("button", { name: "Get payment details" }).click();
  await page.locator(".sheet .error").waitFor({ timeout: 20000 });
  if (!/doesn't look like a base address/i.test(await page.locator(".sheet .error").innerText())) throw new Error("wrong error for a bad refund address");
  ok("a refund address for the wrong chain is refused before any quote");
  await page.getByRole("button", { name: "Close" }).click();

  await signOut();
  ok("signing out of a wallet returns to signed out, even with a test key in this browser");
} catch (e) {
  problems.push(`FAILED: ${String(e).slice(0, 600)}`);
  await page.screenshot({ path: `${out}/signin-failure.png` }).catch(() => undefined);
}
await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "all clean");
process.exit(problems.length ? 1 : 0);
