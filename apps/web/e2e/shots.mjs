// Screenshot every page that doesn't need a purchase, at desktop and phone widths, and check each loads cleanly.
// Usage: node e2e/shots.mjs <outDir> [appUrl] [existingTokenId]
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/", token] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome", headless: true });
let failures = 0;

for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["laptop", { width: 1280, height: 720 }], ["tablet", { width: 820, height: 1100 }], ["phone", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(m.text().slice(0, 200)));
  page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 200)}`));

  await page.goto(url, { waitUntil: "load" });
  await page.waitForSelector(".tile img", { timeout: 20000 }).catch(() => problems.push("no gallery tiles"));
  await page.waitForSelector(".pack-card", { timeout: 20000 }).catch(() => problems.push("no packs"));
  await page.waitForTimeout(2600);
  await page.screenshot({ path: `${out}/${name}-hero.png` });
  const stats = await page.evaluate(() => {
    const tiles = [...document.querySelectorAll(".tile img")].filter((i) => i.getBoundingClientRect().width > 0);
    return {
      tiles: tiles.length,
      loaded: tiles.filter((i) => i.complete && i.naturalWidth > 0).length,
      packs: document.querySelectorAll(".pack-card").length,
      wallBottom: Math.round(Math.max(...[...document.querySelectorAll(".tile")].filter((t) => t.getBoundingClientRect().width > 0).map((t) => t.getBoundingClientRect().bottom))),
      centre: (() => {
        const c = document.querySelector(".hero__copy").getBoundingClientRect();
        const w = document.querySelector(".wall__centre").getBoundingClientRect();
        return { fitsHeight: c.height <= w.height + 1, copy: Math.round(c.height), slot: Math.round(w.height) };
      })(),
    };
  });

  // Scroll through the page in steps so scroll-triggered sections have appeared before the full-page shot.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 500) {
    await page.evaluate((v) => window.scrollTo({ top: v, behavior: "auto" }), y);
    await page.waitForTimeout(160);
  }
  await page.waitForTimeout(1600);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "auto" }));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}-full.png`, fullPage: true });

  const hScroll = {};
  hScroll.home = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);

  const code = await page.evaluate(async () => {
    const a = document.querySelector(".pack-card__art");
    return a.getAttribute("href");
  });
  for (const [route, label, wait] of [[code, "pack", ".facts"], ["#/security", "security", ".threats"], ["#/nope", "notfound", ".empty"], ["#/dashboard", "dashboard-out", ".empty"]]) {
    await page.goto(`${url}${route}`);
    await page.waitForSelector(wait, { timeout: 20000 }).catch(() => problems.push(`${label}: ${wait} missing`));
    await page.waitForTimeout(1400);
    await page.screenshot({ path: `${out}/${name}-${label}.png` });
    hScroll[label] = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  }

  // An existing token's reveal and card page, without buying anything: the actions must be on screen after opening.
  if (token) {
    await page.goto(`${url}#/reveal/${token}`);
    const tear = page.getByRole("button", { name: "Tear open your pack" });
    await tear.waitFor({ timeout: 30000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${name}-reveal-sealed.png` });
    await tear.click({ force: true });
    await page.getByRole("link", { name: "View your card" }).waitFor();
    await page.waitForTimeout(2800);
    await page.screenshot({ path: `${out}/${name}-reveal-open.png` });
    const box = await page.getByRole("link", { name: "View your card" }).boundingBox();
    if (box.y + box.height > viewport.height) problems.push(`reveal: "View your card" is below the fold (${Math.round(box.y + box.height)} of ${viewport.height})`);
    await page.goto(`${url}#/card/${token}`);
    await page.waitForSelector(".slab img.is-loaded", { timeout: 30000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/${name}-card.png` });
  }

  // Sticky nav must get its solid background once content scrolls underneath it.
  await page.goto(url);
  await page.waitForSelector(".pack-card");
  await page.evaluate(() => window.scrollTo({ top: 700, behavior: "auto" }));
  await page.waitForTimeout(600);
  if (!(await page.locator(".nav.is-scrolled").count())) problems.push("nav has no background after scrolling");
  await page.screenshot({ path: `${out}/${name}-scrolled.png` });

  // Touch targets: anything clickable and visible on the home page should be at least 36px tall (44 for main actions).
  await page.goto(url);
  await page.waitForSelector(".pack-card");
  const small = await page.evaluate(() => [...document.querySelectorAll("button, nav a, .btn")].map((e) => [e, e.getBoundingClientRect()]).filter(([, r]) => r.width > 0 && r.height < 36).map(([e, r]) => `${e.tagName} ${(e.textContent ?? "").slice(0, 24)}: ${Math.round(r.height)}px`).slice(0, 5));

  const bad = Object.entries(hScroll).filter(([, v]) => v).map(([k]) => k);
  if (bad.length) problems.push(`horizontal scroll on: ${bad.join(", ")}`);
  if (small.length) problems.push(`small targets: ${small.join("; ")}`);
  if (problems.length) failures++;
  console.log(name, JSON.stringify(stats), problems.length ? `PROBLEMS: ${JSON.stringify(problems.slice(0, 8))}` : "clean");
  await page.close();
}
await browser.close();
process.exit(failures ? 1 : 0);
