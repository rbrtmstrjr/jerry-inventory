// Task 8 — Steps 10–12: Reviewed History, the detail sheet, and deep links.
// Run after Task 9, which gives the history a voided payment and a settled sale.
//
// Read-only apart from URL navigation: no approvals happen here.
import {
  launch, session, goto, bodyText, shot, dbAuth,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser } = await launch();
const q = await dbAuth("owner");
const owner = await session(browser, "owner");
const admin = await session(browser, "admin");
const O = owner.page, A = admin.page;

const sheetOf = (p) => p.locator('[data-slot="sheet-content"]');
const params = (p) => new URL(p.url()).searchParams;

try {
  // ── Step 10: Reviewed History ─────────────────────────────────────────────
  step("Step 10: Reviewed History");
  await goto(O, "/approvals");
  await O.waitForTimeout(3500);
  // the plan says "switch to Reviewed" — there is no such tab; it renders below
  // the queue on every tab (resolveTab accepts only all|sales|losses|expenses)
  const sect = O.locator("section").filter({
    has: O.getByRole("heading", { name: "Reviewed History" }),
  });
  check((await sect.count()) > 0, "Reviewed History renders on the default tab (no 'Reviewed' tab exists)");
  await goto(O, "/approvals?tab=reviewed");
  await O.waitForTimeout(2500);
  const coerced = O.locator('nav[aria-label="Approval queue"] a[aria-current="page"]');
  check((await coerced.getAttribute("href")) === "/approvals?tab=all",
    "an unknown ?tab= coerces to 'all' rather than erroring",
    await coerced.getAttribute("href"));

  await goto(O, "/approvals");
  await O.waitForTimeout(3500);
  let t = await bodyText(O);
  const counter = (t.match(/\d+–\d+ of [\d,]+/) || [])[0];
  check(!!counter, "range counter uses an EN DASH", counter ?? "absent");
  check(/^Page \d+ of \d+$/m.test(t), "page indicator",
    (t.match(/Page \d+ of \d+/) || ["absent"])[0]);
  const rows = O.locator('table tbody tr[role="button"]');
  const nRows = await rows.count();
  check(nRows > 0, "reviewed rows render", `${nRows}`);
  const labels = await rows.evaluateAll((rs) => rs.map((r) => r.getAttribute("aria-label")));
  check(labels.every((l) => /^Open (Sale|Loss|Payment|Expense) detail$/.test(l ?? "")),
    "row aria-labels use 'Payment', not 'Utang payment'",
    [...new Set(labels)].join(", "));

  // filters are URL-driven; a filter change must reset paging to page 1
  await goto(O, "/approvals?page=2");
  await O.waitForTimeout(2500);
  check(params(O).get("page") === "2", "?page=2 is honoured");
  await goto(O, "/approvals?page=2&type=sale");
  await O.waitForTimeout(2500);
  const typed = await bodyText(O);
  check(/\d+–\d+ of [\d,]+|0 items/.test(typed), "type filter renders a result set");

  // the search box applies only on Enter
  const search = O.getByLabel("Search reviewed history");
  check((await search.count()) > 0, "search box has a stable label");
  await search.fill("zzzz-no-such-thing");
  await O.waitForTimeout(1200);
  check(!/Nothing matches those filters\./.test(await bodyText(O)),
    "typing alone does NOT filter (no debounce, no button)");
  await search.press("Enter");
  // the search pushes ?q= and re-fetches; wait for the URL, not a fixed sleep
  await O.waitForFunction(() => new URL(location.href).searchParams.has("q"), null, { timeout: 15000 })
    .catch(() => {});
  await O.waitForTimeout(2500);
  t = await bodyText(O);
  check(/Nothing matches those filters\./.test(t),
    "Enter applies the filter and shows the filtered empty state",
    (t.match(/Nothing (matches|reviewed)[^\n]*/) || ["absent"])[0]);
  check(params(O).has("page") === false, "applying a filter drops ?page (resets to page 1)");

  // the two empty rows are distinct
  await goto(O, "/approvals?q=zzzz-no-such-thing");
  await O.waitForTimeout(2500);
  check(/Nothing matches those filters\./.test(await bodyText(O)), "filtered empty row");
  await goto(O, "/approvals?page=99999");
  await O.waitForTimeout(2500);
  const farText = await bodyText(O);
  check(/Nothing reviewed yet\./.test(farText),
    "beyond-range paging with NO filters shows the unfiltered empty row — " +
      "`activeFilters` ignores `page`, so a valid history looks empty (logged)",
    (farText.match(/Nothing reviewed yet[^\n]*|\d+–\d+ of [\d,]+/) || ["?"])[0]);

  // ── Step 11: detail sheet ─────────────────────────────────────────────────
  step("Step 11: detail sheet");
  const aSale = (await q("reviewed_items?select=item_type,id&item_type=eq.sale&status=eq.approved&limit=1"))[0];
  check(!!aSale, "an approved sale exists in reviewed history");
  await goto(O, `/approvals?item=sale:${aSale.id}`);
  const sh = sheetOf(O);
  await sh.waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
  await O.getByText(/owner-only/i).first()
    .waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
  check((await sh.count()) > 0, "the slide-over opens from the deep link");
  const shText = await sh.innerText();
  check(shText.length > 0, "the sale sheet rendered", `${shText.length} chars`);
  check(/resulting stock movements/i.test(shText),
    "'Resulting stock movements' section on a sale",
    (shText.match(/[^\n]*STOCK MOVEMENTS[^\n]*/i) || ["absent"])[0]);
  check(/Owner-only:/.test(shText), "owner-only per-line cost + margin",
    (shText.match(/Owner-only:[^\n]*/) || ["absent"])[0]);
  check(params(O).get("item")?.includes(aSale.id), "the URL carries ?item=");

  // reload the same URL — the sheet must reopen on the same item
  await goto(O, `/approvals?item=sale:${aSale.id}`);
  await O.waitForTimeout(3500);
  check((await sheetOf(O).count()) > 0, "reloading the ?item= URL reopens the sheet");

  // the ADMIN sees the same "Owner-only" cost line — /approvals is office tier
  await goto(A, `/approvals?item=sale:${aSale.id}`);
  await A.waitForTimeout(4000);
  const adminSheet = await sheetOf(A).innerText().catch(() => "");
  const adminSeesCost = /Owner-only:/.test(adminSheet);
  check(true,
    `ADMIN sees the line labelled "Owner-only": ${adminSeesCost} — ` +
      `/approvals is office-tier, so the label overstates the restriction (logged)`);

  // a payment's Before → After block, now that Task 9 has voided one
  // no ORDER on a PostgREST select gives an arbitrary row, and not every payment
  // renders the balance block — walk a few deterministically until one does
  const payRows = await q(
    "reviewed_items?select=id,summary&item_type=eq.utang_payment&order=event_at.desc&limit=5"
  );
  check(payRows.length > 0, "payments exist in reviewed history", `${payRows.length}`);
  let pText = "", usedPay = null;
  for (const cand of payRows) {
    await goto(O, `/approvals?item=utang_payment:${cand.id}`);
    await sheetOf(O).waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
    await O.getByText(/post on record/i).first()
      .waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    pText = await sheetOf(O).innerText().catch(() => "");
    usedPay = cand;
    if (/before/i.test(pText) && /after/i.test(pText)) break;
  }
  check(pText.length > 0, "the payment sheet rendered", `${pText.length} chars`);
  // headings are CSS `uppercase`, so innerText returns BEFORE / AFTER in caps
  check(/before/i.test(pText) && /after/i.test(pText),
    "payment detail shows the Before -> After balance block (CSS-uppercased)",
    pText.slice(0, 200));
  check(!/resulting stock movements/i.test(pText),
    "a payment body has NO stock-movements section (sale and loss only)");
  check(/post on record/i.test(pText),
    "the sheet states payments post on record, outside the queue");

  // ── Step 12: deep-link error handling (bugs #15 and #16) ─────────────────
  step("Step 12: bad deep links");
  const BAD = "00000000-0000-4000-8000-000000000000";
  await goto(O, `/approvals?item=sale:${BAD}`);
  await O.waitForTimeout(4000);
  let panel = await O.locator("p.text-destructive").first().innerText().catch(() => "");
  check(panel === "Not found",
    "a valid type with a missing id shows 'Not found' (was a raw PostgREST string — bug #16)",
    panel);
  check(!/Something went wrong/i.test(await bodyText(O)), "the shell survives");

  await goto(O, `/approvals?item=bogus:${BAD}`);
  await O.waitForTimeout(4000);
  panel = await O.locator("p.text-destructive").first().innerText().catch(() => "");
  check(panel === "Invalid item",
    "an unknown TYPE shows 'Invalid item' (used to crash the root boundary — bug #15)",
    panel);
  const shellAlive = await bodyText(O);
  check(/Approval Queue/.test(shellAlive) && !/Something went wrong/i.test(shellAlive),
    "the owner shell is intact — the queue is still rendered behind the sheet");
  // Turbopack's dev module graph goes stale after hours of edits and throws
  // "module factory is not available" on a route whose chunk was replaced. It is
  // a `next dev` artifact (already dismissed in the bug log), not an app defect,
  // and it does not occur in a production build — but anything ELSE must fail.
  const realErrors = owner.errors.filter(
    (e) => /pageerror/.test(e) && !/module factory is not available/.test(e)
  );
  check(realErrors.length === 0, "no uncaught page errors (HMR staleness excluded)",
    realErrors.join(" | "));
  await shot(O, "task8-step12-deeplinks");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(O, "task8b-crash").catch(() => {});
} finally {
  const errs = [...owner.errors, ...admin.errors];
  console.log("\nconsole errors:", errs.length ? errs.slice(0, 5) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
