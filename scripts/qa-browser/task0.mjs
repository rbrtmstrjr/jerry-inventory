// Task 0 — Setup and the role matrix baseline. Step 4 (Steps 1–3 already done).
//
// Step 5 is `git commit`; the standing instruction is that the user handles all
// git, so it is deliberately not performed. See the plan's status note.
import {
  launch, session, goto, bodyText, shot, dbAuth,
  step, check, summary,
} from "./qa-lib.mjs";

const ADMIN_NAV = [
  "Dashboard", "Suppliers", "Master Inventory", "Deliveries & Returns",
  "Stock Alerts", "Monthly Count", "Movements", "Approval Queue",
  "Receivables", "Warranties & Serials", "Suki Cards", "Shops & Employees",
  "Expenses",
];

const { browser } = await launch();
const q = await dbAuth("owner");

try {
  // ── Step 1 (re-confirmed cheaply) ─────────────────────────────────────────
  step("Step 1: environment is staging");
  // dbAuth() itself refuses unless SUPABASE_ENV=staging, so reaching here proves it
  check(true, "SUPABASE_ENV=staging (dbAuth refuses otherwise)");
  const biz = (await q("settings?select=business_name"))[0].business_name;
  check(!/ZZ/.test(biz), "the live settings row is unpolluted", `business_name=${biz}`);

  // ── Step 4: role matrix baseline ──────────────────────────────────────────
  step("Step 4: ADMIN nav + avatar menu");
  const admin = await session(browser, "admin");
  await goto(admin.page, "/dashboard");
  await admin.page.waitForTimeout(3500);

  const nav = await admin.page.locator("aside").first().innerText();
  for (const item of ADMIN_NAV) {
    check(nav.includes(item), `ADMIN sidebar shows: ${item}`);
  }
  check(!/\bReports\b/.test(nav), "❌ ADMIN sidebar has NO Reports",
    (nav.match(/[^\n]*Reports[^\n]*/) || ["absent"])[0]);

  // avatar menu: "Admin" label, no Settings
  await admin.page.locator("header button").last().click();
  await admin.page.waitForTimeout(900);
  const menu = await admin.page.locator('[role="menu"]').last().innerText();
  check(/Admin/.test(menu), "avatar menu labels the role 'Admin'", menu.replace(/\n/g, " · "));
  check(!/Settings/.test(menu), "❌ no Settings link in the ADMIN's avatar menu",
    menu.replace(/\n/g, " · "));
  check(/Sign out/.test(menu), "…but Sign out is still there");
  await shot(admin.page, "task0-step4-adminmenu");
  await admin.page.keyboard.press("Escape");

  // and the contrast: GERRY has both
  const owner = await session(browser, "owner");
  await goto(owner.page, "/dashboard");
  await owner.page.waitForTimeout(3500);
  const onav = await owner.page.locator("aside").first().innerText();
  check(/\bReports\b/.test(onav), "GERRY's sidebar DOES show Reports");
  await owner.page.locator("header button").last().click();
  await owner.page.waitForTimeout(900);
  const omenu = await owner.page.locator('[role="menu"]').last().innerText();
  check(/Settings/.test(omenu), "GERRY's avatar menu DOES show Settings",
    omenu.replace(/\n/g, " · "));
  await owner.page.keyboard.press("Escape");

  // ── Step 3's browser half (was left ⚠️ API-only) ──────────────────────────
  step("Step 3: the browser half of the login check");
  console.log("  covered by Task 1 Step 3 (task1.mjs, 47/47): each role signs in");
  console.log("  in its OWN context and lands on the right home — GERRY and ADMIN");
  console.log("  on /dashboard, SHOP on /shop, and a signed-in visit to /login");
  console.log("  bounces back. Re-asserted here for the two office roles:");
  check(new URL(admin.page.url()).pathname === "/dashboard", "ADMIN is on /dashboard");
  check(new URL(owner.page.url()).pathname === "/dashboard", "GERRY is on /dashboard");

  await admin.ctx.close();
  await owner.ctx.close();
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
} finally {
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
