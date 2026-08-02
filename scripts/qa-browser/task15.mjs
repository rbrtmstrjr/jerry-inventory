// Task 15 — Expenses: log, categories, proposals, reports. Steps 1–11.
//
// APPROVAL QUEUE IS OFF LIMITS. Steps 5 and 7 inspect a seeded PENDING shop
// claim but never decide it — deciding belongs to the other agent's Task 8.
// Step 10 uses proposals THIS SCRIPT creates (from shop3, not shop1/shop2, so a
// batch submit in Task 18 cannot sweep them up) and exercises **Merge** and
// **Dismiss**, not Rename→approve.
//
// Rows are addressed by their own text/aria-label, never by index.
import {
  launch, login, goto, bodyText, shot, dbAuth, makePng, session,
  step, check, summary, toast, clearToasts, APP,
} from "./qa-lib.mjs";

const STAMP = Date.now().toString(36).toUpperCase().slice(-5);
const DESC = `ZZ-QB expense ${STAMP}`;
const CAT_NEW = `ZZ-QB Cat ${STAMP}`;
const PROP_MERGE = `ZZ-QB Proposal Merge ${STAMP}`;
const PROP_KEEP = `ZZ-QB Proposal Keep ${STAMP}`;
const PNG = "c:/Users/rober/AppData/Local/Temp/zzqb-exp-receipt.png";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner");

/** The row's own kebab, found by the description we typed. */
function rowMenu(desc) {
  return page.getByRole("button", { name: "Expense actions", exact: true });
}
async function openRecord() {
  await page.getByRole("button", { name: "Record expense", exact: true }).click();
  await page.waitForTimeout(1000);
}
/**
 * The button labelled `label` that belongs to the row containing `marker`.
 *
 * This is the README's rule made concrete: never address a row positionally.
 * For every candidate button, walk UP until an ancestor contains the marker;
 * the button with the shortest such walk is the one in that row. A container
 * `.filter({hasText})` does not work here — `.last()` lands on an inner div
 * that holds the text but none of the buttons.
 */
async function rowButton(marker, label) {
  const handle = await page.evaluateHandle(
    ([m, l]) => {
      // SMALLEST ancestor that contains the marker AND exactly one matching
      // button — the README's rule verbatim. Walking UP from each button
      // instead is subtly wrong: with several rows on screen it can settle on a
      // neighbour, which is how the first attempt dismissed the wrong proposal.
      let best = null;
      let bestSize = Infinity;
      for (const el of document.querySelectorAll("div,li,tr,section")) {
        const text = el.textContent || "";
        if (!text.includes(m)) continue;
        const btns = [...el.querySelectorAll("button")].filter((b) =>
          (b.textContent || "").trim().includes(l)
        );
        if (btns.length !== 1) continue;
        if (text.length < bestSize) { bestSize = text.length; best = btns[0]; }
      }
      return best;
    },
    [marker, label]
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no unique "${label}" button found in the row for "${marker}"`);
  return el;
}

/** Pick an option in a dialog Select identified by its current/placeholder text. */
async function pickIn(dialogSelectText, optionName) {
  await page.locator('[role="dialog"] button[role="combobox"]')
    .filter({ hasText: dialogSelectText }).first().click();
  await page.waitForTimeout(600);
  await page.getByRole("option", { name: optionName, exact: true }).first().click();
  await page.waitForTimeout(400);
}

try {
  // ═══ ADMIN half ═════════════════════════════════════════════════════════
  await login(page, "admin");
  await goto(page, "/expenses");
  await page.waitForTimeout(3500);

  // ── Step 1: record an expense ─────────────────────────────────────────────
  step("Step 1: record an expense (ADMIN)");
  await openRecord();
  let t = await T();
  check(/Operating costs — fuel, wages, utilities, rent, misc\./.test(t),
    "dialog description names operating costs",
    (t.match(/Operating costs[^\n]*/) || ["absent"])[0]);
  check(/Stock purchases belong in Receiving, not here\./.test(t),
    "…and warns stock purchases belong in Receiving");
  check((await page.locator("#exp-desc").getAttribute("placeholder")) === "e.g. Gas for Roxas delivery run",
    "description placeholder");
  check((await page.locator("#exp-paidto").getAttribute("placeholder")) === "e.g. Shell, Mang Tony",
    "paid-to placeholder");

  // ── Step 2: amount validation (❌) ─────────────────────────────────────────
  step("Step 2: amount validation");
  await page.locator("#exp-desc").fill(DESC);
  await page.locator("#exp-paidto").fill("ZZ-QB Vendor");
  await pickIn("Pick a category", "Miscellaneous");
  await pickIn("Shop", "Company-wide").catch(async () => {
    // scope select shows its current value; fall back to the scope trigger
    await page.locator('[role="dialog"] button[role="combobox"]').nth(2).click();
    await page.waitForTimeout(500);
    await page.getByRole("option", { name: "Company-wide", exact: true }).click();
  });
  for (const bad of ["0", "-5"]) {
    await page.locator("#exp-amount").fill(bad);
    await page.getByRole("button", { name: /^Save|^Record/ }).last().click();
    const tb = await toast(page);
    check(/Enter a valid ₱ amount/.test(tb), `❌ amount "${bad}" → 'Enter a valid ₱ amount'`, tb);
    await clearToasts(page);
  }

  // ── Step 3: receipt upload ────────────────────────────────────────────────
  step("Step 3: receipt upload");
  makePng(PNG, 70, 50, [200, 120, 40]);
  const fileIn = page.locator('[role="dialog"] input[type="file"]').first();
  check(await fileIn.count() > 0, "receipt file input present");
  await fileIn.setInputFiles(PNG);
  await page.waitForTimeout(1800);
  check(/WebP|\d+×\d+|KB/.test(await T()), "receipt processed to WebP with a readout",
    ((await T()).match(/[\d.]+ ?KB[^\n]*/) || ["absent"])[0]);
  // re-picking the SAME file must work (the input resets after each pick)
  await fileIn.setInputFiles(PNG);
  await page.waitForTimeout(1800);
  check(/WebP|\d+×\d+|KB/.test(await T()), "re-picking the same file works (input resets)");

  await page.locator("#exp-amount").fill("250");
  await page.getByRole("button", { name: /^Save|^Record/ }).last().click();
  const t1 = await toast(page);
  check(/saved|recorded|added/i.test(t1), "expense saved", t1);
  await page.waitForTimeout(3000);
  await clearToasts(page);
  const mine = (await q(`expenses?select=id,amount,scope,shop_id,status,receipt_image_path&description=eq.${encodeURIComponent(DESC)}&deleted_at=is.null`))[0];
  check(!!mine, "expense row persisted");
  check(mine?.amount === 25000, "amount stored as centavos (₱250.00)", String(mine?.amount));
  check(mine?.status === "approved", "an office-created expense is born approved", mine?.status);
  check(!!mine?.receipt_image_path, "receipt object path stored", mine?.receipt_image_path || "null");

  // ── Step 4: scope pairing ─────────────────────────────────────────────────
  step("Step 4: scope pairing");
  await openRecord();
  await page.locator("#exp-desc").fill(`${DESC} scope`);
  await page.locator("#exp-amount").fill("100");
  await pickIn("Pick a category", "Miscellaneous");
  // Scope defaults to "A specific shop", so simply leaving the Shop select
  // empty is the refused case — no need to change the scope first.
  const scopeTrigger = page.locator('[role="dialog"] button[role="combobox"]')
    .filter({ hasText: /A specific shop|Company-wide/ }).first();
  check(/A specific shop/.test(await scopeTrigger.innerText()),
    "scope defaults to 'A specific shop'", (await scopeTrigger.innerText()).trim());
  // The refusal is PREVENTIVE: the submit stays disabled rather than accepting
  // the click and toasting. (The CHECK `expense_scope_shop` backs it in the DB.)
  const submit = page.getByRole("button", { name: /^Save|^Record expense/ }).last();
  check(await submit.isDisabled(),
    "❌ scope=shop with no shop → the submit is disabled (refused at the control)");
  const leaked = await q(`expenses?select=id&description=eq.${encodeURIComponent(DESC + " scope")}&deleted_at=is.null`);
  check(leaked.length === 0, "no row was written", `${leaked.length} rows`);
  // company scope shows "—" for shop and disables it
  await scopeTrigger.click();
  await page.waitForTimeout(500);
  await page.getByRole("option", { name: "Company-wide", exact: true }).click();
  await page.waitForTimeout(700);
  const shopTrigger = page.locator('[role="dialog"] button[role="combobox"]')
    .filter({ hasText: /—|Pick a shop/ }).first();
  check(/—/.test(await shopTrigger.innerText()), "company scope shows '—' in the Shop select",
    (await shopTrigger.innerText()).trim());
  check(await shopTrigger.isDisabled(), "…and the Shop select is disabled (not required)");
  check(await submit.isEnabled(), "…and the submit becomes enabled (company needs no shop)");
  check(/Not delivery-related/.test(await T()), "delivery picker defaults to 'Not delivery-related'",
    ((await T()).match(/Not delivery-related[^\n]*/) || ["absent"])[0]);
  await page.getByRole("button", { name: "Cancel", exact: true }).last().click();
  await page.waitForTimeout(800);

  // ── Step 5: void is Gerry-only (❌ as ADMIN) ───────────────────────────────
  step("Step 5: void is Gerry-only");
  await goto(page, "/expenses");
  await page.waitForTimeout(3500);
  await page.getByPlaceholder(/Search/).first().fill(DESC);
  await page.waitForTimeout(1500);
  await rowMenu(DESC).first().click();
  await page.waitForTimeout(600);
  const adminMenu = await page.locator('[role="menu"]').last().innerText();
  check(!/Void/.test(adminMenu), "❌ no Void in the ADMIN's row menu", adminMenu.replace(/\n/g, " · "));
  check(/Edit/.test(adminMenu), "ADMIN keeps Edit");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  // the disabled kebab on a seeded PENDING shop claim (never decided here)
  const pend = (await q("expenses?select=id,description&status=eq.pending&source=eq.shop&deleted_at=is.null&limit=1"))[0];
  check(!!pend, "a seeded pending shop claim exists to inspect");
  await page.getByPlaceholder(/Search/).first().fill(pend.description);
  await page.waitForTimeout(1800);
  const lockedBtn = page.getByRole("button", { name: "Reviewed on the Approval Queue", exact: true });
  check(await lockedBtn.count() > 0,
    "pending shop claim's kebab is aria-labelled 'Reviewed on the Approval Queue'");
  if (await lockedBtn.count()) {
    check(await lockedBtn.first().isDisabled(), "…and it is disabled");
    check((await lockedBtn.first().getAttribute("title")) ===
      "A shop claim under review is decided on the Approval Queue",
      "…with the explaining tooltip",
      await lockedBtn.first().getAttribute("title"));
  }
  await shot(page, "task15-step5-adminmenu");

  // ── Step 7: editing a pending shop claim is refused ───────────────────────
  step("Step 7: a pending shop claim cannot be edited");
  check((await lockedBtn.count()) > 0 && (await lockedBtn.first().isDisabled()),
    "❌ the only control on a pending claim is disabled — no edit path in the UI");
  console.log("  the server guard is not probed here: reaching it would mean");
  console.log("  writing to a claim the other agent's Task 8 will decide.");

  // ── Step 8: filtered print ────────────────────────────────────────────────
  step("Step 8: filtered print");
  await goto(page, "/expenses");
  await page.waitForTimeout(3500);
  await page.getByPlaceholder(/Search/).first().fill(DESC);
  await page.waitForTimeout(1800);
  const printBtn = page.getByRole("button", { name: /^Print/ });
  check(await printBtn.count() > 0, "Print button present");
  check((await printBtn.first().getAttribute("title")) === "Print the rows currently shown",
    "Print tooltip 'Print the rows currently shown'",
    await printBtn.first().getAttribute("title"));
  const sheet = page.locator("#expenses-print");
  check(await sheet.count() === 1, "a dedicated print sheet exists (isolated from the page)");
  const sheetTxt = await sheet.innerText().catch(() => "");
  check(sheetTxt.includes(DESC), "the print sheet carries the filtered row", DESC);
  check(/Approved total/i.test(sheetTxt), "tfoot 'Approved total (N row(s) shown)'",
    (sheetTxt.match(/Approved total[^\n]*/i) || ["absent"])[0]);
  // impossible filter — now that the sheet follows the search too (bug B9)
  await page.getByPlaceholder(/Search/).first().fill("zzzz-no-such-expense");
  await page.waitForTimeout(1800);
  const emptySheet = await page.locator("#expenses-print").innerText().catch(() => "");
  check(/No expenses match the current filters\./.test(emptySheet),
    "empty print row 'No expenses match the current filters.'",
    (emptySheet.match(/No expenses match[^\n]*/) || ["absent"])[0]);

  // ── Step 11 (ADMIN half): reports are Gerry-only ──────────────────────────
  step("Step 11a: /expenses/reports is Gerry-only");
  await goto(page, "/expenses/reports");
  await page.waitForTimeout(3000);
  check(new URL(page.url()).pathname !== "/expenses/reports",
    "❌ ADMIN is redirected away from /expenses/reports", new URL(page.url()).pathname);
  check(!/Reports/.test(await page.locator("nav").first().innerText().catch(() => "")),
    "…and the Reports nav item is absent for the admin");

  // ═══ SHOP half — create the two proposals ═══════════════════════════════
  step("fixture: two shop-proposed categories (shop3, not shop1/shop2)");
  const shopCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sp = await shopCtx.newPage();
  await sp.goto(`${APP}/login`, { waitUntil: "load", timeout: 60000 });
  await sp.locator('input[type="email"]').fill("shop3@gerwin-test.ph");
  await sp.locator('input[type="password"]').fill("gerwin123");
  await sp.locator('button[type="submit"]').click();
  await sp.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 });
  await sp.goto(`${APP}/shop/expenses`, { waitUntil: "load", timeout: 60000 });
  await sp.waitForTimeout(3500);

  for (const name of [PROP_MERGE, PROP_KEEP]) {
    await sp.getByRole("button", { name: /Record expense|Add expense|New expense/i }).first().click();
    await sp.waitForTimeout(1200);
    await sp.locator('[role="dialog"] button[role="combobox"]').filter({ hasText: "Pick a category" })
      .first().click();
    await sp.waitForTimeout(600);
    await sp.getByRole("option", { name: /Propose a new category|New category/i }).first().click();
    await sp.waitForTimeout(600);
    await sp.locator('[role="dialog"] input[placeholder="New category name, e.g. Boat Repair"]').fill(name);
    await sp.locator("#sexp-amount").fill("120");
    await sp.locator("#sexp-desc").fill(`${name} claim`);
    await sp.locator("#sexp-paidto").fill("ZZ-QB Vendor");
    await sp.getByRole("button", { name: /^Save|^Record/ }).last().click();
    await sp.waitForTimeout(3000);
    const made = await q(`expense_categories?select=id,name,status&name=eq.${encodeURIComponent(name)}`);
    check(made.length === 1 && made[0].status === "proposed",
      `proposal created: ${name}`, JSON.stringify(made[0] ?? {}));
  }
  const shopExp = await q(`expenses?select=shop_id&description=like.ZZ-QB Proposal*&deleted_at=is.null&limit=1`);
  const shopName = shopExp.length
    ? (await q(`shops?select=name&id=eq.${shopExp[0].shop_id}`))[0].name : "?";
  console.log(`  proposals recorded at: ${shopName}`);
  check(!/Ternate|Naic/.test(shopName), "the proposing shop is NOT shop1/shop2", shopName);
  await shopCtx.close();

  // ═══ GERRY half ═════════════════════════════════════════════════════════
  await page.context().clearCookies();
  await login(page, "owner");

  // ── Step 6: void as GERRY ─────────────────────────────────────────────────
  step("Step 6: void as GERRY");
  await goto(page, "/expenses");
  await page.waitForTimeout(3500);
  await page.getByPlaceholder(/Search/).first().fill(DESC);
  await page.waitForTimeout(1800);
  await rowMenu(DESC).first().click();
  await page.waitForTimeout(600);
  const gerryMenu = await page.locator('[role="menu"]').last().innerText();
  check(/Void/.test(gerryMenu), "GERRY's row menu offers Void", gerryMenu.replace(/\n/g, " · "));
  await page.getByRole("menuitem", { name: /Void/ }).click();
  await page.waitForTimeout(900);
  t = await T();
  check(/It disappears from lists and reports\. Its receipt photo is removed\./.test(t),
    "void dialog copy", (t.match(/It disappears[^\n]*/) || ["absent"])[0]);
  await page.getByRole("button", { name: "Void", exact: true }).last().click();
  const tVoid = await toast(page);
  check(/Expense voided/.test(tVoid), "toast 'Expense voided'", tVoid);
  await page.waitForTimeout(2500);
  const voided = (await q(`expenses?select=deleted_at,receipt_image_path&id=eq.${mine.id}`))[0];
  check(voided.deleted_at !== null, "the expense is soft-deleted", String(voided.deleted_at));
  await clearToasts(page);

  // ── Step 9: categories ────────────────────────────────────────────────────
  step("Step 9: categories CRUD");
  await goto(page, "/expenses/categories");
  await page.waitForTimeout(3500);
  // create is behind an "Add category" dialog, not an inline form
  await page.getByRole("button", { name: "Add category", exact: true }).click();
  await page.waitForTimeout(900);
  check(/Lower order numbers appear first in pickers\./.test(await T()),
    "create hint 'Lower order numbers appear first in pickers.'");
  await page.locator("#cat-name").fill(CAT_NEW);
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Add", exact: true }).last().click();
  await toast(page);
  await page.waitForTimeout(2500);
  await clearToasts(page);
  const cat = (await q(`expense_categories?select=id,name,status&name=eq.${encodeURIComponent(CAT_NEW)}`))[0];
  check(!!cat && cat.status === "active", "category created active", JSON.stringify(cat ?? {}));

  // rename via its own aria-label
  await page.getByRole("button", { name: `Actions for ${CAT_NEW}`, exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /^Edit/ }).click();
  await page.waitForTimeout(800);
  await page.locator("#cat-name").fill(`${CAT_NEW} v2`);
  await page.getByRole("button", { name: "Save", exact: true }).last().click();
  await toast(page);
  await page.waitForTimeout(2500);
  check((await q(`expense_categories?select=name&id=eq.${cat.id}`))[0].name === `${CAT_NEW} v2`,
    "rename persisted");
  await clearToasts(page);

  // remove — copy differs by usage (this one is unused)
  await page.getByRole("button", { name: `Actions for ${CAT_NEW} v2`, exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /Remove/ }).click();
  await page.waitForTimeout(900);
  check(/It can no longer be picked; history stays intact\./.test(await T()),
    "unused-category remove copy",
    ((await T()).match(/It can no longer[^\n]*/) || ["absent"])[0]);
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  await toast(page);
  await page.waitForTimeout(2500);
  check((await q(`expense_categories?select=deleted_at&id=eq.${cat.id}`))[0].deleted_at !== null,
    "category soft-deleted");
  await clearToasts(page);

  // ── Step 10: shop-proposed categories (Merge + Dismiss only) ──────────────
  step("Step 10: shop-proposed categories");
  await goto(page, "/expenses/categories");
  await page.waitForTimeout(3500);
  t = await T();
  check(/Proposed by shops \(\d+\)/.test(t), "'Proposed by shops (N)' block renders",
    (t.match(/Proposed by shops \(\d+\)/) || ["absent"])[0]);
  check(t.includes(PROP_MERGE) && t.includes(PROP_KEEP), "both ZZ-QB proposals are listed");

  // Dismiss while expenses still use it -> refused
  (await rowButton(PROP_KEEP, "Dismiss")).click();
  // A proposal still in use is refused IMMEDIATELY with a toast — no confirm
  // dialog is opened at all, so there is nothing to confirm here.
  const tDismiss = await toast(page);
  check(new RegExp(`still use “${PROP_KEEP}” — merge it into an existing category instead`)
    .test(tDismiss),
    "❌ dismissing a proposal still in use is refused, naming OUR proposal", tDismiss);
  check(/^\d+ expense\(s\) still use/.test(tDismiss),
    "…and the refusal counts the expenses that block it", tDismiss);
  check((await q(`expense_categories?select=deleted_at&name=eq.${encodeURIComponent(PROP_KEEP)}`))[0].deleted_at === null,
    "…and the proposal survives");
  await clearToasts(page);

  // Merge into an existing category
  await goto(page, "/expenses/categories");
  await page.waitForTimeout(3000);
  (await rowButton(PROP_MERGE, "Merge")).click();
  await page.waitForTimeout(900);
  t = await T();
  check(new RegExp(`Merge “?${PROP_MERGE}`).test(t), "merge dialog names the proposal",
    (t.match(/Merge [^\n]*/) || ["absent"])[0]);
  check(/move to the category you pick; the proposal is retired/.test(t),
    "merge description explains what moves",
    (t.match(/[^\n]*move to the category[^\n]*/) || ["absent"])[0]);
  // B10: this counted only the first 1,000 of 13k expenses, so it read "Its 0
  // expenses" while the merge actually moved one.
  check(/Its 1 expense\b/.test(t),
    "B10 — the merge dialog shows the REAL expense count, not a truncated 0",
    (t.match(/Its \d+ expenses? move[^\n]*/) || ["absent"])[0]);
  await pickIn("Pick a category", "Miscellaneous");
  await page.getByRole("button", { name: /^Merge/ }).last().click();
  const tMerge = await toast(page);
  check(/merged|moved/i.test(tMerge), "merge succeeds", tMerge);
  await page.waitForTimeout(2500);
  const mergedCat = (await q(`expense_categories?select=deleted_at,status&name=eq.${encodeURIComponent(PROP_MERGE)}`))[0];
  check(mergedCat.deleted_at !== null || mergedCat.status !== "proposed",
    "the merged proposal is retired", JSON.stringify(mergedCat));
  const moved = await q(`expenses?select=category_id&description=eq.${encodeURIComponent(PROP_MERGE + " claim")}&deleted_at=is.null`);
  const misc = (await q("expense_categories?select=id&name=eq.Miscellaneous"))[0];
  check(moved[0]?.category_id === misc.id, "its expense moved to the picked category");
  await shot(page, "task15-step10-proposals");
  await clearToasts(page);

  // ── Step 11: expense reports as GERRY ─────────────────────────────────────
  step("Step 11b: expense reports (GERRY)");
  await goto(page, "/expenses/reports");
  await page.waitForTimeout(4000);
  check(new URL(page.url()).pathname === "/expenses/reports", "GERRY reaches /expenses/reports");
  t = await T();
  check(/Expense|Category|Shop/i.test(t), "report renders its sections");
  const csv = page.getByRole("button", { name: /CSV|Export/i }).first();
  check(await csv.count() > 0, "CSV button present");
  // impossible range → empty states + disabled CSV
  await goto(page, "/expenses/reports?from=2019-01-01&to=2019-01-02");
  await page.waitForTimeout(4000);
  t = await T();
  check(/No expenses in this range\./.test(t), "empty state 'No expenses in this range.'",
    (t.match(/No expenses in this range[^\n]*/) || ["absent"])[0]);
  const csv2 = page.getByRole("button", { name: /CSV|Export/i }).first();
  if (await csv2.count()) {
    check(await csv2.isDisabled(), "CSV button disables when there are no rows");
  }
  await shot(page, "task15-step11-reports");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task15-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
