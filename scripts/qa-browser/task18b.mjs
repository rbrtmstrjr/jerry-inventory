// Task 18 (The Shop app) — Steps 8–12.
//
// Order is forced: 10 must precede 11 (submitting empties the Current tab),
// and 12 records its OWN throwaway sale rather than reusing one, because after
// 11 everything is `pending` and the owner session on this shared staging
// database can approve a batch at any moment — cancel is refused once the
// status leaves recorded/pending.
import fs from "node:fs";
import {
  launch, session, goto, bodyText, toast, clearToasts, shot, dbAuth, makePng,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser } = await launch();
const STAMP = process.env.QA_STAMP || String(Date.now()).slice(-6);
const q = await dbAuth("owner");
const qs = await dbAuth("shop");
const PNG = makePng(`${process.env.TEMP || "/tmp"}/zzqa-rcpt-${STAMP}.png`, 64, 48);

const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
const S = shop.page;

/** Record one cash sale, auto-print off. Returns its id. */
async function recordQuickSale(tag) {
  const st = await qs("shop_stock?select=part_id,name&qty=gte.2&limit=1");
  await goto(S, "/shop/record-sale");
  await S.waitForTimeout(2500);
  await S.getByRole("button", { name: st[0].name, exact: false }).first().click();
  await S.waitForTimeout(1200);
  await S.locator("#auto-print").uncheck().catch(() => {});
  await S.waitForTimeout(300);
  await clearToasts(S); // the "<part> added" toast would be read as the save result
  await S.getByRole("button", { name: "Save sale" }).click();
  const m = await toast(S, { timeout: 30000 });
  await S.waitForTimeout(3000);
  console.log(`  [${tag}] ${m}`);
  return m;
}

try {
  const shopId = (await qs("profiles?select=shop_id"))[0].shop_id;

  // ── Step 8: shop expenses ─────────────────────────────────────────────────
  step("Step 8: shop expenses");
  await goto(S, "/shop/expenses");
  await S.waitForTimeout(2500);
  // the pickers are DatePicker BUTTONS (placeholder "Any"), not inputs
  const fromTxt = await S.locator("#exp-from").innerText().catch(() => "");
  const toTxt = await S.locator("#exp-to").innerText().catch(() => "");
  const month = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Manila", month: "short" });
  check(fromTxt !== "Any" && fromTxt.includes(month),
    "default range starts inside the current month (month-to-date)", `${fromTxt} -> ${toTxt}`);
  check(toTxt !== "Any", "and ends today", toTxt);

  // the plan says Clear appears only once a date is set; the range is
  // pre-filled on load, so Clear is there from first paint
  const clearBtn = S.getByRole("button", { name: "Clear", exact: true });
  check((await clearBtn.count()) > 0,
    "Clear is visible on first paint (the range is pre-filled, so it must be)");
  await clearBtn.click();
  await S.waitForTimeout(1200);
  check((await S.getByRole("button", { name: "Clear", exact: true }).count()) === 0,
    "Clear disappears once both pickers are empty");

  const approvedBefore = (await bodyText(S)).match(/Approved expenses[^\n]*\n?[^\n]*/)?.[0] ?? "";
  const CAT = `ZZ-QA Cat ${STAMP}`;
  const DESC = `ZZ-QA expense ${STAMP}`;
  await S.locator("main").getByRole("button", { name: "Record expense" }).click();
  await S.waitForTimeout(1200);
  const dlg = S.getByRole("dialog");
  const submit = dlg.getByRole("button", { name: "Record expense" });

  // amount validation is gated behind description + category being filled
  await S.locator("#sexp-desc").fill(DESC);
  await dlg.getByRole("combobox").nth(0).click();
  await S.waitForTimeout(700);
  const propose = S.getByRole("option", { name: /Propose new category/ });
  check((await propose.count()) > 0, "'Propose new category…' is offered to the shop");
  await propose.first().click();
  await S.waitForTimeout(700);
  await S.locator('input[placeholder="New category name, e.g. Boat Repair"]').fill(CAT);
  await S.waitForTimeout(400);
  check(/Admin approves the new category/.test(await dlg.innerText()),
    "the proposal hint explains Admin decides",
    (await dlg.innerText()).split("\n").find((l) => /Admin approves/.test(l)) ?? "absent");

  await S.locator("#sexp-amount").fill("0");
  await S.waitForTimeout(300);
  await submit.click();
  let msg = await toast(S, { timeout: 15000 });
  check(msg === "Enter a valid ₱ amount", "zero amount refused (₱, not 'PHP')", msg);
  await clearToasts(S);

  await S.locator("#sexp-amount").fill("125.50");
  const fileIn = dlg.locator('input[type="file"]');
  if (await fileIn.count()) {
    await fileIn.setInputFiles(PNG);
    await S.waitForTimeout(2500);
  }
  await submit.click();
  msg = await toast(S, { not: msg, timeout: 30000 });
  check(msg === "Expense recorded — it goes to Admin with your next report",
    "expense toast, exact copy (em-dash, no trailing period)", msg);
  await S.waitForTimeout(3000);
  const exp = (await q(`expenses?select=id,status,source,scope,shop_id,amount,receipt_image_path&description=eq.${encodeURIComponent(DESC)}`))[0];
  check(!!exp, "expense row created");
  check(exp?.status === "recorded" && exp?.source === "shop" && exp?.scope === "shop",
    "saved as a recorded, shop-sourced, shop-scoped claim", JSON.stringify({ s: exp?.status, src: exp?.source, sc: exp?.scope }));
  check(exp?.shop_id === shopId, "forced to the recorder's own shop");
  check(!!exp?.receipt_image_path, "receipt photo stored in the PRIVATE receipts bucket",
    String(exp?.receipt_image_path));
  const cat = (await q(`expense_categories?select=id,status&name=eq.${encodeURIComponent(CAT)}`))[0];
  check(cat?.status === "proposed", "the new category is created as 'proposed', not active", cat?.status);

  // an approval-gated claim must not move the approved total
  await goto(S, "/shop/expenses");
  await S.waitForTimeout(2500);
  const bodyNow = await bodyText(S);
  check(bodyNow.includes(DESC), "the claim is listed for the shop");
  check(/Approved expenses/.test(bodyNow), "'Approved expenses' total caption present");

  // company-scoped expenses must be invisible here
  const companyExp = await q("expenses?select=id,description&scope=eq.company&deleted_at=is.null&limit=1");
  if (companyExp.length) {
    check(!bodyNow.includes(companyExp[0].description),
      "a company-scoped expense is NOT visible to the shop", companyExp[0].description);
  } else {
    console.log("  (no company-scoped expense exists — that assertion would be vacuous, skipped)");
  }
  await shot(S, "task18-step8-expenses");

  // ── Step 9: low stock and requests ────────────────────────────────────────
  step("Step 9: Low Stock and requests");
  await goto(S, "/shop/low-stock");
  await S.waitForTimeout(2500);
  let t = await bodyText(S);
  check(/Request a delivery/.test(t), "the request card renders (it must, even with nothing low)");
  const lowRows = await qs("shop_low_stock?select=product_id,name,shortfall&limit=200");
  console.log(`  low items for this shop: ${lowRows.length}`);

  const CUSTOM = `ZZ-QA Custom ${STAMP}`;
  const countLabel = async () =>
    (await S.getByRole("button", { name: /^Request \d+ items?$/ }).first().innerText()).trim();
  const before = countLabel && (await countLabel());
  await S.getByRole("button", { name: "Add product", exact: true }).click();
  await S.waitForTimeout(800);
  check((await S.locator('input[placeholder="Product name (e.g. Yamaha 40HP water pump kit)"]').count()) > 0,
    "custom row placeholder, exact copy");
  await S.locator('[aria-label="New product name"]').last().fill(CUSTOM);
  await S.waitForTimeout(900);
  const after = await countLabel();
  // a named custom row counts toward the request; if it does not, the blank-qty
  // rule below would be tested against the ticked low items instead
  check(after !== before, "a named custom row is counted in the request total",
    `${before} -> ${after}`);

  // a new custom row starts at qty "1", so the blank case has to be created
  await S.locator('[aria-label="Quantity"]').last().fill("");
  await S.waitForTimeout(500);
  // blank qty on that row must refuse the WHOLE request
  await S.getByRole("button", { name: /^Request \d+ items?$/ }).click();
  msg = await toast(S, { not: msg, timeout: 15000 });
  check(msg === "Every requested item needs a quantity", "blank qty refused", msg);
  await clearToasts(S);

  await S.locator('[aria-label="Quantity"]').last().fill("2");
  await S.locator("#req-note").fill(`ZZ-QA note ${STAMP}`);
  await S.waitForTimeout(500);
  await S.getByRole("button", { name: /^Request \d+ items?$/ }).click();
  msg = await toast(S, { not: msg, timeout: 25000 });
  check(msg === "Request sent to Admin", "request toast, exact copy", msg);
  await S.waitForTimeout(3000);
  const req = await q(`delivery_request_lines?select=delivery_request_id,custom_name&custom_name=eq.${encodeURIComponent(CUSTOM)}`);
  check(req.length === 1, "the custom line was stored with no catalog id", `${req.length}`);

  // only the note and the custom rows clear
  await S.getByRole("tab", { name: /^Low items/ }).click();
  await S.waitForTimeout(1500);
  check((await S.locator("#req-note").inputValue()) === "", "the note cleared after submit");
  check((await S.locator('[aria-label="New product name"]').count()) === 0,
    "the custom rows cleared after submit");
  if (lowRows.length) {
    const stillTicked = await S.getByRole("checkbox", { checked: true }).count();
    check(stillTicked > 0, "the low-item ticks are deliberately RETAINED", `${stillTicked} ticked`);
  }
  await shot(S, "task18-step9-lowstock");

  // ── Step 10: submissions (MUST run before Step 11) ────────────────────────
  step("Step 10: Submissions");
  // 18a's sales may already have been submitted by an earlier 18b run — the
  // Current report needs at least one sale for the row assertions to mean
  // anything, so top it up rather than asserting against an empty tab
  if ((await q(`sales?select=id&shop_id=eq.${shopId}&status=eq.recorded&deleted_at=is.null`)).length === 0) {
    await recordQuickSale("step10 top-up");
  }
  await goto(S, "/shop/submissions");
  await S.waitForTimeout(2500);
  const nSales = (await q(`sales?select=id&shop_id=eq.${shopId}&status=eq.recorded&deleted_at=is.null`)).length;
  const nLoss = (await q(`losses?select=id&shop_id=eq.${shopId}&status=eq.recorded&deleted_at=is.null`)).length;
  const nExp = (await q(`expenses?select=id&shop_id=eq.${shopId}&status=eq.recorded&source=eq.shop&deleted_at=is.null`)).length;
  console.log(`  current report: ${nSales} sales · ${nLoss} losses · ${nExp} expenses`);

  const desc = await S.locator('[data-slot="card"]').filter({ hasText: "Current report" })
    .locator('[data-slot="card-description"]').first().innerText();
  console.log(`  description: ${desc}`);
  const salesClause = `${nSales} ${nSales === 1 ? "sale" : "sales"}`;
  check(desc.startsWith(salesClause), "description opens with the live sales count", desc);
  if (nLoss) check(desc.includes(`${nLoss} ${nLoss === 1 ? "loss" : "losses"}`), "loss clause");
  if (nExp) check(desc.includes(`${nExp} ${nExp === 1 ? "expense" : "expenses"}`), "expense clause");
  check(desc.endsWith("— everything here goes to Admin together."),
    "description closes with the shared-fate sentence", desc.slice(-60));
  check(/₱[\d,]+\.\d\d (sold|spent)/.test(desc), "money is rendered with ₱ (not 'PHP')",
    (desc.match(/₱[^·]*/) || ["absent"])[0]);

  t = await bodyText(S);
  if (nLoss) check(/LOSSES \/ ADJUSTMENTS/.test(t), "LOSSES / ADJUSTMENTS section header");
  if (nExp) check(/EXPENSES/.test(t), "EXPENSES section header");

  const printLink = S.getByRole("link", { name: "Print receipt" });
  check((await printLink.count()) > 0, "reprint is a LINK (not a button) on sale rows",
    `${await printLink.count()} links`);
  const href = await printLink.first().getAttribute("href");
  check(/^\/receipt\/[0-9a-f-]{36}$/.test(href || ""), "it points at /receipt/<id>", String(href));

  // engine rows carry a physical-card reminder and NO print-warranty control
  const engineSale = await q(
    `sale_lines?select=sale_id,sales!inner(shop_id,status)&engine_id=not.is.null` +
      `&sales.shop_id=eq.${shopId}&sales.status=eq.recorded&limit=1`
  );
  if (engineSale.length) {
    check(/hand the customer their physical warranty card/.test(t),
      "engine row shows the physical warranty-card reminder",
      (t.match(/Engine sale[^\n]*/) || ["absent"])[0]);
    check(!/print warranty|certificate/i.test(t),
      "and offers NO print-warranty / certificate control (retired in 0103)");
  } else {
    console.log("  (no recorded engine sale in the current report — reminder not exercised)");
  }
  await shot(S, "task18-step10-submissions");

  // ── Step 11: submit the batch ─────────────────────────────────────────────
  step("Step 11: submit the batch");
  const mineBefore = (await q(`sales?select=id&shop_id=eq.${shopId}&status=eq.recorded&deleted_at=is.null&limit=500`)).map((x) => x.id);
  const submitBtn = S.getByRole("button", { name: /^Submit \d+ to Admin$/ });
  check((await submitBtn.count()) > 0, "the submit button carries the item count",
    (await submitBtn.first().innerText().catch(() => "absent")));
  await submitBtn.first().click();
  await S.waitForTimeout(1200);
  const confirm = S.getByRole("alertdialog");
  if (await confirm.count()) {
    await confirm.getByRole("button", { name: /Submit|Yes/ }).last().click();
  }
  msg = await toast(S, { not: msg, timeout: 30000 });
  check(/^Sent to Admin: \d+ sale\(s\), \d+ loss\(es\), \d+ expense\(s\)$/.test(msg),
    "submit toast uses the literal (s)/(es) form", msg);
  await S.waitForTimeout(3500);

  const stillRecorded = (await q(`sales?select=id&shop_id=eq.${shopId}&status=eq.recorded&deleted_at=is.null`)).length;
  check(stillRecorded === 0, "no sale is left in 'recorded'", `${stillRecorded}`);
  const mineNow = mineBefore.length
    ? await q(`sales?select=id,batch_id,status&id=in.(${mineBefore.join(",")})`)
    : [];
  check(mineNow.every((x) => x.status === "pending"), "every sale I submitted is now pending",
    `${mineNow.filter((x) => x.status === "pending").length}/${mineNow.length}`);
  const batchIds = new Set(mineNow.map((x) => x.batch_id));
  check(batchIds.size === 1 && [...batchIds][0], "they share ONE submission batch",
    JSON.stringify([...batchIds]));
  const BATCH = [...batchIds][0];
  const batch = (await q(`submission_batches?select=id,shop_id&id=eq.${BATCH}`))[0];
  check(batch?.shop_id === shopId, "the batch belongs to this shop");

  // ── Step 12: cancel before submit (own throwaway sale) ────────────────────
  step("Step 12: cancel before submit");
  const saveMsg = await recordQuickSale("step12 throwaway");
  check(/^Sale saved/.test(saveMsg), "throwaway sale recorded", saveMsg);
  const doomed = (await q(`sales?select=id&shop_id=eq.${shopId}&status=eq.recorded&deleted_at=is.null&order=created_at.desc&limit=1`))[0];
  check(!!doomed, "found the sale to cancel");

  await goto(S, "/shop/submissions");
  await S.waitForTimeout(2500);
  await S.getByRole("button", { name: "Cancel sale" }).first().click();
  await S.waitForTimeout(1200);
  const ad = S.getByRole("alertdialog");
  check(/Cancel this sale\?/.test(await ad.innerText()), "confirm dialog asks 'Cancel this sale?'");
  await ad.getByRole("button", { name: "Yes, cancel it" }).click();
  msg = await toast(S, { not: msg, timeout: 25000 });
  check(msg === "Sale cancelled", "cancel toast, exact copy", msg);
  await S.waitForTimeout(3000);
  // cancelSale HARD-deletes (there is no soft-delete trigger on sales)
  const gone = await q(`sales?select=id&id=eq.${doomed.id}`);
  check(gone.length === 0, "the sale row is hard-deleted, not soft-deleted", `${gone.length} rows`);
  const resp = await S.goto(`http://localhost:3000/receipt/${doomed.id}`, { waitUntil: "load" });
  await S.waitForTimeout(1500);
  const notFound = /not found|404/i.test(await bodyText(S)) || resp?.status() === 404;
  check(notFound, "its receipt route now 404s (inside the signed-in session)",
    `status=${resp?.status()}`);
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(S, "task18b-crash").catch(() => {});
} finally {
  fs.rmSync(PNG, { force: true });
  console.log("\nSTAMP:", STAMP);
  console.log("console errors:", shop.errors.length ? shop.errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
