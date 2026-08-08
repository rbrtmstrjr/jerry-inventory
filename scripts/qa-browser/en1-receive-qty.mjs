// EN1 — Receiving: the engine quantity box (Task 4 of the 2026-08-06
// engine-bulk-receive plan).
//
// UNVERIFIED PENDING MIGRATION: 0128 (engine_models.is_serialized/sku) and
// 0129 (fn_receive_stock qty-per-line) are not applied to staging yet — a
// human applies them. This script is written to the brief's exact
// assertions and is expected to FAIL at the final save until they land; its
// job here is to prove the UI wiring (Qty/Serial mutual exclusion) works
// client-side and to record what actually happens against the unmigrated
// database, not to be contorted into passing early.
//
// Reuses openReceiving()/submitReceiving() from fq1-receiving.mjs verbatim,
// including the credit-limit override (every seeded supplier is over its
// limit).
import {
  launch, login, goto, shot, check, step, summary, dbAuth, toast,
} from "./qa-lib.mjs";

const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const LOOSE_BRAND = "ZZ-QA Loose";
const LOOSE_MODEL = `Engine ${RUN}`;
const PLATED_BRAND = "ZZ-QA Plated";
const PLATED_MODEL = `Engine ${RUN}`;

const { browser, page, errors } = await launch({ headless: true });
const q = await dbAuth("owner");

// ---- verbatim from fq1-receiving.mjs ---------------------------------------

/** Open New Receiving and pick the first real supplier. */
async function openReceiving() {
  await goto(page, "/suppliers?tab=receiving");
  await page.getByRole("button", { name: /new receiving/i }).first().click();
  await page.waitForTimeout(1200);
  const card = page.locator("form, .rounded-lg").filter({ hasText: "Parts" }).last();
  await page.locator('button[role="combobox"]').filter({ hasText: /pick the supplier/i }).click();
  await page.waitForTimeout(400);
  await page.getByRole("option").first().click();
  await page.waitForTimeout(2600); // debounce ~350ms + the outstanding RPC

  // Pay in full so the seeded supplier's credit limit is not in play — this
  // run is about quantity, not payables, and the first supplier is over.
  const pay = page
    .locator('button[role="combobox"]')
    .filter({ hasText: /paid in full|partially paid|unpaid/i })
    .last();
  if (await pay.count()) {
    await pay.click();
    await page.waitForTimeout(400);
    await page.getByRole("option", { name: /paid in full/i }).first().click();
    await page.waitForTimeout(500);
  }
  return card;
}

/** Submit. Success is a DIALOG, refusal is a TOAST — race them or a refusal
 *  reads as silence (README gotcha). Returns {okDialog, toastText}. */
async function submitReceiving(prevToast = "") {
  // Every seeded supplier is already over its credit limit (Cavite Marine is at
  // 317%), so the form legitimately demands an override reason. Not a bug —
  // supply it and get on with testing quantities.
  const ovr = page.locator("#rcv-override");
  if (await ovr.count()) await ovr.fill("ZZ-QA engine-quantity test run");
  await page.getByRole("button", { name: /receive stock/i }).click();
  const okDialog = page
    .locator('[data-slot="dialog-content"]')
    .filter({ hasText: /stock received/i })
    .waitFor({ timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  const refusal = toast(page, { not: prevToast, timeout: 15000 });
  const [dialog, t] = await Promise.all([okDialog, refusal]);
  return { okDialog: dialog, toastText: t };
}

// ---- EN1-specific helpers ---------------------------------------------------

/** Add an engine line, open "New model…", fill brand/model, set the
 *  serialized checkbox, save. Leaves the line's Qty/Serial boxes ready to
 *  inspect. Returns the row index (always the last one added). */
async function addEngineLineWithNewModel({ brand, model, serialized }) {
  await page.getByRole("button", { name: "Add engine", exact: true }).click();
  await page.waitForTimeout(500);

  // The model cell is a Radix <Select>, not the parts combobox — its trigger
  // shows placeholder "Pick a model".
  await page
    .locator('button[role="combobox"]')
    .filter({ hasText: /pick a model/i })
    .last()
    .click();
  await page.waitForTimeout(400);
  await page.getByRole("option", { name: /new model/i }).first().click();
  await page.waitForTimeout(700);

  const dlg = page.locator('[data-slot="dialog-content"]').last();
  await dlg.locator("#nm-brand").fill(brand);
  await dlg.locator("#nm-model").fill(model);

  // Defaults ON (serialized) — only click to flip it when we want it off.
  const cb = dlg.getByLabel(/units of the new model have serial numbers/i);
  if (!serialized) await cb.click();

  await dlg.getByRole("button", { name: /use this model/i }).click();
  await page.waitForTimeout(600);
}

try {
  await login(page, "owner");

  // ── A non-serialized model: Qty enabled, Serial disabled ──────────────────
  step("A — non-serialized model enables Qty and disables Serial");
  await openReceiving();
  await addEngineLineWithNewModel({
    brand: LOOSE_BRAND, model: LOOSE_MODEL, serialized: false,
  });
  await shot(page, "en1-01-loose-model-line");

  const serialBox = page.getByLabel("Serial number").last();
  const qtyBox = page.getByLabel("Engine quantity").last();
  check(
    await serialBox.isDisabled(),
    "Serial number is disabled for a non-serialized model",
    String(await serialBox.isDisabled())
  );
  check(
    !(await qtyBox.isDisabled()),
    "Engine quantity is enabled for a non-serialized model",
    String(await qtyBox.isDisabled())
  );

  await qtyBox.fill("3");
  check((await qtyBox.inputValue()) === "3", "Qty box holds 3", await qtyBox.inputValue());
  await page.getByLabel("Cost in pesos").last().fill("50000.00");
  await page.getByLabel("Price in pesos").last().fill("65000.00");

  const r1 = await submitReceiving();
  console.log(`    save result: dialog=${r1.okDialog} toast="${r1.toastText}"`);
  if (r1.okDialog) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
    const models = await q(
      `engine_models?brand=eq.${encodeURIComponent(LOOSE_BRAND)}&model=eq.${encodeURIComponent(LOOSE_MODEL)}&select=id`
    );
    check(models.length === 1, "the non-serialized model was created", `${models.length} rows`);
    if (models.length === 1) {
      const eng = await q(`engines?engine_model_id=eq.${models[0].id}&select=serial_number`);
      check(eng.length === 3, "three engines rows were created", `${eng.length} rows`);
      const distinct = new Set(eng.map((e) => e.serial_number));
      check(distinct.size === eng.length, "each has a distinct serial", [...distinct].join(", "));
      check(
        eng.every((e) => /^UNIT-/.test(e.serial_number)),
        "each is numbered UNIT-######## (system-generated)",
        eng.map((e) => e.serial_number).join(", ")
      );
    }
  } else {
    check(
      false,
      "receiving 3 units of a non-serialized model is accepted (expected — see report for why this fails pre-migration)",
      r1.toastText
    );
  }

  // ── B — a serialized model: Qty locked at 1, Serial required ─────────────
  step("B — serialized model locks Qty at 1 and requires Serial");
  await page.reload();
  await page.waitForTimeout(1200);
  await openReceiving();
  await addEngineLineWithNewModel({
    brand: PLATED_BRAND, model: PLATED_MODEL, serialized: true,
  });
  await shot(page, "en1-02-plated-model-line");

  const serialBox2 = page.getByLabel("Serial number").last();
  const qtyBox2 = page.getByLabel("Engine quantity").last();
  check(
    !(await serialBox2.isDisabled()),
    "Serial number is enabled for a serialized model",
    String(await serialBox2.isDisabled())
  );
  check(
    await qtyBox2.isDisabled(),
    "Engine quantity is disabled (locked) for a serialized model",
    String(await qtyBox2.isDisabled())
  );
  check(
    (await qtyBox2.inputValue()) === "1",
    "the locked Qty box shows 1",
    await qtyBox2.inputValue()
  );

  // Try to submit with no serial — must be refused, naming the requirement.
  await page.getByLabel("Cost in pesos").last().fill("50000.00");
  await page.getByLabel("Price in pesos").last().fill("65000.00");
  const r2 = await submitReceiving();
  check(!r2.okDialog, "submitting a serialized line with no serial is refused", `dialog=${r2.okDialog}`);
  console.log(`    refusal toast: "${r2.toastText}"`);

  console.log(`\nFIXTURES: ${LOOSE_BRAND} ${LOOSE_MODEL} / ${PLATED_BRAND} ${PLATED_MODEL}`);
  console.log("CONSOLE ERRORS:", errors.length ? errors.slice(0, 5) : "none");
} catch (e) {
  console.error("\nEN1 THREW:", e.message);
  await shot(page, "en1-crash").catch(() => {});
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
