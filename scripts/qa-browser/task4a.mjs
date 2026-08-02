// Task 4 (Suppliers → Receiving), non-destructive half: Steps 1–9, 13, 18.
// Nothing is saved; Steps 10–12 and 14–17 (which write) live in task4b.mjs.
import {
  launch, login, goto, bodyText, toast, clearToasts, pickSelect, shot,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);

async function openForm() {
  await goto(page, "/suppliers?tab=receiving");
  await page.getByRole("button", { name: "New Receiving" }).click();
  await page.waitForTimeout(700);
}

/** The part-line picker is a Popover+Command, not a Radix Select.
 *  Indices shift as lines are added, so target the first UNSET line by its
 *  trigger text ("Pick item…") rather than by position. */
async function openPartPicker() {
  // role=combobox takes no name from content (ARIA), so match on text.
  await page.locator('button[role="combobox"]').filter({ hasText: "Pick item" }).first().click();
  await page.waitForTimeout(600);
  await page
    .locator('input[placeholder="Search name, SKU, or scan barcode…"]')
    .first()
    .waitFor({ state: "visible", timeout: 5000 });
}

try {
  await login(page, "admin");

  // ── Step 1 + 18: gates and empty states ───────────────────────────────────
  step("Step 1: gates before a supplier is picked / Step 18: empty states");
  await openForm();
  let t = await T();
  check(t.includes("Outstanding balance appears here."),
    'caption placeholder "Outstanding balance appears here."');
  check(!t.includes("Payment status"),
    "Payment section is NOT rendered before a supplier is picked");
  check(t.includes("No part lines yet — “Add part”, or “Bulk new products” for a carton of brand-new items."),
    "part-lines empty state, exact copy");
  check(t.includes("No engine lines yet — click “Add engine”."),
    "engine-lines empty state, exact copy");

  // ── Step 2: supplier required ─────────────────────────────────────────────
  step("Step 2: supplier is required");
  await page.getByRole("button", { name: "Add part" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Receive stock" }).click();
  let msg = await toast(page);
  check(msg.includes("Pick the supplier — stock always comes from someone"),
    "refusal toast, exact copy", msg);
  check((await T()).includes("Parts"), "form stays open after refusal");
  await clearToasts(page);

  // ── Step 3: supplier context ──────────────────────────────────────────────
  step("Step 3: supplier context loads");
  await pickSelect(page, 0, "Motorcentral");
  await page.waitForTimeout(2500); // 350ms debounce + RPC
  t = await T();
  const cap = (t.match(/Owed now[^\n]*/) || [""])[0];
  check(/Owed now\s+₱[\d,\.]+/.test(cap), "caption shows outstanding", cap);
  check(/of ₱[\d,\.]+ limit/.test(cap) || /no credit limit set/.test(cap),
    "caption shows the credit limit", cap);
  check(/\d+(\.\d+)?% used/.test(cap), "caption shows utilisation %", cap);
  check(/net-\d+ terms/.test(cap), "caption shows payment terms", cap);
  check(t.includes("Payment status"), "Payment section appears");
  check(/Receiving total/.test(t), "live 'Receiving total' present",
    (t.match(/Receiving total[^\n]*/) || ["absent"])[0]);

  // ── Step 4: part line, existing product ───────────────────────────────────
  step("Step 4: part line — existing product");
  await openPartPicker();
  t = await T();
  check(
    (await page.locator('input[placeholder="Search name, SKU, or scan barcode…"]').count()) > 0,
    "search placeholder 'Search name, SKU, or scan barcode…'");
  check(t.includes("New product…"), "pinned 'New product…' item");

  // pick the first real product (skip the pinned new-product row)
  const items = page.locator('[cmdk-item]');
  const count = await items.count();
  const pickedName = (await items.nth(1).innerText()).split("\n")[0].trim();
  await items.nth(1).click();
  await page.waitForTimeout(1500);
  t = await T();
  const costVal = await page.getByLabel("Unit cost in pesos").first().inputValue();
  check(costVal !== "NOFIELD" && costVal !== "" && costVal !== "0",
    `Unit cost auto-fills from the part's current cost (picked "${pickedName}")`, costVal);
  const lastPaid = (t.match(/Last paid[^\n]*/) || [""])[0];
  check(/Last paid/.test(t), "last-paid context caption", lastPaid || "absent");
  await shot(page, "task4-step4-partline");

  // ── Step 5: Enter in Unit cost adds a line ────────────────────────────────
  step("Step 5: keyboard flow — Enter in Unit cost adds a line");
  const linesBefore = await page.locator('[role="combobox"]').count();
  await page.getByLabel("Unit cost in pesos").first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const linesAfter = await page.locator('[role="combobox"]').count();
  check(linesAfter > linesBefore, "Enter adds a new blank part line",
    `${linesBefore} → ${linesAfter}`);

  // ── Step 6: New product dialog ────────────────────────────────────────────
  step("Step 6: New product dialog");
  await openPartPicker();
  await page.locator('[cmdk-item]').filter({ hasText: "New product" }).first().click();
  await page.waitForTimeout(700);
  t = await T();
  for (const f of ["Name *", "Category", "Unit", "SKU", "Barcode", "Selling price", "Reorder level"]) {
    check(t.includes(f), `field present: ${f}`);
  }
  check(/Generate a GT barcode \(unbranded goods\)/.test(t),
    "GT barcode checkbox copy");

  const barcodeState = async () =>
    page.evaluate(() => {
      const l = [...document.querySelectorAll("label")].find((x) => x.textContent.trim() === "Barcode");
      const el = l && (document.getElementById(l.htmlFor) || l.parentElement.querySelector("input"));
      return el ? { disabled: el.disabled, ph: el.placeholder } : null;
    });
  const before = await barcodeState();
  await page.getByRole("checkbox").first().click();
  await page.waitForTimeout(400);
  const after = await barcodeState();
  check(after && after.disabled && !before?.disabled,
    "ticking GT disables the Barcode input", JSON.stringify({ before, after }));
  check(after && /will be generated/i.test(after.ph || ""),
    "Barcode placeholder flips to 'will be generated'", after?.ph);

  // blank name
  await clearToasts(page);
  const addBtn = page.getByRole("button", { name: "Add to receiving" });
  await addBtn.click();
  msg = await toast(page);
  check(msg.includes("The new product needs a name"), "blank name refused", msg);

  // name but no price
  await page.locator("#np-name").fill("ZZ-QA Test Widget");
  await addBtn.click();
  msg = await toast(page, { not: msg });
  check(/Enter a selling price \(₱\)/.test(msg), "missing price refused", msg);
  await shot(page, "task4-step6-newproduct");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  await clearToasts(page);

  // ── Step 7: Bulk new products ─────────────────────────────────────────────
  step("Step 7: Bulk new products dialog");
  await page.getByRole("button", { name: "Bulk new products" }).click();
  await page.waitForTimeout(800);
  const bulk = page.locator('[role="dialog"]').last();
  const bt = await bulk.innerText();
  const nameFields = await bulk.locator("input").count();
  check(/Auto \(GT\)/.test(bt), "each row offers 'Auto (GT)'");
  check(!/\bSKU\b/.test(bt), "bulk rows have NO SKU field");
  const rowCount = await bulk.locator('[role="checkbox"], input[type="checkbox"]').count();
  check(rowCount === 3, "starts with 3 cards", `${rowCount} rows`);
  await shot(page, "task4-step7-bulk");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ── Step 8/9: engine lines ────────────────────────────────────────────────
  step("Step 8: engine lines + Duplicate line");
  await page.getByRole("button", { name: "Add engine" }).click();
  await page.waitForTimeout(600);
  t = await T();
  check(/Serial/.test(t), "engine line has a Serial field");
  const dup = page.locator('button[title="Same model, next serial"]');
  check((await dup.count()) > 0, 'Duplicate-line button titled "Same model, next serial"');

  step("Step 9: New engine model dialog");
  const modelBox = page
    .locator('button[role="combobox"]')
    .filter({ hasText: "Pick a model" })
    .first();
  await modelBox.click();
  await page.waitForTimeout(500);
  const hasNewModel = await page.getByRole("option", { name: /New model/ }).count();
  check(hasNewModel > 0, "'New model…' is offered in the model picker");
  if (hasNewModel) {
    await page.getByRole("option", { name: /New model/ }).first().click();
    await page.waitForTimeout(700);
    await clearToasts(page);
    await page.getByRole("button", { name: "Use this model" }).first().click();
    msg = await toast(page, { not: msg });
    check(msg.includes("Brand and model are required"), "blank model refused", msg);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }

  // ── Step 13: reference placeholder per method ─────────────────────────────
  step("Step 13: Reference no. placeholder switches by payment method");
  const refPh = async () =>
    (await page.locator("#rcv-ref").count())
      ? await page.locator("#rcv-ref").getAttribute("placeholder")
      : "NOFIELD";
  const seen = {};
  for (const m of ["Cash", "Bank transfer", "GCash", "Cheque", "Other"]) {
    const box = page
      .locator('button[role="combobox"]')
      .filter({ hasText: /^(Cash|Bank transfer|GCash|Cheque|Other)$/ })
      .first();
    await box.click();
    await page.waitForTimeout(300);
    await page.getByRole("option", { name: m, exact: true }).first().click();
    await page.waitForTimeout(400);
    seen[m] = await refPh();
  }
  check(seen["Cash"] === "Optional", "Cash → 'Optional'", seen["Cash"]);
  check(seen["Bank transfer"] === "Transaction / ref no.",
    "Bank transfer → 'Transaction / ref no.'", seen["Bank transfer"]);
  check(seen["GCash"] === "Transaction / ref no.",
    "GCash → 'Transaction / ref no.'", seen["GCash"]);
  check(seen["Cheque"] === "Cheque no.", "Cheque → 'Cheque no.'", seen["Cheque"]);
  // source maps only `check` and `cash` specially; everything else is generic
  check(seen["Other"] === "Transaction / ref no.",
    "Other → 'Transaction / ref no.' (generic branch)", seen["Other"]);
  console.log("  placeholders:", JSON.stringify(seen));

  await shot(page, "task4-final");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task4-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
