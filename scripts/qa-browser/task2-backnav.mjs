// Regression: after Sign out, pressing Back must not re-display an
// authenticated page. (Task 2 Step 8 · bug B6 in QA log B.)
//
// RUN THIS AGAINST A PRODUCTION BUILD:
//     npm run build && npx next start -p 3000
//     node scripts/qa-browser/task2-backnav.mjs
//
// Against `next dev` it FAILS BY DESIGN, and that is not a defect. Dev serves
// pages `Cache-Control: no-cache, must-revalidate`; `no-cache` still lets the
// browser satisfy a history navigation from its own cache, so Back re-displays
// the last page without ever reaching the middleware that would redirect it. A
// production build serves `private, no-cache, no-store, max-age=0,
// must-revalidate` (next/dist/build/templates/app-page.js:914) and `no-store`
// forbids that reuse. The header assertion below tells the two apart, so a
// failure here is unambiguous: either you are on dev, or something real broke.
//
// Diagnoses that looked right and were not, recorded so nobody re-walks them:
//   · NOT a stale cookie — sign-out clears `sb-…-auth-token`, and a
//     cache-busted `/receivables?cb=…` correctly redirects to /login.
//   · NOT the bfcache — `pageshow` fires with `persisted=false`.
//   · NOT fixable from middleware — Next overwrites Cache-Control on its own
//     page responses.
//   · NOT worth a next.config.ts `headers()` entry — that REPLACES production's
//     header with a weaker one, dropping `private` (which is what stops a
//     shared proxy storing an authenticated page). Measured, then reverted.
import {
  launch, login, goto, step, check, summary, APP,
} from "./qa-lib.mjs";

const { browser, page, errors } = await launch();

try {
  step("Back after sign-out must not restore an authenticated page");

  const res = await page.goto(`${APP}/login`, { waitUntil: "load", timeout: 60000 });
  const cc = res.headers()["cache-control"] ?? "(none)";
  const isProd = /no-store/.test(cc);
  check(isProd, "documents are served with `no-store` (i.e. a production build)", cc);
  if (!isProd) {
    console.log("\n  Cache-Control is `" + cc + "` — this is the dev server.");
    console.log("  Back-navigation reuse is EXPECTED here and is not a defect.");
    console.log("  Run `npm run build && npx next start -p 3000`, then re-run.");
  }

  await login(page, "owner");
  // Two real document loads, so there is an authenticated entry deeper in the
  // history stack — with only one entry the bug hides.
  for (const path of ["/receivables", "/movements"]) {
    await goto(page, path);
    await page.waitForTimeout(2500);
  }

  await page.locator("header button").last().click();
  await page.waitForTimeout(900);
  await page.getByRole("menuitem", { name: /Sign out/ }).click();
  await page.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  check(new URL(page.url()).pathname === "/login", "sign out lands on /login",
    new URL(page.url()).pathname);

  await page.goBack().catch(() => {});
  await page.waitForTimeout(6000);
  const path = new URL(page.url()).pathname;
  const txt = await page.evaluate(() => document.body.innerText);
  const money = /₱[\d,]+/.test(txt);
  const sidebar = /Approval Queue|OVERVIEW/i.test(txt);

  check(!money, "❌ no money figures after Back", money ? "money still on screen" : "clean");
  check(!sidebar, "❌ no authenticated sidebar after Back",
    sidebar ? "sidebar still rendered" : "clean");
  check(path === "/login" || /Welcome back/.test(txt),
    "Back lands on (or redirects to) the login page", path);
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 5) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
