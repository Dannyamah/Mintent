// A compromised relayer against the real app, on real test networks. The browser's traffic to the relayer is altered so that
// the prepared message sends the card somewhere the owner never asked for. The app must refuse before signing: no signature,
// no lock on the NFT, and the card stays put. The honest action must then still work.
// Needs the relayer (with DEMO_FUNDER) and web app running. Usage: node e2e/tamper.mjs <outDir> [appUrl]
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/"] = process.argv.slice(2);
const API = "http://localhost:8787";
const OWNER_DESTINATION = "DP84tcSd3dsu7cPyHEuPA5CAsiWgNA1RArzyvhXEvJAr";
const ATTACKER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let failures = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

// Every call that asks NEAR to sign, so "nothing was signed" is observed and not assumed.
let signRequests = 0;
page.on("request", (r) => {
  const body = r.method() === "POST" ? (r.postData() ?? "") : "";
  if (/broadcast_tx|send_tx/.test(body)) signRequests++;
});

let tamperWithdraw = true;
await page.route(/:8787\/cards\/[^/]+\/withdraw-card$/, async (route) => {
  const body = route.request().postDataJSON();
  await route.continue({ postData: JSON.stringify(tamperWithdraw ? { ...body, destination: ATTACKER } : body) });
});

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
  const tokenId = page.url().split("/").pop();
  console.log(`token ${tokenId}`);

  await page.goto(`${url}#/card/${tokenId}`);
  await page.reload();
  await page.getByRole("button", { name: "Withdraw card to my wallet" }).click({ timeout: 60000 });
  await page.locator("#dest").fill(OWNER_DESTINATION);
  signRequests = 0;
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.locator(".error").first().waitFor({ timeout: 60000 });
  const message = await page.locator(".error").first().innerText();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/tamper-refused.png` });
  check("the app refuses a card transfer to an address the owner didn't choose", /We stopped this before signing/.test(message) && /different address/.test(message), message.slice(0, 130));
  check("nothing was sent to NEAR for signing", signRequests === 0, `${signRequests} transaction(s)`);

  const card = await (await fetch(`${API}/cards/${tokenId}`)).json();
  check("the NFT isn't locked", card.record.status === "Opened" && Number(card.locked_until_ms) === 0, `${card.record.status}, locked until ${card.locked_until_ms}`);
  check("the card hasn't moved", card.heldByToken === true);

  // The same action, untampered, goes through the same check and works.
  tamperWithdraw = false;
  await page.reload();
  await page.getByRole("button", { name: "Withdraw card to my wallet" }).click({ timeout: 60000 });
  await page.locator("#dest").fill(OWNER_DESTINATION);
  await page.getByRole("button", { name: "Confirm" }).click();
  await page.waitForSelector(".ok", { timeout: 4 * 60000 });
  const after = await (await fetch(`${API}/cards/${tokenId}`)).json();
  check("the honest withdrawal works, and the card reaches the owner's address", after.holder === OWNER_DESTINATION, after.holder);
} catch (e) {
  failures++;
  console.log(`  FAIL  ${String(e).slice(0, 600)}`);
  await page.screenshot({ path: `${out}/tamper-failure.png` }).catch(() => undefined);
}
await page.unrouteAll({ behavior: "ignoreErrors" });
await browser.close();
console.log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
