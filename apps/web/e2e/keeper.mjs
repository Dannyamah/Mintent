// The Keeper on real test networks, through the real app: buy a pack, turn the Keeper on with a minimum above the offer (it must
// wait, and its own attacks on the contract must fail), then lower the minimum and watch it sell for the owner.
// Needs the relayer (with KEEPER_ACCOUNT and DEMO_FUNDER) and web app running. Usage: node e2e/keeper.mjs <outDir> [appUrl] [relayerUrl]
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/", api = "http://localhost:8787"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${m}`);
let failures = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`       ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const cardApi = async (id) => (await fetch(`${api}/cards/${id}`)).json();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

async function setKeeper(id, minimum) {
  await page.goto(`${url}#/card/${id}`);
  await page.reload();
  const panel = page.locator(".keeper");
  await panel.waitFor({ timeout: 60000 });
  if ((await panel.getAttribute("data-keeper")) === "on") {
    await page.getByRole("button", { name: "Turn off the Keeper" }).click();
    await page.waitForSelector('.keeper[data-keeper="off"]', { timeout: 60000 });
  }
  await page.locator("#keeper-min").fill(minimum.toFixed(2));
  await page.locator("#keeper-days").selectOption("1");
  await page.getByRole("button", { name: "Turn on the Keeper" }).click();
  await page.waitForSelector('.keeper[data-keeper="on"]', { timeout: 60000 });
}

try {
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Create my test account" }).click();
  await page.waitForSelector(".acct");
  const owner = await page.locator(".acct__id").getAttribute("data-account");
  await page.locator("#packs").scrollIntoViewIfNeeded();
  await page.locator(".pack-card .btn--primary").first().click();
  await page.waitForSelector(".asset");
  await page.locator(".check input").check();
  await page.getByRole("button", { name: "Get payment details" }).click();
  await page.getByRole("button", { name: "Pay with test USDC" }).click({ timeout: 60000 });
  await page.waitForURL(/#\/reveal\//, { timeout: 8 * 60000 });
  const id = page.url().split("/").pop();
  log(`token ${id} for ${owner}`);

  let card = await cardApi(id);
  const offer = card.offer?.amountUnits / 1e6;
  check("Collector Crypt offers a sell-back", offer > 0, `$${offer}`);

  log("Keeper on, with a minimum $5 above the offer: it must wait");
  await setKeeper(id, offer + 5);
  await page.screenshot({ path: `${out}/keeper-on.png`, fullPage: true });
  card = await cardApi(id);
  check("the permission is on-chain, naming the Keeper", card.keeper?.agent?.startsWith("keeper."), card.keeper?.agent);

  log("The Keeper attacks the contract with its real key");
  const attack = execFileSync("npx", ["tsx", "src/keeper-attack.ts", id], { cwd: new URL("../../../scripts/", import.meta.url).pathname, encoding: "utf8" });
  console.log(attack.split("\n").filter(Boolean).map((l) => `         ${l}`).join("\n"));
  check("all three attacks were refused on-chain", (attack.match(/^REFUSED/gm) ?? []).length === 3 && !/^SIGNED/m.test(attack));
  check("the card is still at the NFT's address", /card still at the NFT's address: true/.test(attack));

  await page.waitForTimeout(40000); // more than a Keeper tick
  card = await cardApi(id);
  check("below the minimum, the Keeper didn't sell", card.record.status === "Opened" && card.heldByToken);

  log("Minimum lowered to the offer: the Keeper should sell");
  await setKeeper(id, offer);
  const soldBy = Date.now() + 4 * 60000;
  while (Date.now() < soldBy && (await cardApi(id)).record.status !== "Released") await page.waitForTimeout(5000);
  card = await cardApi(id);
  check("the Keeper sold the card back", card.record.status === "Released" && card.record.release_reason === "bought_back", card.record.status);
  check("the money is in the NFT's own address", Number(card.proceedsUnits) >= offer * 1e6, `$${Number(card.proceedsUnits) / 1e6}`);
  check("the permission ended with the sale", !card.keeper);

  await page.goto(`${url}#/dashboard`);
  await page.waitForSelector(".activity li", { timeout: 30000 });
  await page.waitForTimeout(1500);
  const activity = (await page.locator(".activity li").allInnerTexts()).join(" | ").replace(/\n/g, " ");
  check("the owner's activity says the Keeper sold it", /Your Keeper sold back/.test(activity), activity.slice(0, 120));
  await page.screenshot({ path: `${out}/keeper-sold.png` });
  check("no page errors", errors.length === 0, errors.join("; "));
} catch (e) {
  failures++;
  console.log(`       FAIL  ${String(e).slice(0, 600)}`);
  await page.screenshot({ path: `${out}/keeper-failure.png` }).catch(() => undefined);
}
await browser.close();
console.log(failures ? `\n${failures} FAILED in ${((Date.now() - started) / 60000).toFixed(1)} min` : `\nALL PASSED in ${((Date.now() - started) / 60000).toFixed(1)} min`);
process.exit(failures ? 1 : 0);
