// Mainnet in a real browser, spending nothing and creating no orders: the app must show mainnet honestly, offer no test shortcuts,
// and stop before payment. Usage: node e2e/mainnet-smoke.mjs <outDir> [appUrl]
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5174/"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const problems = [];
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
let orders = 0;
page.on("request", (r) => {
  if (r.method() === "POST" && /\/orders/.test(r.url())) orders++;
});
const check = (name, pass, detail = "") => {
  if (!pass) problems.push(name);
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

try {
  await page.goto(url);
  await page.waitForSelector(".pack-card", { timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/mainnet-home.png` });
  check("a mainnet banner says real money", /real money/i.test(await page.locator(".banner--live").innerText().catch(() => "")));
  const tiles = await page.evaluate(() => [...document.querySelectorAll(".tile img")].filter((i) => i.complete && i.naturalWidth > 0).length);
  check("the wall shows real mainnet pulls", tiles > 0, `${tiles} images`);

  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Continue with email" }).waitFor({ timeout: 45000 });
  check("email sign-in is offered", true);
  check("wallet sign-in is offered", (await page.getByRole("button", { name: "Connect a wallet" }).count()) === 1);
  check("no test account on mainnet", (await page.getByRole("button", { name: /test account/ }).count()) === 0);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/mainnet-signin.png` });
  check("no orders were created", orders === 0, `${orders}`);
} catch (e) {
  problems.push(`FAILED: ${String(e).slice(0, 500)}`);
  await page.screenshot({ path: `${out}/mainnet-failure.png` }).catch(() => undefined);
}
await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "all clean");
process.exit(problems.length ? 1 : 0);
