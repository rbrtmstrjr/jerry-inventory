// Task 14 (Shops & Employees) — GERRY half: Steps 12–15 · 17 · 18.
//
// Runs AFTER task14a.mjs, which leaves `ZZ-QB Branch` live with no login and no
// staff. Step 13 deliberately runs BEFORE Step 12: once the shop has a login the
// "Create Login" menu item is replaced by "Change Credentials", so the
// one-login-per-shop refusal has no entry point left to test.
//
// The close-shop BLOCKED dialog is exercised twice — once on a real branch that
// holds stock (opened and cancelled only; a blocked dialog cannot mutate) and
// once on ZZ-QB, whose own enabled login is a live blocker.
import {
  launch, login, goto, bodyText, shot, dbAuth,
  step, check, summary, toast, clearToasts, APP, CREDS,
} from "./qa-lib.mjs";
import { chromium } from "file:///C:/Users/rober/.claude/skills/gstack/node_modules/playwright/index.mjs";

const SHOP = "ZZ-QB Branch";
const LOGIN_EMAIL = "zzqb-branch@gerwin-test.ph";
const PASS_1 = "zzqbpass123";
const PASS_2 = "zzqbpass456";
// A branch that is neither Shop 1 (Gerwin-Ternate) nor Shop 2 (Gerwin-Naic).
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
/** Sign in with arbitrary credentials in a throwaway context.
 *
 *  WAIT ON THE URL CHANGE, never a fixed timeout: `next dev` compiles /shop on
 *  demand, so a cold first sign-in takes far longer than a warm one. A fixed
 *  6 s wait made a perfectly good login look refused — and because a refusal
 *  ALSO leaves you on /login, the two are indistinguishable without this. */
async function trySignIn(email, pass) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  try {
    await p.goto(`${APP}/login`, { waitUntil: "load", timeout: 60000 });
    await p.locator('input[type="email"]').fill(email);
    await p.locator('input[type="password"]').fill(pass);
    await p.locator('button[type="submit"]').click();
    try {
      await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 });
      await p.waitForLoadState("load");
    } catch {
      /* genuinely refused — stayed on /login */
    }
    const url = new URL(p.url()).pathname;
    const body = await p.evaluate(() => document.body.innerText);
    return { url, body };
  } finally {
    await ctx.close();
  }
}

try {
  await login(page, "owner");
  await goto(page, "/shops");
  await page.waitForTimeout(2500);

  const mine = (await q(`shops?select=id,name,color_key&name=eq.${encodeURIComponent(SHOP)}&deleted_at=is.null`))[0];
  check(!!mine, "ZZ-QB Branch exists from the ADMIN half", mine?.name ?? "absent");
  const SHOP_ID = mine.id;

  // ── Step 13: one login per shop (❌) ──────────────────────────────────────
  step("Step 13: one login per shop");
  let menu = await shopMenu(SHOP);
  check(/Create Login/.test(menu), "GERRY sees 'Create Login' on a login-less shop",
    menu.replace(/\n/g, " · "));
  await page.getByRole("menuitem", { name: /Create Login/ }).click();
  await page.waitForTimeout(1200);
  check(/One shared account per shop — everyone at the shop uses this login\./.test(await T()),
    "dialog description present");
  check(
    (await page.locator("#emp-name").getAttribute("placeholder")) === "e.g. Branch 1 Counter",
    "account-name placeholder is 'e.g. Branch 1 Counter'",
    await page.locator("#emp-name").getAttribute("placeholder")
  );
  await page.locator("#emp-name").fill("ZZ-QB Counter");
  await page.locator("#emp-email").fill(LOGIN_EMAIL);
  await page.locator("#emp-pass").fill(PASS_1);
  // point it at a shop that ALREADY has a login → must be refused
  await page.locator('[role="combobox"]').first().click();
  await page.waitForTimeout(600);
  await page.getByRole("option", { name: OTHER, exact: true }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const t13 = await toast(page);
  check(/This shop already has a login account — each shop gets exactly one\./.test(t13),
    "❌ second login refused with the one-per-shop message", t13);
  const stillOne = await q(`profiles?select=id&role=eq.employee&deleted_at=is.null`);
  check(stillOne.length === 10, "no extra login row was created", `${stillOne.length} shop logins`);
  await clearToasts(page);

  // ── Step 12: create the shop login ────────────────────────────────────────
  step("Step 12: create a shop login (GERRY)");
  await page.locator('[role="combobox"]').first().click();
  await page.waitForTimeout(600);
  await page.getByRole("option", { name: SHOP, exact: true }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  const t12 = await toast(page);
  check(/Employee account created/.test(t12), "toast 'Employee account created'", t12);
  await page.waitForTimeout(3000);
  await clearToasts(page);
  await goto(page, "/shops");
  await page.waitForTimeout(2500);
  check(/login active/.test(await card(SHOP).innerText()),
    "card's login indicator flips to 'login active'");

  const signedIn = await trySignIn(LOGIN_EMAIL, PASS_1);
  check(signedIn.url === "/shop", "new login lands on /shop", signedIn.url);
  check(new RegExp(SHOP).test(signedIn.body), "the shop session is scoped to ZZ-QB Branch",
    signedIn.body.slice(0, 120).replace(/\n/g, " "));
  await shot(page, "task14-step12-login");

  // ── Step 14: change credentials ───────────────────────────────────────────
  step("Step 14: change credentials");
  menu = await shopMenu(SHOP);
  check(/Change Credentials/.test(menu), "menu now offers 'Change Credentials'",
    menu.replace(/\n/g, " · "));
  check(!/Create Login/.test(menu), "❌ 'Create Login' is gone once a login exists");
  await page.getByRole("menuitem", { name: /Change Credentials/ }).click();
  await page.waitForTimeout(1200);
  check(/The shared login everyone at this shop uses\./.test(await T()),
    "credentials dialog description present");
  check(
    (await page.locator("#cred-pass").getAttribute("placeholder")) ===
      "Leave blank to keep the current password",
    "password placeholder is 'Leave blank to keep the current password'",
    await page.locator("#cred-pass").getAttribute("placeholder")
  );
  await page.locator("#cred-pass").fill(PASS_2);
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  const t14 = await toast(page);
  check(/Credentials updated/.test(t14), "toast 'Credentials updated'", t14);
  await page.waitForTimeout(3000);
  await clearToasts(page);

  const oldPass = await trySignIn(LOGIN_EMAIL, PASS_1);
  check(oldPass.url === "/login", "❌ the OLD password no longer signs in", oldPass.url);
  const newPass = await trySignIn(LOGIN_EMAIL, PASS_2);
  check(newPass.url === "/shop", "the NEW password signs in", newPass.url);

  // untick "Login enabled" → the shop can no longer sign in
  await goto(page, "/shops");
  await page.waitForTimeout(2500);
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Change Credentials/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("checkbox").last().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await page.waitForTimeout(3000);
  await clearToasts(page);
  const disabled = await trySignIn(LOGIN_EMAIL, PASS_2);
  check(disabled.url !== "/shop", "❌ a disabled login cannot sign in", disabled.url);
  check(/disabled|Talk to the owner/i.test(disabled.body),
    "disabled sign-in explains itself",
    (disabled.body.match(/[^\n]*disabled[^\n]*/i) || ["(no message)"])[0]);

  // re-enable, per the plan, then confirm it works again
  await goto(page, "/shops");
  await page.waitForTimeout(2500);
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Change Credentials/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("checkbox").last().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await page.waitForTimeout(3000);
  await clearToasts(page);
  const reEnabled = await trySignIn(LOGIN_EMAIL, PASS_2);
  check(reEnabled.url === "/shop", "re-enabled login signs in again", reEnabled.url);

  // ── Step 15a: blocked close on a branch that holds stock (read-only) ──────
  step("Step 15a: close is blocked while stock is out");
  await goto(page, "/shops");
  await page.waitForTimeout(2500);
  const other = (await q(`shops?select=id,name&name=eq.${encodeURIComponent(OTHER)}`))[0];
  const otherUnits = (await q(`stock_levels?select=qty&shop_id=eq.${other.id}&qty=gt.0`))
    .reduce((s, r) => s + r.qty, 0);
  console.log(`  ${OTHER} holds ${otherUnits} part units`);
  await shopMenu(OTHER);
  await page.getByRole("menuitem", { name: /Close Permanently/ }).click();
  await page.waitForTimeout(1200);
  const blockedTxt = await page.locator('[role="dialog"]').last().innerText();
  check(new RegExp(`“?${OTHER}”? can't be closed yet`).test(blockedTxt),
    "blocked dialog title names the shop", blockedTxt.split("\n")[0]);
  check(
    /Nothing returns to master automatically — settle these first so the audit trail stays truthful:/
      .test(blockedTxt),
    "blocked dialog carries the settle-first copy"
  );
  check(/part unit\(s\) still at this shop/.test(blockedTxt),
    "stock blocker listed", (blockedTxt.match(/[^\n]*part unit\(s\)[^\n]*/) || ["absent"])[0]);
  // B1 — the remedy it names was retired by 0065
  const namesDeadTab = /Deliveries & Returns → New Return/.test(blockedTxt);
  check(!namesDeadTab,
    "B1 — blocker fix-hint must not point at the retired 'New Return' tab",
    (blockedTxt.match(/→ [^\n]*/g) || []).join(" | "));
  check((await page.getByRole("button", { name: "Got it", exact: true }).count()) > 0,
    "blocked dialog offers only 'Got it' (no destructive action)");
  check((await page.getByRole("button", { name: "Close shop", exact: true }).count()) === 0,
    "❌ no 'Close shop' button while blocked");
  await shot(page, "task14-step15-blocked");
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await page.waitForTimeout(800);
  const stillLive = await q(`shops?select=deleted_at&id=eq.${other.id}`);
  check(stillLive[0].deleted_at === null, `${OTHER} was NOT closed`, String(stillLive[0].deleted_at));

  // ── Step 15b: blocked on ZZ-QB by its own enabled login, then closed ──────
  step("Step 15b: close ZZ-QB Branch");
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Close Permanently/ }).click();
  await page.waitForTimeout(1200);
  let dlg = await page.locator('[role="dialog"]').last().innerText();
  check(/The shop's login is still enabled/.test(dlg),
    "an enabled login is listed as a blocker", (dlg.match(/[^\n]*login is still enabled[^\n]*/) || ["absent"])[0]);
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await page.waitForTimeout(800);

  // disable the login, then close cleanly
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Change Credentials/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("checkbox").last().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save credentials", exact: true }).click();
  await page.waitForTimeout(3200);
  await clearToasts(page);
  await goto(page, "/shops");
  await page.waitForTimeout(2500);
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Close Permanently/ }).click();
  await page.waitForTimeout(1200);
  dlg = await page.locator('[role="dialog"]').last().innerText();
  check(new RegExp(`Close “?${SHOP}”? permanently\\?`).test(dlg),
    "clear-state dialog title", dlg.split("\n")[0]);
  check(
    /Everything is settled\. The shop disappears from lists and delivery targets, but its sales history, ledger entries, and warranties stay in the records\./
      .test(dlg),
    "clear-state description present"
  );
  await page.getByRole("button", { name: "Close shop", exact: true }).click();
  const t15 = await toast(page);
  check(new RegExp(`${SHOP} closed`).test(t15), "toast '<shop> closed'", t15);
  await page.waitForTimeout(3000);
  const closed = (await q(`shops?select=deleted_at,active&id=eq.${SHOP_ID}`))[0];
  check(closed.deleted_at !== null, "shop soft-closed in the database", String(closed.deleted_at));
  await clearToasts(page);
  await goto(page, "/shops");
  await page.waitForTimeout(2500);
  check(!new RegExp(SHOP).test(await T()), "closed shop leaves the Shops list");

  // history stays
  const histShop = await q(`shops?select=id,name&id=eq.${SHOP_ID}`);
  check(histShop.length === 1, "the shop row itself is kept (soft-delete, not a purge)");

  // ── Step 17: colour released on close ─────────────────────────────────────
  step("Step 17: a closed shop does not reserve a colour");
  await page.getByRole("button", { name: "Add shop", exact: true }).click();
  await page.waitForTimeout(1000);
  const sw = await page.locator('button[aria-label^="Color "]').evaluateAll((els) =>
    els.map((e) => ({ label: e.getAttribute("aria-label"), disabled: e.disabled }))
  );
  const liveColoured = (await q("shops?select=color_key&deleted_at=is.null"))
    .filter((s) => s.color_key).length;
  const closedShops = (await q("shops?select=id&deleted_at=not.is.null")).length;
  check(sw.filter((s) => s.disabled).length === liveColoured,
    "disabled swatches == colours held by LIVE shops only",
    `${sw.filter((s) => s.disabled).length} disabled vs ${liveColoured} live-coloured, with ${closedShops} closed shops present`);
  check(closedShops > 0, "there are closed shops to prove the rule against", `${closedShops}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ── Step 18: read-only shop stock view ────────────────────────────────────
  step("Step 18: read-only shop stock");
  await goto(page, `/shops/${other.id}/stock`);
  await page.waitForTimeout(3000);
  let t = await T();
  check(new RegExp(`${OTHER} — Stock`).test(t), "title '<shop> — Stock'",
    (t.match(/[^\n]*— Stock/) || ["absent"])[0]);
  check(/Read-only — exactly what this shop's employees see/.test(t),
    "read-only subtitle present");
  check((await page.getByRole("link", { name: /Shops & Employees/ }).count()) > 0,
    "back link to Shops & Employees");
  check(/Engines|No engines at this shop right now\./.test(t), "engines section present");

  // The card tiles, the Out of stock / Low badges and the "N of M items" counter
  // live in CARD view only; the table is the default.
  await page.getByRole("button", { name: /Cards?$/i }).first().click();
  await page.waitForTimeout(2000);
  t = await T();
  check(/\d+ of \d+ items/.test(t), "'N of M items' counter (card view)",
    (t.match(/\d+ of \d+ items/) || ["absent"])[0]);
  check(/Out of stock|Low/.test(t), "stock badges render on the tiles",
    (t.match(/Out of stock|Low/) || ["absent"])[0]);
  await page.getByRole("tab", { name: /Engines/ }).click();
  await page.waitForTimeout(2000);
  t = await T();
  check(/SN|Serial|No engines at this shop right now\./.test(t),
    "engine tiles show a serial (or the empty state)",
    (t.match(/SN[^\n]*/) || ["(empty state)"])[0]);
  await shot(page, "task14-step18-stock");

  // closed shop → 404
  const res = await page.goto(`${APP}/shops/${SHOP_ID}/stock`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(1500);
  const body404 = await T();
  check(res.status() === 404 || /not found|404/i.test(body404),
    "❌ a closed shop's stock page 404s",
    `status ${res.status()} · ${body404.slice(0, 80).replace(/\n/g, " ")}`);
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task14b-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 8) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
