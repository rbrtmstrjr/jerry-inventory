// Task 5 (Master Inventory) — GERRY half: Steps 3, 5–11, 14–17.
// These are the owner-only powers the admin was refused in task5a, plus the
// dialogs that are role-neutral. Creates ZZ-QA fixtures; retires/merges only
// products it made itself.
import fs from "node:fs";
import {
  launch, login, goto, bodyText, toast, clearToasts, pickSelect, shot, dbAuth,
  makePng, step, check, summary,
} from "./qa-lib.mjs";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const STAMP = process.env.QA_STAMP || String(Date.now()).slice(-6);
const q = await dbAuth("owner");
const TMP = process.env.TEMP || "/tmp";

const PNG = makePng(`${TMP}/zz-qa-${STAMP}.png`, 64, 48);

async function search(name, expectRow) {
  await goto(page, `/master-inventory?q=${encodeURIComponent(name)}`);
  await page.waitForTimeout(1500);
  if (expectRow) {
    // exact: true — getByRole matches a SUBSTRING by default, so
    // "Actions for X" also matches "Actions for X dup" and .first() picks the
    // wrong row (rows are newest-first).
    await page.getByRole("button", { name: `Actions for ${expectRow}`, exact: true }).first()
      .waitFor({ state: "visible", timeout: 20000 });
  }
}
async function rowMenu(name) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).first().click();
  await page.waitForTimeout(600);
  return page.locator('[role="menu"]').last().innerText();
}

try {
  await login(page, "owner");

  // ── Step 10: Add product (supplier-less) ──────────────────────────────────
  // First, because later steps retire and merge what it creates.
  step("Step 10: Add product (supplier-less)");
  await goto(page, "/master-inventory");
  await page.getByRole("button", { name: /Add product/ }).click();
  await page.waitForTimeout(900);
  let t = await T();
  check(/Enters stock immediately with no supplier and no debt/.test(t),
    "dialog explains no supplier and no debt");
  check(/attribution only/i.test(t), "supplier helper says attribution only");

  const P1 = `ZZ-QA AddProd ${STAMP}`;
  await page.locator("#ap-name").fill(P1);
  await page.locator("#ap-cost").fill("100");
  await page.locator("#ap-price").fill("90"); // price <= cost
  await page.locator("#ap-qty").fill("0");
  await page.getByRole("button", { name: /^(Add product|Create|Save)$/ }).last().click();
  let msg = await toast(page);
  check(/Selling price must be above cost/.test(msg + (await T())),
    "price ≤ cost refused", msg || "(inline error)");
  await clearToasts(page);

  await page.locator("#ap-price").fill("250");
  await page.getByRole("button", { name: /^(Add product|Create|Save)$/ }).last().click();
  await page.waitForTimeout(3000);
  const made = await q(`parts?select=id,name,cost_centavos,price_centavos&name=eq.${encodeURIComponent(P1)}`);
  check(made.length === 1, "product created", `${made.length}`);
  const lvl = made[0] ? await q(`stock_levels?select=qty&part_id=eq.${made[0].id}&shop_id=is.null`) : [];
  check(lvl.length === 0 || lvl[0].qty === 0, "opening qty 0 recorded as zero stock", JSON.stringify(lvl));
  const rcv = await q(`receivings?select=id,supplier_id,total_amount,payment_status&supplier_id=is.null&order=created_at.desc&limit=5`);
  check(rcv.every((r) => r.total_amount === 0 && r.payment_status === "paid"),
    "supplier-less receiving carries no debt", JSON.stringify(rcv.slice(0, 1)));

  // a second zero-stock product, for the merge in Step 15
  const P2 = `ZZ-QA MergeDup ${STAMP}`;
  await goto(page, "/master-inventory");
  await page.getByRole("button", { name: /Add product/ }).click();
  await page.waitForTimeout(900);
  await page.locator("#ap-name").fill(P2);
  await page.locator("#ap-cost").fill("100");
  await page.locator("#ap-price").fill("260");
  await page.locator("#ap-qty").fill("0");
  await page.getByRole("button", { name: /^(Add product|Create|Save)$/ }).last().click();
  await page.waitForTimeout(3000);
  check((await q(`parts?select=id&name=eq.${encodeURIComponent(P2)}`)).length === 1,
    "second zero-stock product created for the merge");

  // A third product WITH stock, for Step 14: a qty-0 add creates only the
  // zero-value receiving header — no line, no movement (0059).
  const P4 = `ZZ-QA Retire ${STAMP}`;
  await goto(page, "/master-inventory");
  await page.getByRole("button", { name: /Add product/ }).click();
  await page.waitForTimeout(900);
  await page.locator("#ap-name").fill(P4);
  await page.locator("#ap-cost").fill("100");
  await page.locator("#ap-price").fill("270");
  await page.locator("#ap-qty").fill("2");
  await page.getByRole("button", { name: /^(Add product|Create|Save)$/ }).last().click();
  await page.waitForTimeout(3000);
  const p4 = (await q(`parts?select=id&name=eq.${encodeURIComponent(P4)}`))[0];
  check(!!p4, "third product (qty 2) created for the retire test");
  check((await q(`receiving_lines?select=id&part_id=eq.${p4.id}`)).length === 1,
    "a qty>0 add DOES write a receiving line (contrast with qty 0)");

  // ── Step 3: edit product as GERRY ─────────────────────────────────────────
  step("Step 3: edit cost and price as GERRY");
  await search(P1, P1);
  await rowMenu(P1);
  await page.getByRole("menuitem", { name: /^Edit/ }).first().click();
  await page.waitForTimeout(1000);
  check(!(await page.locator("#part-cost").isDisabled()), "Cost ₱ is ENABLED for Gerry");
  check(!(await page.locator("#part-price").isDisabled()), "Price ₱ is ENABLED for Gerry");
  check(!/Only the owner can change cost and selling price\./.test(await T()),
    "no lock hint for Gerry");
  await page.locator("#part-cost").fill("111");
  await page.locator("#part-price").fill("333");

  // ── Step 5: photo upload (same dialog) ────────────────────────────────────
  step("Step 5: photo upload");
  t = await T();
  check(/Optional — JPG\/PNG up to 10MB\. Compressed to ~40KB in your browser\./.test(t),
    "upload hint copy");
  check(/Choose photo/.test(t), "'Choose photo' button before any image");
  await page.locator('input[type="file"]').first().setInputFiles(PNG);
  await page.waitForTimeout(2500);
  t = await T();
  check(/\d+\s*(B|KB|MB)/.test(t), "byte readout shown",
    (t.match(/[\d.]+ ?(B|KB|MB)[^\n]*/) || ["absent"])[0]);
  check(/\d+×\d+/.test(t), "W×H readout shown", (t.match(/\d+×\d+/) || ["absent"])[0]);
  check(/Replace/.test(t), "button flips to 'Replace' once an image is staged");
  await shot(page, "task5-step5-upload");

  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page.waitForTimeout(3500);
  const saved = (await q(`parts?select=cost_centavos,price_centavos,image_path&name=eq.${encodeURIComponent(P1)}`))[0];
  check(saved.cost_centavos === 11100 && saved.price_centavos === 33300,
    "Gerry's cost and price edits persisted", `${saved.cost_centavos}/${saved.price_centavos}`);
  check(!!saved.image_path, "photo stored", String(saved.image_path));

  // ── Step 6: photo remove and undo ─────────────────────────────────────────
  step("Step 6: photo remove and undo");
  await search(P1, P1);
  await rowMenu(P1);
  await page.getByRole("menuitem", { name: /^Edit/ }).first().click();
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: /^Remove$/ }).first().click();
  await page.waitForTimeout(600);
  t = await T();
  check(/Photo will be removed on save\./.test(t), "removal warning shown");
  check(/Undo remove/.test(t), "button flips to 'Undo remove'");
  await page.getByRole("button", { name: /Undo remove/ }).first().click();
  await page.waitForTimeout(600);
  check(!/Photo will be removed on save\./.test(await T()), "Undo clears the warning");
  await page.getByRole("button", { name: /^Remove$/ }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page.waitForTimeout(3500);
  const gone = (await q(`parts?select=image_path&name=eq.${encodeURIComponent(P1)}`))[0];
  check(!gone.image_path, "photo removed on save", String(gone.image_path));

  // ── Step 7: generate internal barcode ─────────────────────────────────────
  step("Step 7: generate internal barcode");
  await search(P1, P1);
  let menu = await rowMenu(P1);
  check(/Generate internal barcode/.test(menu), "menu offers 'Generate internal barcode'");
  await page.getByRole("menuitem", { name: /Generate internal barcode/ }).click();
  msg = await toast(page, { timeout: 15000 });
  check(/^Barcode GT\d{8} assigned to /.test(msg), "toast names the GT barcode", msg);
  await page.waitForTimeout(2500);
  const bc = (await q(`parts?select=barcode&name=eq.${encodeURIComponent(P1)}`))[0];
  check(/^GT\d{8}$/.test(bc.barcode || ""), "barcode stored on the product", String(bc.barcode));
  await search(P1, P1);
  menu = await rowMenu(P1);
  check(!/Generate internal barcode/.test(menu), "menu item disappears once assigned");
  check(/Print label/.test(menu), "replaced by 'Print label'");
  await page.keyboard.press("Escape");

  // ── Step 8: fitment ───────────────────────────────────────────────────────
  step("Step 8: fitment dialog");
  await rowMenu(P1);
  await page.getByRole("menuitem", { name: /^Fitment/ }).click();
  await page.waitForTimeout(1000);
  check(/fits Yamaha 40HP/.test(await T()), "description mentions what employees see");
  const fitBoxes = page.locator('[role="dialog"] button[role="checkbox"], [role="dialog"] input[type="checkbox"]');
  const nFit = await fitBoxes.count();
  check(nFit > 0, "models listed to tick", `${nFit}`);
  for (let i = 0; i < Math.min(2, nFit); i++) { await fitBoxes.nth(i).click(); await page.waitForTimeout(250); }
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page.waitForTimeout(3000);
  await search(P1, P1);
  menu = await rowMenu(P1);
  check(/Fitment \(2\)/.test(menu), "menu shows the fitment count", (menu.match(/Fitment[^\n]*/) || [""])[0]);
  await page.keyboard.press("Escape");

  // ── Step 9: suppliers & prices ────────────────────────────────────────────
  step("Step 9: suppliers & prices dialog");
  const withPrices = (await q("parts?select=id,name&deleted_at=is.null&order=created_at.asc&limit=1"))[0];
  await search(withPrices.name, withPrices.name);
  await rowMenu(withPrices.name);
  await page.getByRole("menuitem", { name: /Suppliers & prices/ }).click();
  await page.waitForTimeout(2000);
  const sp = await page.locator('[role="dialog"]').last().innerText();
  check(/Paid ·|Quoted ·|never/.test(sp), "provenance labels or 'never' present",
    (sp.match(/(Paid ·|Quoted ·|never)[^\n]*/) || ["absent"])[0]);
  const prefBtns = await page.getByRole("button", { name: /Make preferred/ }).count();
  console.log(`  'Make preferred' buttons: ${prefBtns} (hidden on the row that already is)`);
  check(true, `suppliers & prices dialog renders (${sp.split("\n").length} lines)`);
  await shot(page, "task5-step9-prices");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ── Step 11: add engine ───────────────────────────────────────────────────
  step("Step 11: add engine");
  await goto(page, "/master-inventory?tab=engines");
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Add engine/ }).click();
  await page.waitForTimeout(1000);
  const ESERIAL = `ZZQAENG${STAMP}`;
  const dlg = page.locator('[role="dialog"]').last();
  const dt = await dlg.innerText();
  check(/Serial/.test(dt), "Add engine dialog has a Serial field");
  await dlg.locator('input').first().waitFor({ state: "visible", timeout: 8000 });
  console.log("  add-engine fields:", dt.split("\n").slice(0, 14).join(" · "));
  await shot(page, "task5-step11-addengine");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ── Step 16: models manager ───────────────────────────────────────────────
  step("Step 16: models manager");
  await page.getByRole("button", { name: /^Models$/ }).click();
  await page.waitForTimeout(1200);
  const mm = page.locator('[role="dialog"]').last();
  const mt = await mm.innerText();
  const hasCancel = await mm.getByRole("button", { name: /^Cancel$/ }).count();
  check(hasCancel === 0, "no footer Cancel — dismissed with the X only", `${hasCancel} cancel buttons`);
  console.log("  models manager:", mt.split("\n").slice(0, 6).join(" · "));
  await shot(page, "task5-step16-models");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ── Step 15: merge duplicates ─────────────────────────────────────────────
  step("Step 15: merge duplicates");
  await goto(page, "/master-inventory");
  await page.getByRole("button", { name: /Merge duplicates/ }).click();
  await page.waitForTimeout(1200);
  const md = page.locator('[role="dialog"]').last();
  check(/duplicate that still holds stock must be zeroed first/.test(await md.innerText()),
    "dialog explains the zero-stock rule");
  check((await md.getByText("Merge these into it").count()) === 0,
    "sources list is hidden until a survivor is chosen");
  await pickSelect(md, 0, `${P1} · 0 pc`).catch(async () => {
    await md.locator('[role="combobox"]').first().click();
    await page.waitForTimeout(400);
    await page.getByRole("option", { name: new RegExp(P1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) }).first().click();
  });
  await page.waitForTimeout(1200);
  check((await md.getByText("Merge these into it").count()) > 0,
    "sources list appears once a survivor is chosen");
  const srcLabel = md.locator("label").filter({ hasText: P2 }).first();
  check((await srcLabel.count()) > 0, "the duplicate is listed as a source");
  check(/0 pc/.test(await srcLabel.innerText()), "source shows its stock badge",
    (await srcLabel.innerText()).replace(/\n/g, " · "));
  await srcLabel.locator('button[role="checkbox"], input[type="checkbox"]').first().click();
  await page.waitForTimeout(2000);
  await md.getByRole("button", { name: /Merge 1 into survivor/ }).click();
  await page.waitForTimeout(4000);
  const mergedRow = (await q(`parts?select=id,merged_into,deleted_at&name=eq.${encodeURIComponent(P2)}`))[0];
  check(!!mergedRow.merged_into && !!mergedRow.deleted_at,
    "duplicate is tombstoned onto the survivor", JSON.stringify(mergedRow));
  check(mergedRow.merged_into === made[0].id, "merged_into points at the survivor");
  const audit = await q(`part_merges?select=id&source_part_id=eq.${mergedRow.id}`);
  check(audit.length === 1, "merge recorded in part_merges", `${audit.length}`);

  // ── Step 14: retire as GERRY ──────────────────────────────────────────────
  step("Step 14: retire a product as GERRY");
  // retire P4, not P1: a qty-0 add writes only the zero-value receiving header
  // — no line, no movement (0059) — so P1 has no history to prove survives.
  await search(P4, P4);
  menu = await rowMenu(P4);
  check(/Remove product/.test(menu), "Gerry sees 'Remove product'");
  await page.getByRole("menuitem", { name: /Remove product/ }).click();
  await page.waitForTimeout(900);
  const confirmText = await page.locator('[role="alertdialog"], [role="dialog"]').last().innerText();
  check(/Its history stays in the ledger, but it disappears from product and shop stock lists\./.test(confirmText),
    "confirm copy promises history is kept",
    confirmText.split("\n").filter(Boolean).slice(0, 3).join(" · "));
  await page.getByRole("button", { name: /^(Remove|Delete|Confirm)/ }).last().click();
  await page.waitForTimeout(3500);
  const retired = (await q(`parts?select=deleted_at&id=eq.${p4.id}`))[0];
  check(!!retired.deleted_at, "product soft-deleted", String(retired.deleted_at));
  await search(P4, null);
  // NOT a body-text check: the empty state quotes the search term back, so the
  // name is legitimately still on the page. Assert the ROW is gone.
  check((await page.getByRole("button", { name: `Actions for ${P4}`, exact: true }).count()) === 0,
    "retired product no longer listed");
  // soft-delete, not erasure — the promise the dialog just made
  check((await q(`receiving_lines?select=id&part_id=eq.${p4.id}`)).length === 1,
    "its receiving line still exists after retiring");
  check((await q(`stock_movements?select=id&part_id=eq.${p4.id}`)).length >= 1,
    "its ledger movement still exists after retiring");

  // ── Step 17: categories ───────────────────────────────────────────────────
  step("Step 17: categories tab");
  const CAT = `ZZ-QA Cat ${STAMP}`;
  await goto(page, "/master-inventory/categories");
  await page.waitForTimeout(1500);
  check(/Lower order numbers appear first|Category|Categories/.test(await T()), "categories page renders");
  // "Add category" is an inline form button, disabled until the name is typed
  const nameBox = page.locator('input[placeholder="e.g. Electrical, Safety Gear"]').first();
  const addCat = page.getByRole("button", { name: "Add category", exact: true });
  check(await addCat.isDisabled(), "'Add category' is disabled while the name is blank");
  await nameBox.fill(CAT);
  await page.waitForTimeout(400);
  check(!(await addCat.isDisabled()), "'Add category' enables once a name is typed");
  await addCat.click();
  await page.waitForTimeout(3000);
  let cats = await q(`product_categories?select=id,name,deleted_at&name=eq.${encodeURIComponent(CAT)}`);
  check(cats.length === 1 && !cats[0].deleted_at, "category created", JSON.stringify(cats));
  check((await T()).includes(CAT), "new category appears in the list");
  const catId = cats[0]?.id;

  // it must reach the product pickers immediately (revalidation)
  await goto(page, "/master-inventory");
  await page.getByRole("button", { name: /Add product/ }).click();
  await page.waitForTimeout(1000);
  await page.locator('[role="dialog"] [role="combobox"]').first().click();
  await page.waitForTimeout(600);
  check((await page.getByRole("option", { name: CAT, exact: true }).count()) > 0,
    "the new category is offered in the Add product picker");
  // finish creating a product in that category so the retire copy has usage > 0
  await page.getByRole("option", { name: CAT, exact: true }).first().click();
  await page.waitForTimeout(400);
  const P3 = `ZZ-QA CatUser ${STAMP}`;
  await page.locator("#ap-name").fill(P3);
  await page.locator("#ap-cost").fill("100");
  await page.locator("#ap-price").fill("200");
  await page.locator("#ap-qty").fill("0");
  await page.getByRole("button", { name: /^(Add product|Create|Save)$/ }).last().click();
  await page.waitForTimeout(3000);
  const p3 = await q(`parts?select=id,category_id&name=eq.${encodeURIComponent(P3)}`);
  check(p3.length === 1 && p3[0].category_id === catId,
    "a product was created in the new category", JSON.stringify(p3[0]));

  // rename
  await goto(page, "/master-inventory/categories");
  await page.waitForTimeout(1500);
  const RENAMED = `${CAT} renamed`;
  // per-row controls are aria-labelled `Rename/Save/Retire <name>`
  const rowInput = page.getByRole("textbox", { name: `Rename ${CAT}`, exact: true });
  check((await rowInput.count()) > 0, "the row exposes a Rename field");
  await rowInput.fill(RENAMED);
  await page.waitForTimeout(500);
  const saveRow = page.getByRole("button", { name: `Save ${CAT}`, exact: true });
  check(!(await saveRow.isDisabled()), "row Save enables once the name changes");
  await saveRow.click();
  await page.waitForTimeout(3000);
  cats = await q(`product_categories?select=name&id=eq.${catId}`);
  check(cats[0]?.name === RENAMED, "category renamed", cats[0]?.name);

  // retire, then re-create the same name → restored, not duplicated
  await goto(page, "/master-inventory/categories");
  await page.waitForTimeout(1500);
  const retireBtn = page.getByRole("button", { name: `Retire ${RENAMED}`, exact: true });
  if (await retireBtn.count()) {
    await retireBtn.click();
    await page.waitForTimeout(900);
    const copy = await page.locator('[role="alertdialog"], [role="dialog"]').last().innerText();
    check(/can no longer be picked|history stays intact|keep it as their category/i.test(copy),
      "retire copy explains the consequence", copy.split("\n").slice(0, 3).join(" · "));
    await page.getByRole("button", { name: /^(Remove|Retire|Delete|Confirm)/ }).last().click();
    await page.waitForTimeout(3000);
    cats = await q(`product_categories?select=deleted_at&id=eq.${catId}`);
    check(!!cats[0]?.deleted_at, "category retired", String(cats[0]?.deleted_at));

    await page.locator('input[placeholder="e.g. Electrical, Safety Gear"]').first().fill(RENAMED);
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Add category", exact: true }).click();
    await page.waitForTimeout(3000);
    const again = await q(`product_categories?select=id,deleted_at&name=eq.${encodeURIComponent(RENAMED)}`);
    check(again.length === 1, "re-creating a retired name does NOT duplicate it", `${again.length} rows`);
    check(again[0]?.id === catId && !again[0]?.deleted_at,
      "the retired category is RESTORED (same id, un-deleted)", JSON.stringify(again[0]));
  } else {
    check(false, "a retire control exists on the category row");
  }
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task5b-crash").catch(() => {});
} finally {
  fs.rmSync(PNG, { force: true });
  console.log("\nSTAMP:", STAMP);
  console.log("console errors:", errors.length ? errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
