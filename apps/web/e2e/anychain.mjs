// Any-chain money on real test networks, through the app's real screens: buy one pack from NEAR and one with a deposit sent
// from a throwaway wallet on Base Sepolia, sell both back, then cash out to USDC on Base and USDC on NEAR.
// Needs the relayer (with DEMO_FUNDER) and web app running. Usage: node e2e/anychain.mjs <outDir> [appUrl]
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";
import { createPublicClient, createWalletClient, erc20Abi, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const [out, url = "http://localhost:5173/"] = process.argv.slice(2);
const API = "http://localhost:8787";
const NEAR_RPC = "https://rpc.testnet.near.org";
const NEAR_USDC = "usdc.tidepool-sandbox.testnet";
const NEAR_RECIPIENT = "mintent-dev-mw21w9ki.testnet"; // the test funder, so this test money gets reused
const BASE_RECIPIENT = `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const BASE_USDC = "0x38d81431b9f76d9699af7517040d5221d9dea252";
const payer = privateKeyToAccount(generatePrivateKey()); // lives only for this run, and holds test tokens only
const base = createPublicClient({ chain: baseSepolia, transport: http() });
const baseWallet = createWalletClient({ account: payer, chain: baseSepolia, transport: http() });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${m}`);
let failures = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`       ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));

async function nearUsdc(account) {
  const args = Buffer.from(JSON.stringify({ account_id: account })).toString("base64");
  const r = await fetch(NEAR_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "query", params: { request_type: "call_function", finality: "final", account_id: NEAR_USDC, method_name: "ft_balance_of", args_base64: args } }) });
  return BigInt(JSON.parse(Buffer.from((await r.json()).result.result).toString()));
}

async function waitForCard() {
  await Promise.race([
    page.waitForURL(/\/open\//, { timeout: 8 * 60000 }),
    page.locator(".sheet .error").waitFor({ timeout: 8 * 60000 }).then(async () => { throw new Error(`order failed: ${await page.locator(".sheet .error").first().innerText()}`); }),
  ]);
  return page.url().split("/").pop();
}

async function openCheckout() {
  await page.goto(url);
  await page.waitForSelector(".pack-card");
  await page.locator("#packs").scrollIntoViewIfNeeded();
  await page.locator(".pack-card .btn--primary").first().click();
  await page.waitForSelector(".asset");
  await page.waitForTimeout(600);
}

async function sellBack(tokenId) {
  await page.goto(`${url}#/card/${tokenId}`);
  await page.getByRole("button", { name: "Sell back for USDC" }).click({ timeout: 60000 });
  await page.getByRole("button", { name: "Confirm" }).waitFor({ timeout: 60000 });
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.waitForSelector(".ok", { timeout: 4 * 60000 });
}

/** Cash out what the NFT holds. Returns the amount shown in the quote's text. */
async function cashOut(tokenId, chainSearch, recipient, name) {
  await page.goto(`${url}#/card/${tokenId}`);
  await page.reload();
  await page.getByRole("button", { name: /^Cash out \$/ }).click({ timeout: 60000 });
  await page.waitForFunction(() => document.querySelectorAll(".confirm .asset").length > 1, null, { timeout: 20000 });
  await page.locator(".confirm .assets__search input").fill(chainSearch);
  await page.locator(".confirm .asset", { hasText: "USDC" }).first().click();
  await page.locator("#dest").fill(recipient);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}-pick.png`, fullPage: true });
  await page.getByRole("button", { name: "Get quote" }).click();
  await page.locator('[data-cashout="quote"]').waitFor({ timeout: 60000 });
  await page.screenshot({ path: `${out}/${name}-quote.png` });
  const quote = await page.locator('[data-cashout="quote"]').innerText();
  await page.getByRole("button", { name: "Confirm" }).click();
  const swapping = page.locator('[data-cashout="swapping"], [data-cashout="delivered"], [data-cashout="refunded"]');
  await swapping.first().waitFor({ timeout: 4 * 60000 });
  await page.screenshot({ path: `${out}/${name}-swapping.png` });
  await page.locator('[data-cashout="delivered"], [data-cashout="refunded"]').first().waitFor({ timeout: 6 * 60000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}-done.png` });
  return { quote, delivered: await page.locator('[data-cashout="delivered"]').count() === 1, result: await page.locator('[data-cashout="delivered"], [data-cashout="refunded"]').first().innerText() };
}

try {
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Create my test account" }).click();
  await page.waitForSelector(".acct");
  const buyer = await page.locator(".acct__id").getAttribute("data-account");
  log(`buyer ${buyer}`);

  // SKIP_BASE_PAYMENT: only the NEAR-paid pack and its cash-out, when test USDC is short.
  if (!process.env.SKIP_BASE_PAYMENT) {
  log(`Funding a throwaway Base Sepolia wallet, ${payer.address}`);
  execFileSync("npx", ["tsx", "src/fund-base-wallet.ts", NEAR_RECIPIENT, payer.address, "26500000"], { cwd: new URL("../../../scripts/", import.meta.url).pathname, stdio: "inherit" });

  log("Pack 1: paid from Base Sepolia, with the checkout's real deposit address");
  await openCheckout();
  await page.locator(".assets__search input").fill("base");
  await page.locator(".asset", { hasText: "USDC" }).first().click();
  await page.locator("#refund").fill(payer.address);
  await page.locator(".check input").check();
  await page.screenshot({ path: `${out}/pay-base-details.png` });
  await page.getByRole("button", { name: "Get payment details" }).click();
  const code = page.locator(".pay__addr code").first();
  await code.waitFor({ timeout: 60000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/pay-base-qr.png` });
  const deposit = await code.getAttribute("title");
  check("checkout shows a deposit address and QR code", (await page.locator(".qr").count()) === 1 && /^0x[0-9a-fA-F]{40}$/.test(deposit), deposit);
  check("the test shortcut isn't offered for a coin on another chain", (await page.getByRole("button", { name: "Pay with test USDC" }).count()) === 0);
  const orders = await (await fetch(`${API}/orders/${deposit}`)).json();
  log(`Sending ${Number(orders.amount_in) / 1e6} USDC on Base Sepolia to the deposit address`);
  const hash = await baseWallet.writeContract({ address: BASE_USDC, abi: erc20Abi, functionName: "transfer", args: [deposit, BigInt(orders.amount_in)] });
  const receipt = await base.waitForTransactionReceipt({ hash });
  check("the payment landed on Base Sepolia", receipt.status === "success", `https://sepolia.basescan.org/tx/${hash}`);
  const token1 = await waitForCard();
  const order1 = await (await fetch(`${API}/orders/${deposit}`)).json();
  check("a payment from Base produced a card, with no test shortcut", order1.state === "complete" && order1.buyer === buyer, `token ${token1}`);
  check("settlement was proven on-chain", Boolean(order1.settle_tx), order1.settle_tx);
  const owner1 = (await (await fetch(`${API}/cards/${token1}`)).json()).owner_id;
  check("the NFT belongs to the buyer, not the paying wallet", owner1 === buyer);

  log("Selling pack 1 back");
  await sellBack(token1);

  const before = await nearUsdc(NEAR_RECIPIENT);
  log(`Cashing out token ${token1} to USDC on NEAR, ${NEAR_RECIPIENT}`);
  const near = await cashOut(token1, "near", NEAR_RECIPIENT, "cashout-near");
  check("the quote names the coin, chain and recipient before signing", /USDC/.test(near.quote) && /NEAR/.test(near.quote) && near.quote.includes(NEAR_RECIPIENT), near.quote.replace(/\s+/g, " ").slice(0, 170));
  check("cash-out to NEAR delivered", near.delivered, near.result.replace(/\s+/g, " "));
  await page.waitForTimeout(3000);
  const gained = (await nearUsdc(NEAR_RECIPIENT)) - before;
  check("the recipient's balance really rose on NEAR", gained > 0n, `+${Number(gained) / 1e6} USDC`);

  }

  if (process.env.ONE_CASH_OUT) {
    log("ONE_CASH_OUT is set, so stopping before the second pack, to save test USDC");
    await browser.close();
    console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED (one cash-out)");
    process.exit(failures ? 1 : 0);
  }

  log("Pack 2: paid with test USDC on NEAR");
  await openCheckout();
  await page.locator(".check input").check();
  await page.getByRole("button", { name: "Get payment details" }).click();
  await page.getByRole("button", { name: "Pay with test USDC" }).click({ timeout: 60000 });
  const token2 = await waitForCard();
  log(`token ${token2}; selling it back`);
  await sellBack(token2);

  const usdcOnBase = { address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [BASE_RECIPIENT] };
  log(`Cashing out token ${token2} to USDC on Base, ${BASE_RECIPIENT}`);
  const baseOut = await cashOut(token2, "base", BASE_RECIPIENT, "cashout-base");
  check("cash-out to Base delivered", baseOut.delivered, baseOut.result.replace(/\s+/g, " "));
  await page.waitForTimeout(3000);
  const received = await base.readContract(usdcOnBase);
  check("the recipient's balance really rose on Base Sepolia", received > 0n, `${Number(received) / 1e6} USDC at ${BASE_RECIPIENT}`);

  await page.goto(`${url}#/dashboard`);
  await page.waitForSelector(".activity li", { timeout: 30000 });
  await page.waitForTimeout(1500);
  const activity = (await page.locator(".activity li").allInnerTexts()).join(" | ").replace(/\n/g, " ");
  check("the dashboard's activity lists the cash-outs", /Cashed out .* to USDC on Base/.test(activity) && (process.env.SKIP_BASE_PAYMENT || /Cashed out .* to USDC on NEAR/.test(activity)), activity.slice(0, 220));
  await page.locator(".activity").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/dashboard.png` });
  check("no page errors", pageErrors.length === 0, pageErrors.join("; "));
} catch (e) {
  failures++;
  console.log(`       FAIL  ${String(e).slice(0, 700)}`);
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => undefined);
}
await browser.close();
console.log(failures ? `\n${failures} FAILED in ${((Date.now() - started) / 60000).toFixed(1)} min` : `\nALL PASSED in ${((Date.now() - started) / 60000).toFixed(1)} min`);
process.exit(failures ? 1 : 0);
