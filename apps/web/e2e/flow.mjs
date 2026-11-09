// The whole product in a real browser, on real test networks, with two separate users:
// Ana buys a pack -> tears it open -> sees it on her dashboard -> gives the NFT to Ben -> Ben (who starts with no NEAR)
// sells it back and withdraws -> his dashboard shows the history -> Ana is locked out.
// Needs the relayer (with DEMO_FUNDER) and the web app running. Usage: node e2e/flow.mjs <outDir> [appUrl]
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const started = Date.now();
const log = (m) => console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${m}`);
let failures = 0;
const check = (name, pass, detail = "") => {
  if (!pass) failures++;
  console.log(`       ${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function user(name, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on("console", (m) => /wallet error/.test(m.text()) && console.log(`       ${name} console: ${m.text().slice(0, 400)}`));
  page.on("pageerror", (e) => {
    failures++;
    console.log(`       FAIL  ${name} page error: ${String(e).slice(0, 200)}`);
  });
  await page.goto(url, { waitUntil: "load" });
  return page;
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png` });
const signIn = async (page) => {
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await page.getByRole("button", { name: "Create my test account" }).click();
  await page.waitForSelector(".acct");
};
const dollars = (s) => Number(s.replace(/[^0-9.]/g, ""));

try {
  const ana = await user("Ana", { width: 1440, height: 900 });
  await ana.waitForSelector(".tile img");
  const wallStart = Date.now();
  await ana.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".tile img")];
    return imgs.length >= 28 && imgs.filter((i) => i.classList.contains("is-loaded")).length >= 26;
  }, null, { timeout: 30000 });
  const wallMs = Date.now() - wallStart;
  check("the wall's images load quickly", wallMs < 3000, `${wallMs} ms`);
  await ana.waitForTimeout(1800);
  const wall = await ana.evaluate(() => {
    const r = [...document.querySelectorAll(".tile")].map((t) => t.getBoundingClientRect());
    return { tiles: r.length, bottom: Math.max(...r.map((x) => x.bottom)), height: window.innerHeight };
  });
  check("the whole wall fits on the first screen", wall.bottom <= wall.height, `${wall.tiles} tiles, bottom ${Math.round(wall.bottom)} of ${wall.height}`);
  await shot(ana, "1-hero");

  log("Ana signs in and picks the cheapest pack");
  await signIn(ana);
  await ana.locator("#packs").scrollIntoViewIfNeeded();
  await ana.locator(".pack-card .btn--primary").first().click();
  await ana.waitForSelector(".asset");
  await ana.waitForTimeout(900);
  await shot(ana, "2-checkout");
  const blocked = await ana.getByRole("button", { name: "Get payment details" }).isDisabled();
  check("checkout is blocked until the 18+ box is ticked", blocked);
  await ana.locator(".check input").check();
  await ana.getByRole("button", { name: "Get payment details" }).click();
  await ana.getByRole("button", { name: "Pay with test USDC" }).waitFor({ timeout: 60000 });
  await ana.waitForTimeout(500);
  await shot(ana, "3-pay");
  log("Paying with test USDC through Tidepool");
  await ana.getByRole("button", { name: "Pay with test USDC" }).click();
  await ana.waitForSelector(".stepper");
  await ana.waitForTimeout(8000);
  await shot(ana, "4-progress");

  // Stop straight away if the app reports a failed order, rather than waiting out the whole timeout.
  await Promise.race([
    ana.waitForURL(/#\/reveal\//, { timeout: 8 * 60000 }),
    ana.locator(".sheet .error").waitFor({ timeout: 8 * 60000 }).then(async () => { throw new Error(`order failed: ${await ana.locator(".sheet .error").innerText()}`); }),
  ]);
  const tokenId = ana.url().split("/").pop();
  log(`Card delivered: token ${tokenId}. Ana tears the pack open.`);
  const readyStart = Date.now();
  const tear = ana.getByRole("button", { name: "Tear open your pack" });
  await tear.waitFor({ timeout: 30000 });
  check("the pack is ready to open quickly", Date.now() - readyStart < 4000, `${Date.now() - readyStart} ms`);
  await ana.waitForTimeout(1200);
  await shot(ana, "5a-sealed");
  await tear.click({ force: true }); // the sealed pack floats, so it never counts as "stable" for an automated click
  await ana.waitForSelector(".reveal__card img", { timeout: 5000 });
  await ana.waitForTimeout(350);
  await shot(ana, "5b-burst");
  await ana.getByRole("link", { name: "View your card" }).waitFor({ timeout: 5000 });
  await ana.waitForTimeout(2200);
  await shot(ana, "5c-revealed");
  const revealed = await ana.locator(".reveal__card img").evaluate((i) => i.complete && i.naturalWidth > 0);
  check("the revealed card image is really there", revealed);
  const revealValue = dollars(await ana.locator(".reveal__value").innerText());
  check("the reveal shows a real value", revealValue > 0, `$${revealValue}`);

  await ana.goto(`${url}#/dashboard`);
  await ana.waitForSelector(".vault-card img.is-loaded", { timeout: 30000 });
  await ana.waitForTimeout(1600);
  await shot(ana, "6-dashboard-ana");
  const vault = dollars(await ana.locator(".stat__big").innerText());
  check("Ana's vault value equals the card she pulled", Math.abs(vault - revealValue) < 0.01, `$${vault}`);
  check("Ana's activity shows the opening", (await ana.locator(".activity li").count()) >= 1);

  await ana.locator(".vault-card").first().click();
  await ana.waitForSelector(".slab img.is-loaded", { timeout: 30000 });
  await ana.waitForTimeout(1200);
  await shot(ana, "7-card");
  await ana.locator(".pill").waitFor();
  check("the proof panel says the NFT holds the card", (await ana.locator(".pill").innerText()) === "This NFT");
  check("Ana can act on her card", await ana.getByRole("button", { name: "Sell back for USDC" }).isVisible());

  log("Ben opens the app in his own browser. He has no NEAR.");
  const ben = await user("Ben", { width: 390, height: 844 });
  await signIn(ben);
  const benId = await ben.locator(".acct__id").getAttribute("data-account");

  log("Ana gives the NFT to Ben");
  await ana.getByRole("button", { name: "Transfer this NFT" }).click();
  await ana.locator("#dest").fill(benId);
  await ana.getByRole("button", { name: "Confirm" }).click();
  await ana.waitForSelector(".ok", { timeout: 120000 });
  check("Ana is told the card moved with the NFT", /new owner now controls/.test(await ana.locator(".ok").innerText()));
  check("Ana can no longer act on it", (await ana.getByRole("button", { name: "Sell back for USDC" }).count()) === 0);

  await ben.goto(`${url}#/card/${tokenId}`);
  await ben.waitForSelector(".proof");
  await ben.reload();
  await ben.getByRole("button", { name: "Sell back for USDC" }).waitFor({ timeout: 30000 });
  await ben.waitForTimeout(800);
  await shot(ben, "8-ben-card");

  log("Ben sells back");
  await ben.getByRole("button", { name: "Sell back for USDC" }).click();
  await ben.getByRole("button", { name: "Confirm" }).waitFor({ timeout: 60000 });
  const offer = await ben.locator(".confirm strong").innerText();
  await shot(ben, "9-offer");
  await ben.getByRole("button", { name: "Confirm" }).click();
  await ben.waitForSelector(".signing", { timeout: 10000 });
  await shot(ben, "9b-signing");
  await ben.waitForSelector(".ok", { timeout: 4 * 60000 });
  const soldText = await ben.locator(".ok").innerText();
  check("Ben sold the card back at the quoted price", soldText.includes(offer.split(" ")[0]), `offer ${offer}`);
  await shot(ben, "10-sold");

  await ben.goto(`${url}#/dashboard`);
  await ben.waitForSelector(".vault-card", { timeout: 30000 });
  await ben.waitForTimeout(1600);
  await shot(ben, "11-dashboard-ben-sold");
  const claimable = dollars(await ben.locator(".stat").nth(1).locator(".stat__num").innerText());
  check("Ben's dashboard shows the USDC to withdraw", Math.abs(claimable - dollars(offer)) < 0.01, `$${claimable}`);

  log("Ben withdraws the proceeds");
  await ben.locator(".vault-card").first().click();
  await ben.getByRole("button", { name: /^Cash out \$/ }).waitFor({ timeout: 30000 });
  await ben.getByRole("button", { name: /^Cash out \$/ }).click();
  await ben.locator("#dest").fill("DP84tcSd3dsu7cPyHEuPA5CAsiWgNA1RArzyvhXEvJAr");
  await ben.waitForTimeout(600);
  await shot(ben, "11b-cash-out-phone");
  await ben.getByRole("button", { name: "Confirm" }).click();
  await ben.waitForFunction(() => /on its way/.test(document.querySelector(".ok")?.textContent ?? ""), null, { timeout: 4 * 60000 });
  await shot(ben, "12-withdrawn");
  check("the withdrawal completed", true);

  await ben.goto(`${url}#/dashboard`);
  await ben.waitForSelector(".vault-card img.is-loaded", { timeout: 30000 });
  await ben.waitForTimeout(1600);
  await ben.locator(".activity").scrollIntoViewIfNeeded();
  await ben.waitForTimeout(700);
  await shot(ben, "13-dashboard-ben-activity");
  const titles = await ben.locator(".activity li").allInnerTexts();
  check("Ben's activity lists the sale and the withdrawal", titles.some((t) => /Sold back/.test(t)) && titles.some((t) => /Withdrew/.test(t)), titles.join(" | ").replace(/\n/g, " ").slice(0, 160));
  check("Ben's dashboard has nothing left to withdraw", dollars(await ben.locator(".stat").nth(1).locator(".stat__num").innerText()) === 0);
  const noScroll = await ben.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check("no sideways scrolling on a phone", noScroll);
} catch (e) {
  failures++;
  console.log(`       FAIL  ${String(e).slice(0, 600)}`);
  for (const [i, p] of browser.contexts().flatMap((c) => c.pages()).entries()) await p.screenshot({ path: `${out}/failure-${i}.png` }).catch(() => undefined);
}
await browser.close();
console.log(failures ? `\n${failures} FAILED in ${((Date.now() - started) / 60000).toFixed(1)} min` : `\nALL PASSED in ${((Date.now() - started) / 60000).toFixed(1)} min`);
process.exit(failures ? 1 : 0);
