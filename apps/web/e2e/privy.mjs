// Privy sign-in in a real browser. Without credentials it checks the login window opens and the page stays clean.
// With a Privy test account it signs in for real, and checks the account is implicit and survives a reload and sign-out.
// With PRIVY_BUY=1 as well (needs the relayer's DEMO_FUNDER), that account picks a pack while signed out, buys it, sells the
// card back and withdraws, so Privy's key signs real NEAR transactions on testnet.
// Usage: PRIVY_TEST_EMAIL=... PRIVY_TEST_OTP=... [PRIVY_BUY=1] node e2e/privy.mjs <outDir> [appUrl]
import { chromium } from "playwright-core";

const [out, url = "http://localhost:5173/"] = process.argv.slice(2);
const { PRIVY_TEST_EMAIL: email, PRIVY_TEST_OTP: otp, PRIVY_BUY: buy } = process.env;
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const problems = [];
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(m.text().slice(0, 300)));
page.on("pageerror", (e) => problems.push(`pageerror: ${String(e).slice(0, 300)}`));
const started = Date.now();
const ok = (name) => console.log(`ok  [${((Date.now() - started) / 1000).toFixed(0).padStart(3)}s] ${name}`);
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

const acct = page.locator(".acct__id");
const accountId = () => acct.getAttribute("data-account");
const emailInput = page.locator('input[type="email"], #email-input').first();

async function submitLogin() {
  await emailInput.fill(email);
  await page.getByRole("button", { name: "Submit" }).click();
  await page.locator('input[autocomplete="one-time-code"], input[name="code-0"]').first().waitFor({ timeout: 20000 });
  await page.keyboard.type(otp, { delay: 60 });
}

try {
  await page.goto(url);
  await page.getByRole("button", { name: "Sign in" }).click();
  const emailBtn = page.getByRole("button", { name: "Continue with email" });
  await emailBtn.waitFor({ timeout: 45000 });
  ok("sign-in sheet offers email once Privy is ready");
  await page.getByRole("button", { name: "Create my test account" }).waitFor();
  ok("test account is still offered on testnet");
  await page.waitForTimeout(500);
  await shot("privy-sheet");

  await emailBtn.click();
  await emailInput.waitFor({ timeout: 20000 });
  ok("Privy's login window opens with an email field");
  await page.waitForTimeout(800);
  await shot("privy-login");

  if (email && otp) {
    await submitLogin();
    await acct.waitFor({ timeout: 45000 });
    const id = await accountId();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error(`not an implicit account: ${id}`);
    ok(`signed in; NEAR account ${id}`);

    await page.reload();
    await acct.waitFor({ timeout: 45000 });
    if ((await accountId()) !== id) throw new Error("account changed after reload");
    ok("session and account survive a reload");
    await shot("privy-signed-in");

    await page.locator(".acct__btn").click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("button", { name: "Sign in" }).waitFor({ timeout: 20000 });
    ok("sign-out returns to the signed-out state");

    if (buy) {
      // Choosing a pack first: checkout must open by itself once sign-in finishes, as the same account.
      await page.locator("#packs").scrollIntoViewIfNeeded();
      await page.locator(".pack-card .btn--primary").first().click();
      await page.getByRole("button", { name: "Continue with email" }).click();
      await emailInput.waitFor({ timeout: 20000 });
      await submitLogin();
      await page.waitForSelector(".asset", { timeout: 60000 });
      await acct.waitFor();
      if ((await accountId()) !== id) throw new Error("signing in again gave a different account");
      ok("checkout opens by itself after signing in, with the same account");

      await page.locator(".check input").check();
      await page.getByRole("button", { name: "Get payment details" }).click();
      await page.getByRole("button", { name: "Pay with test USDC" }).waitFor({ timeout: 60000 });
      await page.getByRole("button", { name: "Pay with test USDC" }).click();
      await page.waitForSelector(".stepper");
      await Promise.race([
        page.waitForURL(/\/open\//, { timeout: 8 * 60000 }),
        page.locator(".sheet .error").waitFor({ timeout: 8 * 60000 }).then(async () => { throw new Error(`order failed: ${await page.locator(".sheet .error").innerText()}`); }),
      ]);
      const tokenId = page.url().split("/").pop();
      ok(`card delivered: token ${tokenId}`);

      const owner = await (await fetch(`http://localhost:8787/cards/${tokenId}`)).json().then((c) => c.owner_id).catch(() => null);
      if (owner !== id) throw new Error(`token ${tokenId} is owned by ${owner}, not the Privy account ${id}`);
      ok("the NFT belongs to the Privy account");

      await page.goto(`${url}#/card/${tokenId}`);
      await page.getByRole("button", { name: "Sell back for USDC" }).click({ timeout: 45000 });
      await page.getByRole("button", { name: "Confirm" }).waitFor({ timeout: 60000 });
      const offer = await page.locator(".confirm strong").innerText();
      await page.getByRole("button", { name: "Confirm" }).click();
      await page.waitForSelector(".ok, .error", { timeout: 4 * 60000 });
      if (!(await page.locator(".ok").count())) throw new Error(`sell-back failed: ${await page.locator(".error").first().innerText()}`);
      ok(`Privy's key signed the sell-back (${offer})`);
      await shot("privy-sold");

      await page.reload();
      await page.getByRole("button", { name: /^Cash out \$/ }).click({ timeout: 45000 });
      await page.locator("#dest").fill("DP84tcSd3dsu7cPyHEuPA5CAsiWgNA1RArzyvhXEvJAr");
      await page.getByRole("button", { name: "Confirm" }).click();
      await page.waitForFunction(() => /on its way/.test(document.querySelector(".ok")?.textContent ?? ""), null, { timeout: 4 * 60000 });
      ok("Privy's key signed the withdrawal");
      await shot("privy-withdrawn");

      await page.locator(".acct__btn").click();
      await page.getByRole("button", { name: "Export my key" }).click();
      await page.waitForTimeout(3000);
      await shot("privy-export");
      ok("export window requested; see privy-export.png");
    }
  } else {
    console.log("--  no PRIVY_TEST_EMAIL/PRIVY_TEST_OTP: real login, reload and sign-out not exercised");
  }
} catch (e) {
  problems.push(`FAILED: ${String(e).slice(0, 600)}`);
  await page.screenshot({ path: `${out}/privy-failure.png` }).catch(() => undefined);
}

await browser.close();
console.log(problems.length ? `PROBLEMS:\n${problems.join("\n")}` : "all clean");
process.exit(problems.length ? 1 : 0);
