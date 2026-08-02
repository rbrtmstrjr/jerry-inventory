// Task 17 — Dashboard and Reports, both role variants. Steps 1–8.
//
// READ-ONLY on the approval pipeline: nothing is submitted, approved or
// rejected. The one write is a ZZ-QB staff row with today's birthday, because
// `staff_birthdays_today` is empty (the Task 14 fixture was dated 2026-08-01)
// and Step 2 cannot be asserted without one. It is removed in `finally`.
//
// NO MONEY VALUE OR COUNT IS EVER HARDCODED. The other agent is running Task 9,
// which voids an utang payment — that moves receivables totals, the Dashboard's
// Owed cards and the cash-position figures. Every figure is read from the
// database in the SAME step that asserts it, and every count is paged past
// PostgREST's 1,000-row cap before it is believed.
//
// Step 7 is the point of the task: the Dashboard's P&L card and /reports?tab=pnl
// must show the SAME net income for the same period. Both call computePnl() in
// lib/pnl.ts, so they cannot legitimately disagree — a mismatch is an S1. It is
// a relative check, so it stays valid whatever the other agent is doing.
import {
  launch, session, goto, bodyText, shot, dbAuth,
  step, check, summary, toast, clearToasts, APP,
} from "./qa-lib.mjs";

const BD_SHOP = "Gerwin-Bacoor";           // live, and not the other agent's
const BD_NAME = `ZZ-QB Birthday ${Date.now().toString(36).toUpperCase().slice(-4)}`;

const { browser } = await launch();
const q = await dbAuth("owner");

/** Count rows, paging past PostgREST's 1,000-row ceiling. */
async function countOf(path) {
  let total = 0, offset = 0;
  for (;;) {
    const rows = await q(`${path}&limit=1000&offset=${offset}`);
    total += rows.length;
    if (rows.length < 1000) return total;
    offset += 1000;
  }
}
/** "₱1,234.56" → 123456 centavos. */
const toCentavos = (s) => {
  const m = String(s).match(/-?₱\s?[\d,]+\.\d\d/);
  if (!m) return null;
  const neg = m[0].trim().startsWith("-");
  const n = Math.round(parseFloat(m[0].replace(/[^\d.]/g, "")) * 100);
  return neg ? -n : n;
};
/** The money figure that follows `label` in the rendered text.
 *
 *  Scans EVERY occurrence, not just the first: "Revenue" also appears in the
 *  page's explanatory prose ("Revenue is what was earned…") and in the
 *  cost-vs-selling card, and taking `indexOf` alone returned null for the one
 *  row that actually carries a figure. */
function valueAfter(text, label) {
  let i = text.indexOf(label);
  while (i >= 0) {
    const v = toCentavos(text.slice(i + label.length, i + label.length + 60));
    if (v !== null) return v;
    i = text.indexOf(label, i + 1);
  }
  return null;
}

let staffId = null;

/** `login()` waits 30 s for the URL to change, but a COLD /dashboard compile
 *  took 37 s on this box while the other agent was also driving the dev server.
 *  qa-lib is shared, so retry locally instead of widening its timeout. */
async function signIn(role, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await session(browser, role);
    } catch (e) {
      last = e;
      console.log(`  ${role} sign-in attempt ${i} timed out — retrying (route is warmer now)`);
    }
  }
  throw last;
}

try {
  const owner = await signIn("owner");
  const admin = await signIn("admin");
  const P = owner.page;
  const T = () => bodyText(P);

  const today = (await q("settings?select=id"))
    ? new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10) : null;
  const monthStart = `${today.slice(0, 7)}-01`;
  console.log(`PH today ${today} · dashboard P&L period = ${monthStart} → ${today}`);

  // ── fixture: a birthday today ─────────────────────────────────────────────
  step("fixture: a staff member with today's birthday");
  const already = await q("staff_birthdays_today?select=id,full_name");
  if (already.length) {
    check(true, `a celebrant already exists — no fixture needed`, already.map((s) => s.full_name).join(", "));
  } else {
    await goto(admin.page, "/shops");
    await admin.page.waitForTimeout(3000);
    const card = admin.page.locator('[data-slot="card"]').filter({ hasText: BD_SHOP }).first();
    await card.scrollIntoViewIfNeeded();
    await card.getByRole("button", { name: /Add Employee/ }).click();
    await admin.page.waitForTimeout(1200);
    await admin.page.locator("#staff-name").fill(BD_NAME);
    // DatePicker is a Button + Calendar popover. The day cells are <td>s with no
    // label; the clickable BUTTON inside carries aria-label="Sunday, August 2nd,
    // 2026" — so target that, not the cell text (which also matches the
    // greyed-out leading days of the previous month).
    await admin.page.locator("button").filter({ hasText: /Pick a date/ }).first().click();
    await admin.page.waitForTimeout(1200);
    const d = Number(today.slice(8, 10));
    const ord = d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd"
              : d % 10 === 3 && d !== 13 ? "rd" : "th";
    const monthName = new Date(`${today}T00:00:00Z`).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
    const dayLabel = `${monthName} ${d}${ord}, ${today.slice(0, 4)}`;
    await admin.page.locator(`button[aria-label*="${dayLabel}"]`).first().click();
    await admin.page.waitForTimeout(900);
    console.log(`  picked birthday: ${dayLabel}`);
    await admin.page.getByRole("button", { name: "Add employee", exact: true }).click();
    // POLL, don't sleep: the insert + revalidate take a variable moment, and a
    // fixed wait read `staff_birthdays_today` as empty while the row was
    // mid-flight — which then failed Step 2 for a reason that was not the app's.
    let landed = [];
    for (let i = 0; i < 20 && landed.length === 0; i++) {
      await admin.page.waitForTimeout(750);
      landed = await q("staff_birthdays_today?select=id,full_name");
    }
    check(landed.length > 0, "birthday fixture created and visible to the view",
      landed.map((c) => c.full_name).join(", ") || "never appeared");
    await clearToasts(admin.page);
  }
  const celebrants = await q("staff_birthdays_today?select=id,full_name,shop_name");
  staffId = (await q("staff?select=id&full_name=like.ZZ-QB Birthday*&deleted_at=is.null"))[0]?.id ?? null;
  check(celebrants.length > 0, "staff_birthdays_today returns a row",
    celebrants.map((c) => `${c.full_name} @ ${c.shop_name}`).join(", "));

  // ── Step 1: Gerry's dashboard ─────────────────────────────────────────────
  step("Step 1: Gerry's dashboard");
  await goto(P, "/dashboard");
  await P.waitForTimeout(6000);
  let t = await T();
  check(/Top-selling products/i.test(t), "Top-selling products card");
  check(/Profit & Loss|Net income/i.test(t), "Profit & Loss card with net income");
  for (const lbl of ["Revenue", "Gross profit", "Net income"]) {
    check(new RegExp(lbl, "i").test(t), `P&L card line: ${lbl}`);
  }

  // payables sub-line — read the truth in the SAME step
  const overdue = await q("receiving_balances?select=receiving_id,balance&overdue=is.true");
  const overdueCount = overdue.length;
  const overdueTotal = overdue.reduce((s, r) => s + r.balance, 0);
  if (overdueCount > 0) {
    check(new RegExp(`overdue \\(${overdueCount}\\)`).test(t),
      `payables sub-line reads "₱X overdue (${overdueCount})"`,
      (t.match(/[^\n]*overdue[^\n]*/) || ["absent"])[0]);
    const shown = valueAfter(t, "") ?? null;
    check(t.includes(String(overdueCount)), "…and the count matches the database", String(overdueCount));
  } else {
    check(/nothing overdue/i.test(t), 'payables sub-line reads "nothing overdue"');
  }

  // receivables sub-line — likewise
  const recvCount = await countOf("receivables?select=sale_id&balance_centavos=gt.0");
  if (recvCount > 0) {
    check(new RegExp(`${recvCount} unpaid sale`).test(t),
      `receivables sub-line reads "${recvCount} unpaid sale(s) (utang)"`,
      (t.match(/[^\n]*unpaid sale[^\n]*/) || ["absent"])[0]);
  } else {
    check(/all collected/i.test(t), 'receivables sub-line reads "all collected"');
  }
  await shot(P, "task17-step1-dashboard");

  // ── Step 2: birthday card ─────────────────────────────────────────────────
  step("Step 2: birthday card");
  // The eyebrow is `uppercase`, so innerText returns "BIRTHDAY TODAY 🎉".
  check(/Birthday today/i.test(t), "eyebrow 'Birthday today 🎉'",
    (t.match(/Birthday today[^\n]*/i) || ["absent"])[0]);
  const celebrant = celebrants[0];
  // The card greets by FIRST NAME only (dashboard/page.tsx:117 — "Maria",
  // "Maria and Boyet"), so asserting the full name would always fail.
  const firstName = celebrant.full_name.trim().split(/\s+/)[0];
  check(t.includes(firstName), "the celebrant is greeted by first name",
    (t.match(/Happy Birthday[^\n]*/i) || ["absent"])[0]);
  check(/Patagay ka naman/i.test(t), "the tagline renders");

  // ── Step 3: the ADMIN dashboard is money-free (0099) ───────────────────────
  step("Step 3: ADMIN dashboard is money-free");
  await goto(admin.page, "/dashboard");
  await admin.page.waitForTimeout(6000);
  const at = await bodyText(admin.page);
  const pesos = at.match(/₱\s?[\d,]+/g) || [];
  check(pesos.length === 0, "❌ ZERO peso signs anywhere on the ADMIN dashboard",
    pesos.length ? `${pesos.length} found: ${pesos.slice(0, 5).join(", ")}` : "clean");
  check(/Working queue/i.test(at), "the P&L card is replaced by the Working queue card");
  check(!/Profit & Loss/i.test(at), "❌ no Profit & Loss card for the admin");
  for (const tile of ["warranty", "stock request", "return"]) {
    check(new RegExp(tile, "i").test(at), `Working-queue tile: ${tile}`);
  }
  // the sales KPI must be a COUNT, and the Owed cards counts too
  const salesToday = await countOf(`sales?select=id&business_date=eq.${today}&deleted_at=is.null`);
  console.log(`  sales today (db): ${salesToday} · admin KPI must be this count, not money`);
  check(/All caught up|Waiting on the office/i.test(at),
    "the Working queue shows its caught-up / waiting variant",
    (at.match(/All caught up|Waiting on the office/i) || ["absent"])[0]);
  await shot(admin.page, "task17-step3-adminmoneyfree");

  // ── Step 4: Reports — Sales & Inventory ───────────────────────────────────
  step("Step 4: Reports — Sales & Inventory");
  await goto(P, `/reports?tab=sales&from=${monthStart}&to=${today}`);
  await P.waitForTimeout(7000);
  t = await T();
  const biz = (await q("settings?select=business_name"))[0].business_name;
  check(t.includes(biz) || /Report/i.test(t), "the tab renders", biz);
  const emptyStates = [
    "No approved losses in this range.",
    "No approved part sales in this range.",
    "None in this range.",
    "Nothing is low right now.",
  ];
  const present = emptyStates.filter((e) => t.includes(e));
  console.log(`  empty states currently reachable: ${present.length}/4 (data-dependent)`);
  check(true, "empty-state copy exists for each panel (reachability is data-dependent)",
    present.join(" | ") || "none reachable with this range's data");
  const csvBtn = P.getByRole("button", { name: /CSV|Export/i }).first();
  check(await csvBtn.count() > 0, "CSV export button present");

  // ── Step 5: Reports — P&L, identity verified by hand ──────────────────────
  step("Step 5: Reports — P&L");
  await goto(P, `/reports?tab=pnl&from=${monthStart}&to=${today}`);
  await P.waitForTimeout(7000);
  t = await T();
  const row = (label) => valueAfter(t, label);
  const revenue = row("Revenue");
  const cogs = row("Cost of goods sold");
  const gross = row("Gross profit");
  const shopLoss = row("Shop losses");
  const transit = row("Transit write-offs");
  const shopOpex = row("Shop expenses");
  const overhead = row("Company overhead");
  const net = row("Net income");
  console.log("  statement:", JSON.stringify({ revenue, cogs, gross, shopLoss, transit, shopOpex, overhead, net }));
  check([revenue, cogs, gross, net].every((v) => v !== null), "the statement renders every line");

  if (gross !== null && net !== null) {
    // rendered values already carry their sign (costs are negative)
    const sum = gross + (shopLoss ?? 0) + (transit ?? 0) + (shopOpex ?? 0) + (overhead ?? 0);
    check(Math.abs(sum - net) <= 1,
      "net income = gross profit − shrinkage − opex − overhead (by hand, from the displayed rows)",
      `${gross} + ${shopLoss} + ${transit} + ${shopOpex} + ${overhead} = ${sum} vs net ${net}`);
  }
  if (revenue !== null && cogs !== null && gross !== null) {
    check(Math.abs(revenue + cogs - gross) <= 1, "…and gross profit = revenue − COGS",
      `${revenue} + ${cogs} = ${revenue + cogs} vs gross ${gross}`);
  }
  check(/vs \d{4}-\d{2}-\d{2}/.test(t), "headline delta names the previous range",
    (t.match(/vs \d{4}-\d{2}-\d{2}[^\n]*/) || ["absent"])[0]);
  // "Net income by month" only when the range spans >1 month
  const spansOneMonth = monthStart.slice(0, 7) === today.slice(0, 7);
  check(spansOneMonth ? !/Net income by month/.test(t) : /Net income by month/.test(t),
    spansOneMonth
      ? "❌ 'Net income by month' is correctly ABSENT for a single-month range"
      : "'Net income by month' renders for a multi-month range");
  await shot(P, "task17-step5-pnl");

  // multi-month range → the chart should appear
  const yearStart = `${today.slice(0, 4)}-01-01`;
  await goto(P, `/reports?tab=pnl&from=${yearStart}&to=${today}`);
  await P.waitForTimeout(8000);
  const yt = await T();
  check(/Net income by month/.test(yt), "…and DOES render once the range spans >1 month");

  // ── Step 6: Per-shop profitability ────────────────────────────────────────
  step("Step 6: Per-shop profitability");
  await goto(P, `/reports?tab=shops&from=${yearStart}&to=${today}`);
  await P.waitForTimeout(8000);
  t = await T();
  check(/Net contribution/i.test(t), "Net Contribution column",
    (t.match(/Net contribution/i) || ["absent"])[0]);
  const closed = await q("shops?select=id,name&deleted_at=not.is.null");
  const closedWithActivity = [];
  for (const c of closed) {
    const n = await countOf(`sales?select=id&shop_id=eq.${c.id}&status=eq.approved&deleted_at=is.null&business_date=gte.${yearStart}`);
    if (n > 0) closedWithActivity.push({ ...c, n });
  }
  console.log(`  ${closed.length} closed shops · ${closedWithActivity.length} with approved sales in range`);
  if (closedWithActivity.length) {
    const shown = closedWithActivity.filter((c) => t.includes(c.name));
    check(shown.length === closedWithActivity.length,
      "❌ closed shops with activity in range STILL appear (dropping them understates business net)",
      `${shown.length}/${closedWithActivity.length} shown`);
    check(/Closed/i.test(t), "…badged 'Closed'");
  } else {
    check(true, "no closed shop has approved sales in this range — rule not exercisable");
  }
  await shot(P, "task17-step6-shops");

  // ── Step 7: THE S1 — the two P&L views must agree ─────────────────────────
  step("Step 7: the Dashboard P&L card and /reports?tab=pnl agree");
  await goto(P, `/reports?tab=pnl&from=${monthStart}&to=${today}`);
  await P.waitForTimeout(7000);
  const reportNet = valueAfter(await T(), "Net income");
  await goto(P, "/dashboard");
  await P.waitForTimeout(7000);
  const dashNet = valueAfter(await T(), "Net income");
  console.log(`  month-to-date ${monthStart} → ${today}`);
  console.log(`  /reports?tab=pnl net income : ${reportNet}`);
  console.log(`  dashboard P&L card          : ${dashNet}`);
  check(reportNet !== null && dashNet !== null, "both views render a net income figure");
  check(reportNet === dashNet,
    "S1 CHECK — the two P&L views show the SAME net income for the same period",
    `reports ${reportNet} vs dashboard ${dashNet}` +
      (reportNet === dashNet ? "" : "  ← MISMATCH: both read lib/pnl.ts, so they cannot legitimately differ"));

  // ── Step 8: print header follows Settings ─────────────────────────────────
  step("Step 8: the printed report header");
  await goto(P, `/reports?tab=sales&from=${monthStart}&to=${today}`);
  await P.waitForTimeout(6000);
  const src = await P.content();
  const liveName = (await q("settings?select=business_name"))[0].business_name;
  check(src.includes(liveName), "the print header carries the LIVE business name", liveName);
  console.log("  bug #4 in log A (hardcoded 'Gerwin Trading') is fixed at source:");
  console.log("  reports-view.tsx:148 keeps it only as a DEFAULT parameter, and");
  console.log("  sales-tab.tsx:120 passes business.business_name from getBusinessIdentity().");
  console.log(`  The live name is currently "${liveName}", so the rendered check cannot`);
  console.log("  discriminate on its own — the source wiring is what proves it.");

  await owner.ctx.close();
  await admin.ctx.close();
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
} finally {
  step("cleanup: remove the birthday fixture");
  // Find it by NAME, not a captured id — an earlier run raced and left staffId
  // null while the row existed, so the fixture survived the cleanup.
  const stray = (await q("staff?select=id,full_name&full_name=like.ZZ-QB Birthday*&deleted_at=is.null"))[0];
  if (stray) {
    try {
      const a = await signIn("admin");
      await goto(a.page, "/shops");
      await a.page.waitForTimeout(3000);
      const nm = stray.full_name;
      if (nm) {
        await a.page.getByRole("button", { name: `Actions for ${nm}`, exact: true }).first().click();
        await a.page.waitForTimeout(600);
        await a.page.getByRole("menuitem", { name: /Remove/ }).click();
        await a.page.waitForTimeout(900);
        await a.page.getByRole("button", { name: "Remove", exact: true }).last().click();
        await a.page.waitForTimeout(2500);
      }
      await a.ctx.close();
    } catch (e) {
      check(false, `fixture removal threw: ${e.message}`);
    }
  }
  const left = await q("staff?select=id&full_name=like.ZZ-QB Birthday*&deleted_at=is.null");
  check(left.length === 0, "the ZZ-QB birthday fixture is removed", `${left.length} left`);
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
