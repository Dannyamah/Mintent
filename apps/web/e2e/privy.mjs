// Privy sign-in in a real browser. Without credentials it checks the login window opens and the page stays clean.
// With a Privy test account it signs in for real, and checks the account is implicit and survives a reload and sign-out.
// Usage: PRIVY_TEST_EMAIL=... PRIVY_TEST_OTP=... node e2e/privy.mjs <outDir> [appUrl]
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/"] = process.argv.slice(2);
const { PRIVY_TEST_EMAIL: email, PRIVY_TEST_OTP: otp } = process.env;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
const ok = (name) => console.log(`ok  ${name}`);

await page.goto(url);
await page.getByRole("button", { name: "Sign in" }).click();
const emailBtn = page.getByRole("button", { name: "Continue with email" });
await emailBtn.waitFor({ timeout: 45000 });
ok("sign-in sheet offers email once Privy is ready");
await page.getByRole("button", { name: "Create my test account" }).waitFor();
ok("test account is still offered on testnet");
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/privy-sheet.png` });

await emailBtn.click();
const input = page.locator('input[type="email"], #email-input').first();
await input.waitFor({ timeout: 20000 });
ok("Privy's login window opens with an email field");
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/privy-login.png` });

if (email && otp) {
  await input.fill(email);
  await page.getByRole("button", { name: "Submit" }).click();
  await page.locator('input[autocomplete="one-time-code"], input[name="code-0"]').first().waitFor({ timeout: 20000 });
  await page.keyboard.type(otp, { delay: 60 });
  const acct = page.locator(".acct__id");
  await acct.waitFor({ timeout: 45000 });
  const id = await acct.getAttribute("data-account");
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`not an implicit account: ${id}`);
  ok(`signed in; NEAR account ${id}`);

  await page.reload();
  await acct.waitFor({ timeout: 45000 });
  if ((await acct.getAttribute("data-account")) !== id) throw new Error("account changed after reload");
  ok("session and account survive a reload");
  await page.screenshot({ path: `${out}/privy-signed-in.png` });

  await page.locator(".acct__btn").click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 20000 });
  ok("sign-out returns to the signed-out state");
} else {
  console.log("--  no PRIVY_TEST_EMAIL/PRIVY_TEST_OTP: real login, reload and sign-out not exercised");
}

await browser.close();
console.log(problems.length ? `CONSOLE PROBLEMS:\n${problems.join("\n")}` : "console clean");
process.exit(problems.length ? 1 : 0);
