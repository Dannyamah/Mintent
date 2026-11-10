// What a customer sees when a paid order is delayed. The relayer's answers are stood in for, because making a real order
// stick on purpose would need breaking the treasury. Recovery itself is covered by the relayer's tests and a live run.
// Usage: node e2e/stuck.mjs <outDir> [appUrl]
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const ok = (name) => console.log(`ok  ${name}`);
let failed = false;

const orderId = "stuck-order";
let state = "needs_attention";
let retries = 0;
await page.route(/:8787\/orders\/stuck-order\/retry$/, (r) => {
  retries++;
  state = "minted";
  return r.fulfill({ json: { ok: true, state } });
});
await page.route(/:8787\/owners\/[^/]+\/dashboard$/, async (r) => {
  const res = await r.fetch();
  const body = await res.json();
  body.active = [{ orderId, state, status: "SUCCESS", packType: "p", priceUnits: "25000000", createdAt: Date.now() - 600000, lastError: "treasury holds 0" }];
  return r.fulfill({ response: res, json: body });
});

try {
  await page.goto(`${url}#/dashboard`);
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await page.getByRole("button", { name: "Create my test account" }).click();
  const button = page.getByRole("button", { name: "Try again now" });
  await button.waitFor({ timeout: 20000 });
  const text = await page.locator(".active__item").first().innerText();
  if (!/Delayed/.test(text) || /treasury/.test(text)) throw new Error(`wrong message: ${text}`);
  ok("the dashboard says the order is delayed, without internal details");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${out}/stuck-dashboard.png` });

  await button.click();
  await page.waitForFunction(() => /Buying your pack/.test(document.querySelector(".active__item")?.textContent ?? ""), null, { timeout: 8000 });
  if (retries !== 1) throw new Error(`expected one retry, saw ${retries}`);
  if (await button.count()) throw new Error("the retry button stayed after the order resumed");
  ok("pressing it asks for one retry, and the order shows as moving again");
  await page.screenshot({ path: `${out}/stuck-resumed.png` });
} catch (e) {
  failed = true;
  console.log(`FAILED: ${String(e).slice(0, 500)}`);
  await page.screenshot({ path: `${out}/stuck-failure.png` }).catch(() => undefined);
}
await page.unrouteAll({ behavior: "ignoreErrors" });
await browser.close();
process.exit(failed ? 1 : 0);
