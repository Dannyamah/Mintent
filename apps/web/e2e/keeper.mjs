// The Keeper on real test networks, through the real app:
//   1. a permission with a payout and a minimum above the offer: the Keeper's own attacks on the contract must all fail;
//   2. hold mode: the Keeper must say it's holding, and not sell;
//   3. sell now: the Keeper sells, then pays the owner's address less the exit fee.
// Needs the relayer (with KEEPER_ACCOUNT and DEMO_FUNDER) and web app running. Usage: node e2e/keeper.mjs <outDir> [appUrl] [relayerUrl]
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/", api = "http://localhost:8787"] = process.argv.slice(2);
const SOLANA_RPC = "https://api.devnet.solana.com";
const USDC_DEV = "Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr";
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (b) => { let n = 0n; for (const x of b) n = (n << 8n) + BigInt(x); let s = ""; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } return s; };
const PAYOUT = base58(crypto.getRandomValues(new Uint8Array(32))); // a fresh address that holds nothing yet

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${m}`);
let failures = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`       ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const cardApi = async (id) => (await fetch(`${api}/cards/${id}`)).json();
const usdcAt = async (owner) => {
  const r = await fetch(SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner", params: [owner, { mint: USDC_DEV }, { encoding: "jsonParsed" }] }) });
  return ((await r.json()).result?.value ?? []).reduce((s, a) => s + Number(a.account.data.parsed.info.tokenAmount.amount), 0);
};
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));
const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await pred()) return true; await page.waitForTimeout(5000); } return false; };

async function setKeeper(id, { minimum, hold }) {
  await page.goto(`${url}#/card/${id}`);
  await page.reload();
  const panel = page.locator(".keeper");
  await panel.waitFor({ timeout: 60000 });
  if ((await panel.getAttribute("data-keeper")) === "on") {
    await page.getByRole("button", { name: "Turn off the Keeper" }).click();
    await page.waitForSelector('.keeper[data-keeper="off"]', { timeout: 60000 });
  }
  await page.locator(".kmode__opt", { hasText: hold ? "Wait for the deadline" : "Sell now" }).click();
  await page.getByRole("button", { name: "Change" }).click();
  await page.locator("#keeper-min").fill(minimum.toFixed(2));
  if (!hold) await page.locator(".kchip", { hasText: /^1 day$/ }).click();
  await page.locator(".kchip", { hasText: "Send it to my Solana wallet" }).click();
  await page.locator("#keeper-payout").fill(PAYOUT);
  const summary = await page.locator(".keeper__summary").innerText();
  check("the Keeper's one line of settings says what it will do", summary.includes(`at least $${minimum.toFixed(2)}`) && summary.includes("pays"), summary);
  await page.getByRole("button", { name: "Turn on the Keeper" }).click();
  await page.waitForSelector('.keeper[data-keeper="on"]', { timeout: 60000 });
}

try {
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Create my test account" }).click();
  await page.waitForSelector(".acct");
  await page.locator("#packs").scrollIntoViewIfNeeded();
  await page.locator(".pack-card .btn--primary").first().click();
  await page.waitForSelector(".asset");
  await page.locator(".check input").check();
  await page.getByRole("button", { name: "Get payment details" }).click();
  await page.getByRole("button", { name: "Pay with test USDC" }).click({ timeout: 60000 });
  await page.waitForURL(/\/open\//, { timeout: 8 * 60000 });
  const code = page.url().split("/").pop();
  check("the opening's address doesn't give the card away", /^[1-9A-HJ-NP-Za-km-z]{8}$/.test(code), page.url());
  let card = await cardApi(code);
  const id = card.token_id;
  const offer = card.offer?.amountUnits / 1e6;
  log(`token ${id}, offer $${offer}, payout address ${PAYOUT}`);

  log("1. A permission with a payout, minimum $5 above the offer. The Keeper attacks the contract with its real key");
  await setKeeper(id, { minimum: offer + 5, hold: false });
  card = await cardApi(id);
  check("the permission is on-chain, with the owner's payout address", card.keeper?.payout === PAYOUT, card.keeper?.agent);
  const attack = execFileSync("npx", ["tsx", "src/keeper-attack.ts", id], { cwd: new URL("../../../scripts/", import.meta.url).pathname, encoding: "utf8" });
  console.log(attack.split("\n").filter(Boolean).map((l) => `         ${l}`).join("\n"));
  check("all five attacks were refused on-chain", (attack.match(/^REFUSED/gm) ?? []).length === 5 && !/^SIGNED/m.test(attack));
  check("the card is still at the NFT's address", /card still at the NFT's address: true/.test(attack));

  log("2. Hold mode, minimum at the offer: the Keeper should say it's holding, and not sell");
  await setKeeper(id, { minimum: offer, hold: true });
  const holding = await waitFor(async () => /Holding your card/.test((await cardApi(id)).keeperStatus?.detail ?? ""), 90000);
  card = await cardApi(id);
  check("the Keeper explains it's holding until the offer's last day", holding, card.keeperStatus?.detail?.slice(0, 120));
  check("and it didn't sell", card.record.status === "Opened" && card.heldByToken);
  await page.reload();
  await page.locator(".keeper__status").waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${out}/keeper-holding.png`, fullPage: true });
  check("the owner sees the Keeper's reasoning on the card page", /Holding your card/.test(await page.locator(".keeper__status").innerText()));

  log("3. Sell now, with a payout: the Keeper should sell, then pay the owner");
  const before = await usdcAt(PAYOUT);
  await setKeeper(id, { minimum: offer, hold: false });
  const sold = await waitFor(async () => (await cardApi(id)).record.status === "Released", 4 * 60000);
  check("the Keeper sold the card back", sold);
  const paid = await waitFor(async () => (await usdcAt(PAYOUT)) > before, 4 * 60000);
  const received = (await usdcAt(PAYOUT)) - before;
  const fee = Math.max(Math.ceil(offer * 1e6 / 100), 250000);
  check("the owner's address received the sale, less exactly the exit fee", paid && received === Math.round(offer * 1e6) - fee, `$${received / 1e6} of $${offer}`);
  card = await cardApi(id);
  check("nothing is left in the NFT", Number(card.proceedsUnits) === 0, card.proceedsUnits);

  await page.goto(`${url}#/dashboard`);
  await page.waitForSelector(".activity li", { timeout: 30000 });
  await page.waitForTimeout(1500);
  const activity = (await page.locator(".activity li").allInnerTexts()).join(" | ").replace(/\n/g, " ");
  check("the owner's activity shows both the sale and the payout", /Your Keeper sold back/.test(activity) && /Your Keeper sent you/.test(activity), activity.slice(0, 160));
  await page.screenshot({ path: `${out}/keeper-paid.png` });
  check("no page errors", errors.length === 0, errors.join("; "));
} catch (e) {
  failures++;
  console.log(`       FAIL  ${String(e).slice(0, 600)}`);
  await page.screenshot({ path: `${out}/keeper-failure.png`, fullPage: true }).catch(() => undefined);
}
await browser.close();
console.log(failures ? `\n${failures} FAILED in ${((Date.now() - started) / 60000).toFixed(1)} min` : `\nALL PASSED in ${((Date.now() - started) / 60000).toFixed(1)} min`);
process.exit(failures ? 1 : 0);
