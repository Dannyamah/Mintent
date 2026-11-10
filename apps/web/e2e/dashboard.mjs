// Leave mid-order, then open the pack from the dashboard. On real test networks:
//   1. buy a pack, and leave checkout as soon as it's paid, as if the tab were closed;
//   2. the dashboard shows the order on its way, then offers the pack, sealed, to open;
//   3. the opening's address is a code that doesn't give the card away, and the card's page has a readable address;
//   4. old "#/card/<id>" links still land on the right card.
// Takes screenshots of the dashboard and the Keeper panel at desktop and phone sizes.
// Needs the relayer (with DEMO_FUNDER) and web app running. Usage: node e2e/dashboard.mjs <outDir> [appUrl] [relayerUrl]
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/", api = "http://localhost:8787"] = process.argv.slice(2);
const base = url.replace(/\/$/, "");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${m}`);
let failures = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`       ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 200)));

try {
  await page.goto(base + "/");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Create my test account" }).click();
  await page.waitForSelector(".acct");
  await page.locator(".pack-card .btn--primary").first().click();
  await page.waitForSelector(".asset");
  await page.locator(".check input").check();
  await page.getByRole("button", { name: "Get payment details" }).click();
  await page.getByRole("button", { name: "Pay with test USDC" }).click({ timeout: 60000 });
  await page.waitForTimeout(1500);
  log("paid; leaving checkout, as if the tab were closed");

  await page.goto(base + "/dashboard");
  check("plain paths work, with no # in the address", new URL(page.url()).pathname === "/dashboard" && !page.url().includes("#"), page.url());
  const onWay = await page.locator(".active__item").first().waitFor({ timeout: 60000 }).then(() => true, () => false);
  check("the dashboard shows the order on its way, with its progress", onWay && (await page.locator(".active__steps li").count()) >= 4);
  await page.screenshot({ path: `${out}/dash-on-the-way.png`, fullPage: true });

  const ready = await page.locator(".ready__item--fresh").first().waitFor({ timeout: 8 * 60000 }).then(() => true, () => false);
  check("once the card arrives, the dashboard offers the pack to open", ready, ready ? await page.locator(".ready__item--fresh").first().innerText() : "");
  check("the vault shows it sealed, so the card isn't spoiled", (await page.locator(".vault-card--fresh .vault-card__pack").count()) >= 1 && (await page.locator(".vault-card--fresh img").count()) === 0);
  const readyCode = (await page.locator(".ready__item--fresh").first().getAttribute("href")).split("/").pop();
  const hiddenName = (await (await fetch(`${api}/cards/${readyCode}`)).json()).name;
  const activityText = await page.locator(".activity").innerText();
  check("nothing on the dashboard names the card before it's opened", Boolean(hiddenName) && !activityText.includes(hiddenName) && !(await page.locator(".vault-grid").innerText()).includes(hiddenName), hiddenName);
  await page.screenshot({ path: `${out}/dash-ready-desktop.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${out}/dash-ready-phone.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.locator(".ready__item--fresh").first().click();
  await page.waitForURL(/\/open\//);
  const code = new URL(page.url()).pathname.split("/").pop();
  check("the opening's address is a short code, not the card's name or number", /^[1-9A-HJ-NP-Za-km-z]{8}$/.test(code), page.url());
  const tear = page.getByRole("button", { name: "Tear open your pack" });
  await tear.waitFor({ timeout: 60000 });
  await page.locator(".reveal__pack:not([disabled])").waitFor({ timeout: 60000 });
  await tear.click({ force: true });
  await page.getByRole("link", { name: "View your card" }).waitFor({ timeout: 15000 });
  await page.getByRole("link", { name: "View your card" }).click();
  await page.waitForURL(/\/cards\//);
  await page.waitForSelector(".keeper", { timeout: 60000 });
  const card = await (await fetch(`${api}/lookup/${code}`)).json();
  await page.waitForFunction((slug) => !slug || location.pathname === `/cards/${slug}`, card.slug, { timeout: 15000 }).catch(() => undefined);
  const path = new URL(page.url()).pathname;
  check("the card's page has a readable address", card.slug ? path === `/cards/${card.slug}` : path === `/cards/${code}`, path);
  check("and it doesn't show the token number", !new RegExp(`/${card.tokenId}$`).test(path));

  await page.goto(`${base}/dashboard`);
  await page.waitForSelector(".vault-card");
  check("after opening, the dashboard no longer offers it", (await page.locator(".ready__item--fresh").count()) === 0);

  await page.goto(`${base}/#/card/${card.tokenId}`);
  await page.waitForFunction((p) => location.pathname === p, path, { timeout: 30000 }).then(() => undefined, () => undefined);
  check("an old #/card/<id> link lands on the card's readable address", new URL(page.url()).pathname === path && !page.url().includes("#"), page.url());

  await page.locator(".keeper").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/keeper-off-desktop.png`, fullPage: true });
  await page.locator(".keeper").screenshot({ path: `${out}/keeper-off-panel.png` });
  check("the Keeper explains itself in one line", /sells this card back for you/i.test(await page.locator(".keeper__lede").innerText()));
  check(
    "turning it on needs no typing: today's offer is the minimum, and the money stays in the NFT",
    (await page.locator(".kmode__opt").count()) === 2 &&
      (await page.locator(".keeper input:not([type=radio]):visible").count()) === 0 &&
      !(await page.getByRole("button", { name: "Turn on the Keeper" }).isDisabled()) &&
      (await page.locator(".keeper__summary").innerText()).includes("at least $"),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".keeper").screenshot({ path: `${out}/keeper-off-phone.png` });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check("nothing overflows on a phone", !overflow);
  check("no page errors", errors.length === 0, errors.join("; "));
} catch (e) {
  failures++;
  console.log(`       FAIL  ${String(e).slice(0, 600)}`);
  await page.screenshot({ path: `${out}/dashboard-failure.png`, fullPage: true }).catch(() => undefined);
}
await browser.close();
console.log(failures ? `\n${failures} FAILED in ${((Date.now() - started) / 60000).toFixed(1)} min` : `\nALL PASSED in ${((Date.now() - started) / 60000).toFixed(1)} min`);
process.exit(failures ? 1 : 0);
