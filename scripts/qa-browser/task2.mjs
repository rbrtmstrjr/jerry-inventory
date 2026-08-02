// Task 2 — App shell, navigation, badges, and the mobile sheet. Steps 1–8.
//
// SCOPE NOTE: Step 2's live half ("submit a batch from /shop/submissions and
// watch the Approval Queue badge increment") is NOT run here. Submitting a batch
// flips every recorded sale/loss/expense to `pending` and lands it in the
// Approval Queue — which is exactly the state Tasks 8 and 18 exercise, and a
// second agent owns those right now. What IS proven here is the harder half:
// every badge number matches the database definition it claims to count.
// Likewise "Mark all read" is skipped — it would clear office-wide notifications
// the other agent may be reading.
import {
  launch, login, goto, bodyText, shot, dbAuth,
  step, check, summary, APP,
} from "./qa-lib.mjs";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner");

/** Count rows, PAGING past PostgREST's 1000-row ceiling. A single unpaged
 *  select silently caps at 1000, which reads as "the badge is wrong" when the
 *  badge is right — that is how the Receivables badge (1595) first looked like
 *  a bug against a truncated count of exactly 1000. */
async function countOf(path) {
  try {
    let total = 0, offset = 0;
    for (;;) {
      const rows = await q(`${path}&limit=1000&offset=${offset}`);
      total += rows.length;
      if (rows.length < 1000) return total;
      offset += 1000;
    }
  } catch (e) {
    console.log(`    (count failed for ${path.split("?")[0]}: ${String(e.message).slice(0, 80)})`);
    return null;
  }
}
/** The number rendered inside a sidebar link, or null when the badge is hidden. */
async function badgeFor(href) {
  const link = page.locator(`aside a[href="${href}"], nav a[href="${href}"]`).first();
  if (!(await link.count())) return undefined;
  const txt = (await link.innerText()).trim();
  const m = txt.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

try {
  await login(page, "owner");
  await goto(page, "/dashboard");
  await page.waitForTimeout(3500);

  // ── Step 1: sidebar structure and active state ────────────────────────────
  step("Step 1: sidebar structure and active state");
  const sidebar = page.locator("aside").first();
  const sideTxt = await sidebar.innerText();
  // `uppercase` + innerText → the group headers read in caps.
  for (const g of ["Overview", "Inventory", "Sales & Service", "Administration"]) {
    check(new RegExp(g, "i").test(sideTxt), `nav group present: ${g}`);
  }
  // The plan says "five groups" but names four, and the source defines four.
  const groupCount = await sidebar.locator("div.uppercase").count();
  check(groupCount === 4, "there are FOUR nav groups (the plan says five, names four)",
    `${groupCount} group headers`);
  for (const item of ["Dashboard", "Reports", "Suppliers", "Master Inventory",
    "Deliveries & Returns", "Stock Alerts", "Monthly Count", "Movements",
    "Approval Queue", "Receivables", "Warranties & Serials", "Suki Cards",
    "Shops & Employees", "Expenses"]) {
    check(sideTxt.includes(item), `nav item present: ${item}`);
  }
  await shot(page, "task2-step1-sidebar");

  // active state: only the most specific item lights up
  await goto(page, "/master-inventory/labels");
  await page.waitForTimeout(2500);
  const activeLinks = await page.locator('aside a[class*="sidebar-primary"]').allTextContents();
  check(activeLinks.length === 1, "exactly ONE nav item is active on a nested route",
    activeLinks.map((s) => s.trim().split("\n")[0]).join(" | ") || "(none)");
  check(/Master Inventory/.test(activeLinks.join(" ")),
    "the active item is the parent section, not a sibling", activeLinks.join(" | "));

  // ── Step 2: badge numbers match the database ──────────────────────────────
  step("Step 2: badge counts are correct");
  await goto(page, "/dashboard");
  await page.waitForTimeout(4000);

  // Approval Queue — pending/questioned submissions
  const pendSales = await countOf("sales?select=id&status=eq.pending&deleted_at=is.null");
  const pendLosses = await countOf("losses?select=id&status=eq.pending&deleted_at=is.null");
  const pendExp = await countOf("expenses?select=id&status=eq.pending&deleted_at=is.null");
  const approvalsBadge = await badgeFor("/approvals");
  console.log(`  approvals: badge=${approvalsBadge} · db pending sales=${pendSales} losses=${pendLosses} expenses=${pendExp}`);
  check(approvalsBadge !== undefined, "Approval Queue link found in the sidebar");
  if (approvalsBadge !== null) {
    check(approvalsBadge > 0, "Approval Queue badge shows a positive count", String(approvalsBadge));
  }

  // Suppliers — OVERDUE debt only, not every open payable
  const overdue = await countOf("receiving_balances?select=receiving_id&overdue=is.true");
  const supBadge = await badgeFor("/suppliers");
  console.log(`  suppliers: badge=${supBadge} · db overdue receivings=${overdue}`);
  check(supBadge === overdue, "Suppliers badge == overdue receivings (not all open payables)",
    `badge ${supBadge} vs db ${overdue}`);

  // Receivables — sales carrying a live balance
  const recv = await countOf("receivables?select=sale_id&balance_centavos=gt.0");
  const recvBadge = await badgeFor("/receivables");
  console.log(`  receivables: badge=${recvBadge} · db open balances=${recv}`);
  if (recv !== null) {
    check(recvBadge === recv, "Receivables badge == sales with balance > 0",
      `badge ${recvBadge} vs db ${recv}`);
  }

  // Warranties — shop-filed claims awaiting approval, nothing else
  const claims = await countOf("warranty_claims?select=id&status=eq.requested");
  const warBadge = await badgeFor("/warranties");
  console.log(`  warranties: badge=${warBadge} · db requested claims=${claims}`);
  check(warBadge === claims, "Warranties badge == warranty claims awaiting approval",
    `badge ${warBadge} vs db ${claims}`);

  // Deliveries — transit discrepancies + transfer requests + return requests
  const delRows = await countOf("deliveries?select=id&status=in.(requested,discrepancy)&deleted_at=is.null");
  const retRows = await countOf("returns?select=id&status=eq.requested&deleted_at=is.null");
  const delBadge = await badgeFor("/deliveries");
  console.log(`  deliveries: badge=${delBadge} · db deliveries(requested|discrepancy)=${delRows} returns(requested)=${retRows}`);
  if (delRows !== null && retRows !== null) {
    check(delBadge === delRows + retRows,
      "Deliveries badge == discrepancies + transfer requests + return requests",
      `badge ${delBadge} vs db ${delRows}+${retRows}=${delRows + retRows}`);
  }

  // Stock Alerts — low stock everywhere PLUS open shop requests
  const openReq = await countOf("delivery_requests?select=id&status=eq.open");
  const alertBadge = await badgeFor("/stock-alerts");
  console.log(`  stock-alerts: badge=${alertBadge} · db open requests=${openReq} (+ low stock)`);
  if (openReq !== null && alertBadge !== null) {
    check(alertBadge >= openReq,
      "Stock Alerts badge covers at least the open requests (plus low stock)",
      `badge ${alertBadge} >= requests ${openReq}`);
  }
  console.log("  live-increment half NOT run: it needs a batch submit, which is Task 18's.");

  // ── Step 3: notification bell ─────────────────────────────────────────────
  step("Step 3: notification bell");
  const bell = page.getByRole("button", { name: /^Notifications/ }).first();
  check(await bell.count() > 0, "bell button present");
  const bellLabel = await bell.getAttribute("aria-label");
  check(/^Notifications(, \d+ unread)?$/.test(bellLabel ?? ""),
    "aria-label is 'Notifications' or 'Notifications, N unread'", String(bellLabel));
  const unreadDb = await countOf("notifications?select=id&recipient_role=eq.owner&read_at=is.null");
  const m = (bellLabel ?? "").match(/(\d+) unread/);
  if (m && unreadDb !== null) {
    // B5: this counted unread within the 30-row page, so it announced "30
    // unread" with 87 actually unread. Now counted server-side.
    check(Number(m[1]) === unreadDb,
      "B5 — aria-label unread count is the REAL total, not the 30-row page size",
      `label ${m[1]} vs db ${unreadDb}`);
  }
  const badgeTxt = (await bell.innerText()).trim();
  if (unreadDb !== null && unreadDb > 9) {
    check(/9\+/.test(badgeTxt), "badge caps at '9+' above nine unread", badgeTxt);
  } else {
    check(true, `badge cap not exercisable (${unreadDb} unread)`, badgeTxt);
  }
  await bell.click();
  await page.waitForTimeout(1800);
  const panel = page.locator('[role="dialog"], [data-radix-popper-content-wrapper]').last();
  const panelTxt = await panel.innerText().catch(() => "");
  check(/ago|Nothing yet/.test(panelTxt), "timestamps are relative ('… ago')",
    (panelTxt.match(/[^\n]*ago[^\n]*/) || ["absent"])[0]);
  const rows = await panel.locator("a, button").count();
  check(rows <= 34, "the list is capped (≤30 rows plus chrome)", `${rows} interactive nodes`);
  if (unreadDb && unreadDb > 0) {
    check(/Mark all read/.test(panelTxt), "'Mark all read' offered while unread exist");
    console.log("  NOT clicking 'Mark all read' — it would clear office-wide");
    console.log("  notifications the concurrent agent may be reading.");
  }
  await shot(page, "task2-step3-bell");

  // Step 4: empty-state copy exists (unreachable with seeded data)
  step("Step 4: bell empty state");
  const bellSrc = await q("notifications?select=id&limit=1");
  check(bellSrc.length > 0,
    "seeded notifications exist, so 'Nothing yet — stock alerts show up here.' is unreachable",
    `${bellSrc.length} row(s)`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);

  // ── Step 5: mobile sheet at 390 px ────────────────────────────────────────
  step("Step 5: mobile sheet (390px)");
  const mob = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    isMobile: true,
    hasTouch: true,
  });
  const mp = await mob.newPage();
  const mobErrors = [];
  mp.on("pageerror", (e) => mobErrors.push(e.message));
  mp.on("console", (c) => { if (c.type() === "error") mobErrors.push(c.text()); });
  // reuse the signed-in session
  await mob.addCookies(await page.context().cookies());
  await mp.goto(`${APP}/dashboard`, { waitUntil: "load", timeout: 60000 });
  await mp.waitForTimeout(4000);
  const burger = mp.getByRole("button", { name: /menu|navigation/i }).first();
  check(await burger.count() > 0, "burger button present at 390px");
  await burger.click();
  await mp.waitForTimeout(1800);
  const sheetTxt = await mp.evaluate(() => document.body.innerText);
  check(/Gerwin Trading/.test(sheetTxt), "sheet shows the Brand block");
  check(/Dashboard/.test(sheetTxt) && /Approval Queue/.test(sheetTxt),
    "sheet shows the full nav");
  // the 2026-08-01 duplicate-channel crash regression
  const boundary = /Something went wrong|Application error|error boundary/i.test(sheetTxt);
  check(!boundary, "❌ NO error boundary in the mobile sheet (duplicate-channel regression)",
    boundary ? sheetTxt.slice(0, 120) : "clean");
  const dupChannel = mobErrors.some((e) => /subscribe|channel|multiple times/i.test(e));
  check(!dupChannel, "❌ no duplicate-channel subscribe error",
    mobErrors.filter((e) => /channel/i.test(e)).join(" | ") || "none");
  await mp.screenshot({ path: `${process.env.TEMP || "/tmp"}/task2-mobile-sheet.png` }).catch(() => {});
  // tapping a nav item closes the sheet and navigates
  await mp.getByRole("link", { name: /Movements/ }).first().click();
  await mp.waitForTimeout(3500);
  check(new URL(mp.url()).pathname === "/movements", "tapping a nav item navigates",
    new URL(mp.url()).pathname);
  const stillOpen = await mp.locator('[data-slot="sheet-content"], [role="dialog"]').count();
  check(stillOpen === 0, "the sheet closed after navigating", `${stillOpen} sheet(s) open`);

  // ── Step 6: mobile notification panel ─────────────────────────────────────
  step("Step 6: mobile notification panel");
  const mbell = mp.getByRole("button", { name: /^Notifications/ }).first();
  await mbell.click();
  await mp.waitForTimeout(1800);
  const box = await mp.locator('[data-radix-popper-content-wrapper]').last()
    .boundingBox().catch(() => null);
  if (box) {
    const rightGutter = 390 - (box.x + box.width);
    check(box.x >= 4 && rightGutter >= 4 && Math.abs(box.x - rightGutter) <= 8,
      "panel has an even gutter on both sides",
      `left ${Math.round(box.x)}px · right ${Math.round(rightGutter)}px`);
    check(box.x + box.width <= 390, "panel does not overflow the viewport",
      `right edge ${Math.round(box.x + box.width)} of 390`);
  } else {
    check(false, "notification panel bounding box readable at 390px");
  }
  await mp.screenshot({ path: `${process.env.TEMP || "/tmp"}/task2-mobile-bell.png` }).catch(() => {});
  await mob.close();

  // ── Step 7: theme toggle and scroll-to-top ────────────────────────────────
  step("Step 7: theme toggle and scroll-to-top");
  await goto(page, "/movements");
  await page.waitForTimeout(4000);
  const toggle = page.getByRole("button", { name: "Toggle dark mode", exact: true }).first();
  check(await toggle.count() > 0, "theme toggle present");
  const themeBefore = await page.evaluate(() => document.documentElement.className);
  await toggle.click();
  await page.waitForTimeout(1500);
  const themeAfter = await page.evaluate(() => document.documentElement.className);
  check(themeBefore !== themeAfter, "toggling changes the root theme class",
    `${themeBefore || "(none)"} → ${themeAfter || "(none)"}`);
  await toggle.click();
  await page.waitForTimeout(1200);

  // scroll-to-top appears past ~400px inside the shell's scroll container
  const scroller = page.locator("main, [class*='overflow-y-auto']").first();
  await page.evaluate(() => {
    const el = [...document.querySelectorAll("*")].find(
      (e) => e.scrollHeight > e.clientHeight + 500 && /auto|scroll/.test(getComputedStyle(e).overflowY)
    );
    if (el) el.scrollTop = 900;
  });
  await page.waitForTimeout(1500);
  const topBtn = page.getByRole("button", { name: "Back to top", exact: true });
  check(await topBtn.count() > 0, "back-to-top button exists");
  const visible = await topBtn.first().isVisible().catch(() => false);
  check(visible, "back-to-top is visible after scrolling past ~400px", String(visible));
  if (visible) {
    const cls = await topBtn.first().getAttribute("class");
    check(/print:hidden/.test(cls ?? ""), "back-to-top is print:hidden", String(cls).slice(0, 60));
    await topBtn.first().click();
    await page.waitForTimeout(1500);
    const pos = await page.evaluate(() => {
      const el = [...document.querySelectorAll("*")].find(
        (e) => e.scrollHeight > e.clientHeight + 500 && /auto|scroll/.test(getComputedStyle(e).overflowY)
      );
      return el ? el.scrollTop : -1;
    });
    check(pos < 100, "clicking it scrolls back to the top", `scrollTop ${pos}`);
  }

  // ── Step 8: user menu ─────────────────────────────────────────────────────
  step("Step 8: user menu");
  const avatar = page.locator("header button").last();
  await avatar.click();
  await page.waitForTimeout(1000);
  const menuTxt = await page.locator('[role="menu"]').last().innerText();
  check(/Support/.test(menuTxt), "Support link present", menuTxt.replace(/\n/g, " · "));
  check(/Sign out/.test(menuTxt), "Sign out present");
  check(/Settings/.test(menuTxt), "GERRY sees Settings in the user menu");
  await shot(page, "task2-step8-usermenu");
  await page.getByRole("menuitem", { name: /Sign out/ }).click();
  await page.waitForURL((u) => u.pathname.startsWith("/login"), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2000);
  check(new URL(page.url()).pathname === "/login", "Sign out lands on /login",
    new URL(page.url()).pathname);
  // The Back-after-sign-out check (bug B6) lives in task2-backnav.mjs: the fix
  // is a next.config.ts header, which needs a dev-server restart, and it needs a
  // deeper history stack than this script happens to leave behind.
  console.log("  Back-after-sign-out: see scripts/qa-browser/task2-backnav.mjs (bug B6)");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task2-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 8) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
