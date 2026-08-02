// Task 14 — re-verification of Steps 12 · 14 · 18.
//
// The first task14b run reported three sign-in failures. They were the DRIVER's:
// trySignIn waited a fixed 6 s, but `next dev` compiles /shop on demand, so a
// cold first sign-in overran it — and since a real refusal ALSO leaves you on
// /login, a timeout and a refusal were indistinguishable. Fixed in task14b.mjs;
// this script proves the fix against a fresh shop and asserts on the SPECIFIC
// message each refusal produces, so "refused" can never again mean "slow".
//
// Step 18's two misses were the same shape: the card tiles and the "N of M
// items" counter exist only in CARD view, and table is the default.
import {
  launch, login, goto, bodyText, shot, dbAuth,
  step, check, summary, toast, clearToasts, APP,
} from "./qa-lib.mjs";

const SHOP = "ZZ-QB Branch 2";
const EMAIL = "zzqb2@gerwin-test.ph";
const PASS_1 = "zzqb2pass123";
const PASS_2 = "zzqb2pass456";
const OTHER = "Gerwin-Silang";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner");

async function shopMenu(name) {
  await page.getByRole("button", { name: `More actions for ${name}`, exact: true })
    .first().click();
  await page.waitForTimeout(500);
  return page.locator('[role="menu"]').last().innerText();
}
function card(name) {
  return page.locator('[data-slot="card"]').filter({ hasText: name }).first();
}
async function trySignIn(email, pass) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const t0 = Date.now();
  try {
    await p.goto(`${APP}/login`, { waitUntil: "load", timeout: 60000 });
    await p.locator('input[type="email"]').fill(email);
    await p.locator('input[type="password"]').fill(pass);
    await p.locator('button[type="submit"]').click();
    try {
      await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 });
      await p.waitForLoadState("load");
    } catch { /* genuinely refused */ }
    const url = new URL(p.url()).pathname;
    const body = await p.evaluate(() => document.body.innerText);
    console.log(`    sign-in ${email} → ${url} (${Date.now() - t0}ms)`);
    return { url, body };
  } finally {
    await ctx.close();
  }
}

try {
  await login(page, "owner");
  await goto(page, "/shops");
  await page.waitForTimeout(2500);

  // ── fixture shop (idempotent — reuse a live one so a re-run adds no shop) ──
  step("fixture: ZZ-QB Branch 2");
  let existing = (await q(`shops?select=id&name=eq.${encodeURIComponent(SHOP)}&deleted_at=is.null`))[0];
  if (existing) {
    check(true, "reusing the live fixture shop from a previous run");
  } else {
    await page.getByRole("button", { name: "Add shop", exact: true }).click();
    await page.waitForTimeout(900);
    await page.locator("#shop-name").fill(SHOP);
    await page.locator("#shop-loc").fill("QA Town 2");
    await page.getByRole("button", { name: "Create shop", exact: true }).click();
    const tc = await toast(page);
    check(/Shop created/.test(tc), "fixture shop created", tc);
    await page.waitForTimeout(2500);
    await clearToasts(page);
    existing = (await q(`shops?select=id&name=eq.${encodeURIComponent(SHOP)}&deleted_at=is.null`))[0];
  }
  const SHOP_ID = existing.id;
  const hasLogin = (await q(`profiles?select=id&shop_id=eq.${SHOP_ID}&role=eq.employee&deleted_at=is.null`)).length > 0;

  // ── Step 12 (re-verify): create a login and actually sign in ──────────────
  step("Step 12: a newly created shop login signs in");
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  let FIRST_PASS = PASS_1;
  if (hasLogin) {
    check(true, "reusing the fixture login from a previous run");
    FIRST_PASS = PASS_2; // a prior run already rotated it
  } else {
    await shopMenu(SHOP);
    await page.getByRole("menuitem", { name: /Create Login/ }).click();
    await page.waitForTimeout(1200);
    await page.locator("#emp-name").fill("ZZ-QB2 Counter");
    await page.locator("#emp-email").fill(EMAIL);
    await page.locator("#emp-pass").fill(PASS_1);
    await page.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(600);
    await page.getByRole("option", { name: SHOP, exact: true }).first().click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Create account", exact: true }).click();
    const t12 = await toast(page);
    check(/Employee account created/.test(t12), "toast 'Employee account created'", t12);
    await page.waitForTimeout(3000);
    await clearToasts(page);
  }

  const inA = await trySignIn(EMAIL, FIRST_PASS);
  check(inA.url === "/shop", "new login lands on /shop", inA.url);
  // The /shop page doesn't print the branch name in its body — the binding that
  // matters is the profile row, so assert that instead of scraping chrome.
  const boundShop = (await q(`profiles?select=shop_id&shop_id=eq.${SHOP_ID}&role=eq.employee&deleted_at=is.null`));
  check(boundShop.length === 1, "the login's profile is bound to this branch only",
    `${boundShop.length} profile(s) on ${SHOP}`);
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  check(/login active/.test(await card(SHOP).innerText()), "card shows 'login active'");

  // ── Step 14 (re-verify): password change, then enable/disable ─────────────
  step("Step 14: change credentials");
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Change Credentials/ }).click();
  await page.waitForTimeout(1200);
  await page.locator("#cred-pass").fill(PASS_2);
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  const t14 = await toast(page);
  check(/Credentials updated/.test(t14), "toast 'Credentials updated'", t14);
  await page.waitForTimeout(3000);
  await clearToasts(page);

  const oldP = await trySignIn(EMAIL, FIRST_PASS);
  check(oldP.url === "/login", "❌ the OLD password is refused", oldP.url);
  // login-form.tsx:62 rewrites Supabase's "Invalid login credentials" to this.
  check(/Wrong email or password\./.test(oldP.body),
    "…and the refusal says 'Wrong email or password.' (not a silent timeout)",
    (oldP.body.match(/[^\n]*(Wrong email|Invalid|credential)[^\n]*/i) || ["(no message)"])[0].trim());
  const newP = await trySignIn(EMAIL, PASS_2);
  check(newP.url === "/shop", "the NEW password signs in", newP.url);

  // disable
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Change Credentials/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("checkbox").last().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await page.waitForTimeout(3200);
  await clearToasts(page);
  const off = await trySignIn(EMAIL, PASS_2);
  check(off.url === "/login", "❌ a disabled login cannot sign in", off.url);
  check(/This account has been disabled\. Talk to the owner\./.test(off.body),
    "disabled message is the specified copy",
    (off.body.match(/[^\n]*disabled[^\n]*/i) || ["(no message)"])[0].trim());
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  check(/login disabled/.test(await card(SHOP).innerText()),
    "card indicator reads 'login disabled'");

  // re-enable
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Change Credentials/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("checkbox").last().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await page.waitForTimeout(3200);
  await clearToasts(page);
  const back = await trySignIn(EMAIL, PASS_2);
  check(back.url === "/shop", "re-enabled login signs in again", back.url);

  // ── Step 18 (re-verify): card view ────────────────────────────────────────
  step("Step 18: read-only shop stock — card views");
  const other = (await q(`shops?select=id&name=eq.${encodeURIComponent(OTHER)}`))[0];
  await goto(page, `/shops/${other.id}/stock`);
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Card view", exact: true }).first().click();
  await page.waitForTimeout(2500);
  let t = await T();
  check(/\d+ of \d+ items/.test(t), "'N of M items' counter (card view)",
    (t.match(/\d+ of \d+ items/) || ["absent"])[0]);
  check(/Out of stock|Low/.test(t), "Out of stock / Low badges render on tiles",
    [...new Set(t.match(/Out of stock|Low/g) || [])].join(", ") || "absent");
  await shot(page, "task14-step18-cards");
  await page.getByRole("tab", { name: /Engines/ }).click();
  await page.waitForTimeout(2500);
  t = await T();
  check(/SN |Serial|No engines at this shop right now\./.test(t),
    "engine tiles show SN / condition (or the empty state)",
    (t.match(/SN [^\n]*/) || t.match(/No engines[^\n]*/) || ["absent"])[0]);
  await shot(page, "task14-step18-engines");

  // ── cleanup: disable the login, close the fixture shop ────────────────────
  step("cleanup: close ZZ-QB Branch 2");
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Change Credentials/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("checkbox").last().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await page.waitForTimeout(3200);
  await clearToasts(page);
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Close Permanently/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "Close shop", exact: true }).click();
  const tcl = await toast(page);
  check(new RegExp(`${SHOP} closed`).test(tcl), "fixture shop closed", tcl);
  await page.waitForTimeout(2500);
  const gone = (await q(`shops?select=deleted_at&id=eq.${SHOP_ID}`))[0];
  check(gone.deleted_at !== null, "fixture shop is soft-closed");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task14c-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 8) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
