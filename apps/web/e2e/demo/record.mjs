// Records the demo on the real hosted testnet site: frames from Chrome's own screencast (2560x1440, so zooms stay sharp), a visible cursor
// with click ripples, human pacing, and a marker at every beat for the edit. Real test transactions throughout.
// Usage: node e2e/demo/record.mjs <outDir> [appUrl] [relayerUrl]
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [out, url = "https://web-testnet-production-2eb9.up.railway.app/", api = "https://relayer-testnet-production.up.railway.app"] = process.argv.slice(2);
const base = url.replace(/\/$/, "");
mkdirSync(`${out}/frames`, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1.6 });
const page = await context.newPage();

// A cursor the viewer can follow, with a ripple on every click.
await context.addInitScript(() => {
  const install = () => {
    if (document.getElementById("demo-cursor")) return;
    const style = document.createElement("style");
    style.textContent = `#demo-cursor{position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transform:translate(-3px,-2px);transition:transform .08s;filter:drop-shadow(0 3px 6px rgba(0,0,0,.55))}
      .demo-ripple{position:fixed;z-index:2147483646;pointer-events:none;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;border:2px solid #7cf5c4;animation:demo-r .55s ease-out forwards}
      @keyframes demo-r{to{transform:scale(4.2);opacity:0}}`;
    document.documentElement.appendChild(style);
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.innerHTML = `<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8.2-6.4 1.6L8.4 18z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
    c.style.left = "-40px";
    document.documentElement.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX + "px"; c.style.top = e.clientY + "px"; }, true);
    addEventListener("mousedown", (e) => {
      c.style.transform = "translate(-3px,-2px) scale(.85)";
      const r = document.createElement("div");
      r.className = "demo-ripple";
      r.style.left = e.clientX + "px";
      r.style.top = e.clientY + "px";
      document.documentElement.appendChild(r);
      setTimeout(() => r.remove(), 600);
    }, true);
    addEventListener("mouseup", () => { c.style.transform = "translate(-3px,-2px)"; }, true);
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", install);
  else install();
});

// Screencast frames with their capture times.
const cdp = await context.newCDPSession(page);
const frames = [];
const markers = [];
const t0 = Date.now();
let n = 0;
cdp.on("Page.screencastFrame", async ({ data, sessionId, metadata }) => {
  const file = `f${String(n++).padStart(6, "0")}.jpg`;
  writeFileSync(`${out}/frames/${file}`, Buffer.from(data, "base64"));
  frames.push({ file, t: metadata.timestamp * 1000 - t0 });
  await cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
});
const startCast = () => cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 2560, maxHeight: 1440, everyNthFrame: 1 });
await startCast();
// A new document stops the screencast in some Chrome versions: restart it after each navigation.
page.on("framenavigated", (f) => { if (f === page.mainFrame()) void startCast().catch(() => undefined); });

const mark = (name) => { markers.push({ name, t: Date.now() - t0 }); console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${name}`); };
const wait = (ms) => page.waitForTimeout(ms);
let cursor = { x: 800, y: 450 };
async function moveTo(x, y, steps = 28) {
  await page.mouse.move(x, y, { steps });
  cursor = { x, y };
}
async function click(locator, { pause = 350 } = {}) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("nothing to click");
  await moveTo(box.x + box.width / 2, box.y + box.height / 2);
  await wait(pause);
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
}
async function type(locator, text) {
  await click(locator);
  await locator.fill("");
  await locator.pressSequentially(text, { delay: 28 });
}
async function scrollBy(dy, ms = 900) {
  await page.evaluate(([dy]) => window.scrollBy({ top: dy, behavior: "smooth" }), [dy]);
  await wait(ms);
}
async function scrollToEl(locator, offset = 120) {
  const y = await locator.evaluate((el, off) => el.getBoundingClientRect().top + window.scrollY - off, offset);
  await page.evaluate(([y]) => window.scrollTo({ top: y, behavior: "smooth" }), [y]);
  await wait(1100);
}
const cardApi = async (key) => (await fetch(`${api}/cards/${key}`)).json();

try {
  // 1. Home
  await page.goto(base + "/");
  await page.waitForFunction(() => document.querySelectorAll(".tile img.is-loaded").length >= 12, null, { timeout: 30000 }).catch(() => undefined);
  await moveTo(1000, 640, 5);
  await wait(800);
  mark("home");
  await wait(5500);
  await moveTo(660, 560, 40);
  await wait(1500);
  mark("home_end");

  // 2. Sign in
  await click(page.getByRole("button", { name: "Sign in", exact: true }));
  await page.getByRole("button", { name: "Create my test account" }).waitFor();
  mark("signin");
  await wait(1600);
  await click(page.getByRole("button", { name: "Create my test account" }));
  await page.waitForSelector(".acct");
  await wait(900);
  mark("signed_in");

  // 3. Packs and checkout
  await scrollToEl(page.locator("#packs"), 90);
  mark("packs");
  await wait(1800);
  await click(page.locator(".pack-card .btn--primary").first());
  await page.waitForSelector(".asset");
  await wait(900);
  mark("checkout");
  await wait(1200);
  const list = page.locator(".assets__list, .assets").first();
  await list.evaluate((el) => el.scrollBy({ top: 260, behavior: "smooth" })).catch(() => undefined);
  await wait(1500);
  await list.evaluate((el) => el.scrollTo({ top: 0, behavior: "smooth" })).catch(() => undefined);
  await wait(1000);
  await click(page.locator(".check input"));
  await wait(500);
  await click(page.getByRole("button", { name: "Get payment details" }));
  await page.getByRole("button", { name: "Pay with test USDC" }).waitFor({ timeout: 60000 });
  await wait(700);
  mark("quote");
  await wait(2600);
  await click(page.getByRole("button", { name: "Pay with test USDC" }));
  mark("paying");
  await page.waitForURL(/\/open\//, { timeout: 8 * 60000 });
  mark("reveal_page");
  const code = new URL(page.url()).pathname.split("/").pop();

  // 4. The reveal
  const tear = page.getByRole("button", { name: "Tear open your pack" });
  await tear.waitFor({ timeout: 60000 });
  const box = await tear.boundingBox();
  await moveTo(box.x + box.width / 2, box.y + box.height / 2, 35);
  await wait(1400);
  mark("tear");
  await page.mouse.down();
  await wait(90);
  await page.mouse.up();
  await page.getByRole("link", { name: "View your card" }).waitFor({ timeout: 20000 });
  mark("revealed");
  await wait(3200);

  // 5. The card page
  await click(page.getByRole("link", { name: "View your card" }));
  await page.waitForSelector(".proof", { timeout: 60000 });
  await page.waitForSelector(".slab img.is-loaded", { timeout: 30000 }).catch(() => undefined);
  await wait(800);
  mark("card");
  await wait(3500);
  await moveTo(1100, 470, 30);
  const transfer = page.getByRole("button", { name: /Transfer this NFT/ });
  if (await transfer.count()) {
    const b = await transfer.boundingBox();
    await moveTo(b.x + b.width / 2, b.y + b.height / 2, 30);
    mark("transfer");
    await wait(2200);
  }
  await scrollToEl(page.locator(".proof"), 110);
  mark("proof_panel");
  await wait(4200);

  // 6. The Keeper: one tap
  await scrollToEl(page.locator(".keeper"), 110);
  mark("keeper");
  await wait(2600);
  await click(page.getByRole("button", { name: "Turn on the Keeper" }));
  await page.waitForSelector('.keeper[data-keeper="on"]', { timeout: 90000 });
  mark("keeper_on");
  await wait(1200);
  // Its reasoning, then the sale. The page refreshes itself; reload if the status is slow to appear.
  const card = await cardApi(code);
  const tokenId = card.token_id;
  for (let i = 0; i < 40; i++) {
    const c = await cardApi(tokenId);
    if (c.keeperStatus || c.record.status !== "Opened") break;
    await wait(3000);
  }
  await page.reload();
  await page.waitForSelector(".keeper, .card-page__meta", { timeout: 30000 });
  await scrollToEl(page.locator(".keeper").first(), 110).catch(() => undefined);
  mark("keeper_thinking");
  await wait(3500);
  for (let i = 0; i < 60; i++) {
    const c = await cardApi(tokenId);
    if (c.record.status === "Released" && Number(c.proceedsUnits) > 0) break;
    await wait(3000);
  }
  await page.reload();
  await page.getByRole("button", { name: /^Cash out \$/ }).waitFor({ timeout: 60000 });
  await page.evaluate(() => window.scrollTo({ top: 0 }));
  await wait(600);
  mark("sold");
  await wait(3000);

  // 7. Cash out to another chain
  await click(page.getByRole("button", { name: /^Cash out \$/ }));
  await page.waitForFunction(() => document.querySelectorAll(".confirm .asset").length > 1, null, { timeout: 30000 });
  mark("cashout");
  await type(page.locator(".confirm .assets__search input"), "base");
  await wait(600);
  await click(page.locator(".confirm .asset", { hasText: "USDC" }).first());
  await type(page.locator("#dest"), "0x55528b52ab7000887f0bf1543c5b878c2cae66ca");
  await wait(500);
  await click(page.getByRole("button", { name: "Get quote" }));
  await page.locator('[data-cashout="quote"]').waitFor({ timeout: 60000 });
  await wait(700);
  mark("cashout_quote");
  await wait(2600);
  await click(page.getByRole("button", { name: "Confirm" }));
  await page.locator('[data-cashout="swapping"], [data-cashout="delivered"]').first().waitFor({ timeout: 4 * 60000 }).catch(() => undefined);
  mark("cashout_swapping");
  await wait(3000);

  // 8. Dashboard
  await page.goto(base + "/dashboard");
  await page.waitForSelector(".vault-card", { timeout: 30000 });
  await wait(1500);
  mark("dashboard");
  await wait(4000);
  await scrollToEl(page.locator(".activity"), 110).catch(() => undefined);
  mark("activity");
  await wait(3500);

  writeFileSync(`${out}/token.txt`, `${tokenId}\n${code}\n`);
} catch (e) {
  console.log(`FAILED: ${String(e).slice(0, 500)}`);
  await page.screenshot({ path: `${out}/failure.png` }).catch(() => undefined);
} finally {
  mark("end");
  await cdp.send("Page.stopScreencast").catch(() => undefined);
  await wait(300);
  writeFileSync(`${out}/frames.json`, JSON.stringify({ frames, markers }, null, 1));
  console.log(`${frames.length} frames, ${markers.length} markers`);
  await browser.close();
}
