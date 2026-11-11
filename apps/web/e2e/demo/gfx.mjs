// Renders the demo's graphics from graphics.html: full scenes frame by frame (deterministic, 30 fps) to MP4, and the captions
// and chapter tags as transparent PNGs. Usage: node e2e/demo/gfx.mjs <videoDir>
// Reads <videoDir>/gfx/graphics.html, <videoDir>/gfx/data.json and <videoDir>/plan.json.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";

const [dir] = process.argv.slice(2);
const data = JSON.parse(readFileSync(`${dir}/gfx/data.json`, "utf8"));
const plan = JSON.parse(readFileSync(`${dir}/plan.json`, "utf8"));
const FPS = 30;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.addInitScript((d) => { window.DATA = d; }, data);
await page.goto(`file://${dir}/gfx/graphics.html`);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);

for (const s of plan.scenes.filter((x) => x.gfx)) {
  const frames = `${dir}/gfx/frames-${s.gfx}`;
  rmSync(frames, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const n = Math.round(s.duration * FPS);
  for (let i = 0; i < n; i++) {
    await page.evaluate(([name, t, T]) => window.renderScene(name, t, T), [s.gfx, i / FPS, s.duration]);
    await page.screenshot({ path: `${frames}/${String(i).padStart(5, "0")}.png` });
  }
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-framerate", String(FPS), "-i", `${frames}/%05d.png`, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p", `${dir}/gfx/${s.gfx}.mp4`]);
  console.log(`scene ${s.gfx}: ${n} frames`);
}

mkdirSync(`${dir}/gfx/caps`, { recursive: true });
for (const c of plan.captions) {
  await page.evaluate((text) => window.renderCaption(text), c.text);
  await page.screenshot({ path: `${dir}/gfx/caps/${c.id}.png`, omitBackground: true });
}
mkdirSync(`${dir}/gfx/chapters`, { recursive: true });
for (const c of plan.chapters) {
  await page.evaluate(([n, title, sub]) => window.renderChapter(n, title, sub), [c.n, c.title, c.sub]);
  await page.screenshot({ path: `${dir}/gfx/chapters/${c.id}.png`, omitBackground: true });
}
await page.evaluate(() => window.renderLive());
await page.screenshot({ path: `${dir}/gfx/live.png`, omitBackground: true });
writeFileSync(`${dir}/gfx/done.txt`, new Date().toISOString());
console.log(`${plan.captions.length} captions, ${plan.chapters.length} chapters`);
await browser.close();
