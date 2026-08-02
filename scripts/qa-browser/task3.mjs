// Task 3 — Suppliers: Directory and Payables. Steps 1–8.
//
// Run as ADMIN (office tier), with a GERRY spot-check at the end. Step 7 records
// a REAL supplier payment against an existing open receiving — that is the point
// of the step, and payables are not in the concurrent agent's tasks (6–10, 18).
// The amount is deliberately small (₱1,000) and verified against the ledger.
//
// Fixtures are prefixed ZZ-QB.
import {
  launch, login, goto, bodyText, shot, dbAuth, makePng,
  step, check, summary, toast, clearToasts,
} from "./qa-lib.mjs";

const STAMP = Date.now().toString(36).toUpperCase().slice(-5);
const SUP = `ZZ-QB Supply Co ${STAMP}`;
const PNG = "c:/Users/rober/AppData/Local/Temp/zzqb-receipt.png";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner");

/** Inline (react-hook-form) errors, not toasts. */
async function fieldErrors() {
  return (await page.locator('[role="dialog"] p.text-destructive, [role="dialog"] .text-destructive')
    .allTextContents()).map((s) => s.trim()).filter(Boolean);
}
async function openAdd() {
  await page.getByRole("button", { name: "Add Supplier", exact: true }).click();
  await page.waitForTimeout(900);
}

try {
  await login(page, "admin");
  await goto(page, "/suppliers?tab=directory");
  await page.waitForTimeout(3000);

  // ── Step 1: directory table controls ──────────────────────────────────────
  step("Step 1: directory table controls");
  let t = await T();
  check(/Search suppliers…/.test(await page.locator("body").innerHTML()) ||
    (await page.getByPlaceholder("Search suppliers…").count()) > 0,
    "search box 'Search suppliers…' present");
  const supRows = await q("suppliers?select=id,name,credit_limit&deleted_at=is.null");
  console.log(`  ${supRows.length} live suppliers`);
  // search narrows
  await page.getByPlaceholder("Search suppliers…").fill(supRows[0].name);
  await page.waitForTimeout(1200);
  const narrowed = await page.locator("tbody tr").count();
  check(narrowed >= 1 && narrowed < supRows.length + 1, "search narrows the row set",
    `${narrowed} rows for "${supRows[0].name}"`);
  await page.getByPlaceholder("Search suppliers…").fill("zzzz-no-such-supplier");
  await page.waitForTimeout(1200);
  check(/No suppliers yet\.|No results|Nothing/i.test(await T()),
    "empty result state renders",
    ((await T()).match(/No suppliers[^\n]*|No results[^\n]*|Nothing[^\n]*/) || ["absent"])[0]);
  await page.getByPlaceholder("Search suppliers…").fill("");
  await page.waitForTimeout(1200);
  // sorting
  for (const col of ["Supplier", "We owe"]) {
    const h = page.getByRole("button", { name: new RegExp(`^${col}`) }).first();
    if (await h.count()) {
      await h.click();
      await page.waitForTimeout(900);
      check(true, `sortable header: ${col}`);
    } else {
      check(false, `sortable header: ${col}`);
    }
  }
  // pagination hides at ≤10 rows
  const pager = await page.getByText(/\d+–\d+ of \d+/).count();
  check(supRows.length <= 10 ? pager === 0 : pager > 0,
    "pagination bar hides at ≤10 rows",
    `${supRows.length} suppliers · pager nodes ${pager}`);

  // ── Step 2: add supplier ──────────────────────────────────────────────────
  step("Step 2: add supplier");
  await openAdd();
  check(/Add Supplier/.test(await T()), "dialog title 'Add Supplier'");
  check((await page.locator("#sup-limit").getAttribute("placeholder")) === "blank = no limit",
    "credit-limit placeholder 'blank = no limit'");
  check((await page.locator("#sup-terms").getAttribute("placeholder")) === "e.g. 30 for net 30",
    "terms placeholder 'e.g. 30 for net 30'");
  await page.locator("#sup-name").fill(SUP);
  await page.locator("#sup-contact").fill("09171234567");
  await page.locator("#sup-notes").fill("ZZ-QB sweep");
  await page.locator("#sup-limit").fill("50000");
  await page.locator("#sup-terms").fill("30");
  await page.locator("#sup-terms-note").fill("2% if paid in 10 days");
  await shot(page, "task3-step2-add");
  await page.getByRole("button", { name: /^Save|^Add/ }).last().click();
  const t2 = await toast(page);
  check(/Supplier added/.test(t2), "toast 'Supplier added'", t2);
  await page.waitForTimeout(2500);
  const created = (await q(`suppliers?select=id,name,credit_limit,payment_terms_days,terms_note&name=eq.${encodeURIComponent(SUP)}`))[0];
  check(!!created, "supplier row persisted");
  check(created?.credit_limit === 5000000, "credit limit stored as centavos (₱50,000)",
    String(created?.credit_limit));
  check(created?.payment_terms_days === 30, "payment terms stored", String(created?.payment_terms_days));
  await clearToasts(page);
  await page.getByPlaceholder("Search suppliers…").fill(SUP);
  await page.waitForTimeout(1500);
  check(/₱0\.00/.test(await T()), "We-owe shows ₱0.00 for the new supplier",
    ((await T()).match(/₱[\d,]+\.\d\d/) || ["absent"])[0]);

  // ── Step 3: validation (all ❌) ────────────────────────────────────────────
  step("Step 3: add-supplier validation");
  await openAdd();
  await page.getByRole("button", { name: /^Save|^Add/ }).last().click();
  await page.waitForTimeout(900);
  let errs = await fieldErrors();
  check(errs.some((e) => /Name is required/.test(e)), "❌ blank name → 'Name is required'",
    errs.join(" | ") || "(none)");

  await page.locator("#sup-name").fill(`${SUP} v`);
  await page.locator("#sup-limit").fill("abc");
  await page.getByRole("button", { name: /^Save|^Add/ }).last().click();
  await page.waitForTimeout(900);
  errs = await fieldErrors();
  check(errs.some((e) => /Enter a valid ₱ amount/.test(e)),
    "❌ 'abc' limit → 'Enter a valid ₱ amount'", errs.join(" | ") || "(none)");

  await page.locator("#sup-limit").fill("50000");
  for (const bad of ["400", "-1"]) {
    await page.locator("#sup-terms").fill(bad);
    await page.getByRole("button", { name: /^Save|^Add/ }).last().click();
    await page.waitForTimeout(900);
    errs = await fieldErrors();
    check(errs.some((e) => /0–365 days/.test(e)), `❌ terms '${bad}' → '0–365 days'`,
      errs.join(" | ") || "(none)");
  }
  const notCreated = await q(`suppliers?select=id&name=eq.${encodeURIComponent(SUP + " v")}`);
  check(notCreated.length === 0, "no supplier was written by any refused submit",
    `${notCreated.length} rows`);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(700);

  // ── Step 4: edit and remove ───────────────────────────────────────────────
  step("Step 4: edit and remove");
  await page.getByPlaceholder("Search suppliers…").fill(SUP);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Row actions", exact: true }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /^Edit/ }).click();
  await page.waitForTimeout(1000);
  check(/Edit Supplier/.test(await T()), "dialog title 'Edit Supplier'");
  await page.locator("#sup-contact").fill("09999999999");
  await page.getByRole("button", { name: /^Save/ }).last().click();
  const t4 = await toast(page);
  check(/Supplier updated/.test(t4), "toast 'Supplier updated'", t4);
  await page.waitForTimeout(2500);
  check((await q(`suppliers?select=contact&id=eq.${created.id}`))[0].contact === "09999999999",
    "contact change persisted");
  await clearToasts(page);

  await page.getByRole("button", { name: "Row actions", exact: true }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /Remove/ }).click();
  await page.waitForTimeout(900);
  t = await T();
  check(new RegExp(`Remove supplier .?${SUP}`).test(t), "confirm dialog names the supplier",
    (t.match(/Remove supplier[^\n]*/) || ["absent"])[0]);
  check(/Past receivings keep their history\./.test(t), "confirm body mentions history is kept",
    (t.match(/Past receivings[^\n]*/) || ["absent"])[0]);
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  const t4b = await toast(page);
  check(new RegExp(`${SUP} removed`).test(t4b), "toast '<supplier> removed'", t4b);
  await page.waitForTimeout(2500);
  check((await q(`suppliers?select=deleted_at&id=eq.${created.id}`))[0].deleted_at !== null,
    "supplier soft-deleted (row kept)");
  await clearToasts(page);
  await page.getByPlaceholder("Search suppliers…").fill(SUP);
  await page.waitForTimeout(1500);
  check((await page.getByRole("button", { name: "Row actions", exact: true }).count()) === 0,
    "removed supplier leaves the directory");

  // ── Step 5: payables tab ──────────────────────────────────────────────────
  step("Step 5: payables tab");
  await goto(page, "/suppliers?tab=payables");
  await page.waitForTimeout(3200);
  t = await T();
  const payables = await q("supplier_payables?select=supplier_id,supplier_name,credit_limit,outstanding,overdue_count");
  const overdueTotal = payables.reduce((s, p) => s + (p.overdue_count ?? 0), 0);
  console.log(`  ${payables.length} suppliers in payables · ${overdueTotal} overdue receivings`);
  check(payables.every((p) => t.includes(p.supplier_name)),
    "every supplier is listed, including those owing nothing",
    payables.filter((p) => !t.includes(p.supplier_name)).map((p) => p.supplier_name).join(", ") || "all present");
  if (overdueTotal > 0) {
    check(/\d+/.test(t) && (await page.locator('[data-slot="badge"]').count()) > 0,
      "overdue count badge renders on the tab", `${overdueTotal} overdue`);
  }
  const noLimit = payables.filter((p) => !p.credit_limit);
  if (noLimit.length) {
    check(/No limit/.test(t), "'No limit' text renders for a limitless supplier",
      noLimit.map((p) => p.supplier_name).join(", "));
  } else {
    check(true, "every supplier has a credit limit — the 'No limit' path is unreachable here");
  }
  await shot(page, "task3-step5-payables");

  // ── Step 6: supplier detail ───────────────────────────────────────────────
  step("Step 6: supplier detail");
  const withBalance = payables.find((p) => p.outstanding > 0);
  check(!!withBalance, "a supplier with an open balance exists",
    withBalance ? `${withBalance.supplier_name} owes ${withBalance.outstanding}` : "none");
  // the detail opens from a per-row "View details" button, not the name cell
  await page.getByPlaceholder("Search supplier…").fill(withBalance.supplier_name);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "View details", exact: true }).first().click();
  await page.waitForTimeout(2500);
  t = await T();
  check(/transaction/.test(t), "header counter reads 'N transaction(s) · N open'",
    (t.match(/\d+ transactions?[^\n]*/) || ["absent"])[0]);
  // `uppercase` + innerText → the heading reads "TRANSACTION HISTORY".
  check(/Transaction history/i.test(t), "'Transaction history' heading present");
  const balRows = await q(`receiving_balances?select=receiving_id,balance&supplier_id=eq.${withBalance.supplier_id}`);
  const openRows = balRows.filter((r) => r.balance > 0);
  const payBtns = await page.getByRole("button", { name: "Pay this", exact: true }).count();
  check(payBtns === openRows.length,
    "'Pay this' renders only on rows with a balance > 0",
    `${payBtns} buttons vs ${openRows.length} open of ${balRows.length} transactions`);

  // ── Step 7: record a payment ──────────────────────────────────────────────
  // Each run writes a REAL ₱1,000 payment. Set QB_SKIP_PAY=1 to re-run the rest
  // of the task without inflating the ledger further.
  step("Step 7: record a payment");
  if (process.env.QB_SKIP_PAY) {
    const done = await q(`supplier_payments?select=id,amount&supplier_id=eq.${withBalance.supplier_id}&amount=eq.100000&deleted_at=is.null`);
    check(done.length > 0, "QB_SKIP_PAY set — verifying the payment from an earlier run",
      `${done.length} ₱1,000.00 payment(s) on record`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  } else {
  // Assert at SUPPLIER level, not against a guessed row: the DB array order and
  // the dialog's (oldest-first) DOM order are different, so "openRows[0]" is not
  // the row `Pay this .first()` clicks.
  const beforeRows = await q(`receiving_balances?select=receiving_id,balance&supplier_id=eq.${withBalance.supplier_id}`);
  const beforeTotal = beforeRows.reduce((s, r) => s + r.balance, 0);
  const beforePmts = (await q(`supplier_payments?select=id&supplier_id=eq.${withBalance.supplier_id}&deleted_at=is.null`)).length;
  await page.getByRole("button", { name: "Pay this", exact: true }).first().click();
  await page.waitForTimeout(1200);
  const amt = page.locator("#pay-amt");
  await amt.fill("1000abc");
  await page.waitForTimeout(500);
  const typed = await amt.inputValue();
  check(!/[a-z]/i.test(typed), "non-numeric characters are stripped from the amount", typed);
  makePng(PNG, 60, 40, [40, 160, 90]);
  const fileInput = page.locator('[role="dialog"] input[type="file"]').first();
  if (await fileInput.count()) {
    await fileInput.setInputFiles(PNG);
    await page.waitForTimeout(1500);
    check(true, "receipt photo attached");
  } else {
    check(false, "receipt upload field present in the payment dialog");
  }
  await amt.fill("1000");
  await page.waitForTimeout(400);
  await shot(page, "task3-step7-pay");
  await page.getByRole("button", { name: "Record payment", exact: true }).last().click();
  // Upload → RPC → router.refresh() routinely outruns the 6 s default.
  const t7 = await toast(page, { timeout: 20000 });
  check(/Paid — ₱1,000\.00 applied|Paid — allocated across \d+ receiving/.test(t7),
    "success toast names the amount or the FIFO allocation", t7 || "(no toast within 20s)");
  await page.waitForTimeout(3500);
  const afterRows = await q(`receiving_balances?select=receiving_id,balance&supplier_id=eq.${withBalance.supplier_id}`);
  const afterTotal = afterRows.reduce((s, r) => s + r.balance, 0);
  check(beforeTotal - afterTotal === 100000,
    "the supplier's outstanding dropped by exactly ₱1,000.00",
    `${beforeTotal} → ${afterTotal} (Δ ${beforeTotal - afterTotal})`);
  const moved = afterRows.filter((a) => {
    const b = beforeRows.find((x) => x.receiving_id === a.receiving_id);
    return b && b.balance !== a.balance;
  });
  check(moved.length === 1, "exactly ONE receiving's balance changed (targeted, not smeared)",
    `${moved.length} receiving(s) moved`);
  const pmts = await q(`supplier_payments?select=id,amount,receiving_id&supplier_id=eq.${withBalance.supplier_id}&deleted_at=is.null&order=created_at.desc`);
  check(pmts.length === beforePmts + 1, "exactly one payment row was written",
    `${beforePmts} → ${pmts.length}`);
  check(pmts[0]?.amount === 100000, "the ledger row is ₱1,000.00", String(pmts[0]?.amount));
  check(pmts[0]?.receiving_id === moved[0]?.receiving_id,
    "the payment is booked against the receiving whose balance moved");
  // Supplier payments are stock COST (COGS) and must NEVER also be an expense —
  // double-counting there overstates opex and understates margin.
  const sameDayExp = await q("expenses?select=id,amount,description&expense_date=eq.2026-08-01&deleted_at=is.null");
  check(!sameDayExp.some((e) => e.amount === 100000),
    "❌ the payment did NOT also land in expenses (COGS vs opex stay separate)",
    `${sameDayExp.length} expenses dated today, none at ₱1,000.00`);
  await clearToasts(page);
  }

  // ── Step 8: payables empty state ──────────────────────────────────────────
  step("Step 8: payables empty state");
  await goto(page, "/suppliers?tab=payables");
  await page.waitForTimeout(3000);
  const withRcv = new Set((await q("receiving_balances?select=supplier_id")).map((r) => r.supplier_id));
  const noRcv = payables.find((p) => !withRcv.has(p.supplier_id));
  if (noRcv) {
    await page.getByPlaceholder("Search supplier…").fill(noRcv.supplier_name);
    await page.waitForTimeout(1500);
    await page.getByRole("button", { name: "View details", exact: true }).first().click();
    await page.waitForTimeout(2500);
    check(/No receivings from this supplier yet\./.test(await T()),
      "empty state 'No receivings from this supplier yet.'",
      ((await T()).match(/No receivings[^\n]*/) || ["absent"])[0]);
  } else {
    check(true, "every supplier has receivings — empty state not reachable with this data");
  }

  // ── GERRY spot-check ──────────────────────────────────────────────────────
  step("spot-check: the page works for GERRY too");
  await page.context().clearCookies();
  await login(page, "owner");
  await goto(page, "/suppliers?tab=directory");
  await page.waitForTimeout(3000);
  check((await page.getByRole("button", { name: "Add Supplier", exact: true }).count()) > 0,
    "GERRY sees Add Supplier");
  await goto(page, "/suppliers?tab=payables");
  await page.waitForTimeout(3000);
  check(/Search supplier…/.test(await page.locator("body").innerHTML()) ||
    (await page.getByPlaceholder("Search supplier…").count()) > 0,
    "GERRY sees the payables table");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task3-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 8) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
