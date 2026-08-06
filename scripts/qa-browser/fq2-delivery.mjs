// FQ2 — the delivery lifecycle at a fractional quantity.
//
// THE HEADLINE TEST: migration 0119 exists because `v_short` was an int, so a
// 0.4 kg shortfall rounded to 0, the delivery was marked CONFIRMED, and
// Sum(movements) = stock_levels quietly stopped holding. Nothing raises.
// Here: send 10.5, confirm 10.1, and the delivery MUST become `discrepancy`.
import {
  launch, login, goto, shot, check, step, summary, toast, clearToasts, dbAuth,
  session, VIEWPORTS,
} from "./qa-lib.mjs";

const NAILS_NAME = process.argv[2];
if (!NAILS_NAME) {
  console.error("usage: node fq2-delivery.mjs 'ZZ-QA Nails XXXX'");
  process.exit(2);
}

const { browser, page, errors } = await launch({ headless: true });
const q = await dbAuth("owner");

const partRows = await q(`parts?name=eq.${encodeURIComponent(NAILS_NAME)}&select=id,unit`);
const PART = partRows[0];
if (!PART) { console.error("fixture part not found:", NAILS_NAME); process.exit(2); }

const sum = (arr, k) => arr.reduce((s, r) => s + Number(r[k]), 0);
/** The invariant CLAUDE.md and test-movements protect, scoped to our fixture. */
async function reconcile(label) {
  const mv = await q(`stock_movements?part_id=eq.${PART.id}&select=qty_change,shop_id,movement_type`);
  const lv = await q(`stock_levels?part_id=eq.${PART.id}&select=qty,shop_id`);
  let allOk = true;
  const shops = new Set([...mv.map((m) => m.shop_id), ...lv.map((l) => l.shop_id)]);
  for (const s of shops) {
    // transit_writeoff debits a bucket it never occupied — movement_journal
    // relocates it to 'transit'; the shelf comparison must exclude it (0045).
    const ledger = sum(mv.filter((m) => m.shop_id === s && m.movement_type !== "transit_writeoff"), "qty_change");
    const shelf = sum(lv.filter((l) => l.shop_id === s), "qty");
    const ok = Math.abs(ledger - shelf) < 1e-9;
    if (!ok) allOk = false;
    console.log(`      ${s ?? "master"}: ledger ${ledger} vs shelf ${shelf} ${ok ? "OK" : "MISMATCH"}`);
  }
  check(allOk, `invariant holds after ${label}`);
}

async function topUpMaster(kg) {
  await goto(page, "/suppliers?tab=receiving");
  await page.getByRole("button", { name: /new receiving/i }).first().click();
  await page.waitForTimeout(1200);
  await page.locator('button[role="combobox"]').filter({ hasText: /pick the supplier/i }).click();
  await page.waitForTimeout(400);
  await page.getByRole("option").first().click();
  await page.waitForTimeout(2600);
  await page.getByRole("button", { name: "Add part", exact: true }).click();
  await page.waitForTimeout(600);
  await page.locator('button[role="combobox"]').filter({ hasText: /pick item/i }).last().click();
  await page.waitForTimeout(500);
  await page.getByPlaceholder(/search name, sku/i).fill(NAILS_NAME);
  await page.waitForTimeout(600);
  await page.getByRole("option", { name: new RegExp(NAILS_NAME, "i") }).first().click();
  await page.waitForTimeout(500);
  await page.getByLabel("Quantity").last().fill(String(kg));
  await page.getByLabel("Unit cost in pesos").last().fill("8.00");
  const ovr = page.locator("#rcv-override");
  if (await ovr.count()) await ovr.fill("ZZ-QA fractional-quantity test run");
  await page.getByRole("button", { name: /receive stock/i }).click();
  await page.locator('[data-slot="dialog-content"]').filter({ hasText: /stock received/i })
    .waitFor({ timeout: 20000 }).catch(() => {});
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
}

try {
  await login(page, "owner");

  step("setup - top master up to a known quantity");
  const have = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=is.null&select=qty`))[0]?.qty ?? 0);
  if (have < 12) await topUpMaster(40);
  const nowHave = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=is.null&select=qty`))[0]?.qty ?? 0);
  check(nowHave >= 12, `master has enough to deliver from`, String(nowHave));

  // ── Deliver 10.5 kg ──────────────────────────────────────────────────────
  step("R1 — deliver 10.5 kg from master to a shop");
  const before = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=is.null&select=qty`))[0]?.qty);
  await goto(page, "/deliveries?tab=delivery");

  await page.locator('button[role="combobox"]').filter({ hasText: /pick a shop/i }).first().click();
  await page.waitForTimeout(400);
  const shopOpt = page.getByRole("option", { name: /Ternate/i }).first();
  const SHOP_NAME = (await shopOpt.textContent())?.trim();
  await shopOpt.click();
  await page.waitForTimeout(900);
  console.log(`    destination: ${SHOP_NAME}`);

  await page.getByRole("button", { name: /add (part|line|item)/i }).first().click();
  await page.waitForTimeout(600);
  await page.locator('button[role="combobox"]').filter({ hasText: /pick item|select|choose/i }).last().click();
  await page.waitForTimeout(500);
  const search = page.getByPlaceholder(/search/i).last();
  if (await search.count()) { await search.fill(NAILS_NAME); await page.waitForTimeout(600); }
  await page.getByRole("option", { name: new RegExp(NAILS_NAME, "i") }).first().click();
  await page.waitForTimeout(500);

  const dq = page.getByLabel(/^quantity$/i).last();
  await dq.fill("");
  await dq.type("10.5", { delay: 60 });
  const dShown = await dq.inputValue();
  check(dShown === "10.5", `delivery qty box holds "10.5"`, dShown);
  await shot(page, "fq2-01-deliver-10.5");

  await page.getByRole("button", { name: /^deliver/i }).last().click();
  const t1 = await toast(page, { timeout: 15000 });
  console.log(`    toast: ${t1}`);

  const afterMaster = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=is.null&select=qty`))[0]?.qty);
  check(afterMaster === before - 10.5, `master ${before} - 10.5 = ${before - 10.5}`, String(afterMaster));

  const dl = await q(`delivery_lines?part_id=eq.${PART.id}&select=id,delivery_id,qty,qty_received,qty_outstanding&order=id.desc`);
  const line = dl[0];
  check(Number(line?.qty) === 10.5, "the delivery line stored 10.5", String(line?.qty));
  await reconcile("delivery out");

  // ── Shop confirms 10.1 of 10.5 ───────────────────────────────────────────
  step("R4/0119 — shop confirms 10.1; the 0.4 short MUST raise a discrepancy");
  const shop = await session(browser, "shop", { clearLocalStorage: true });
  await goto(shop.page, "/shop/deliveries");
  await shop.page.waitForTimeout(1200);

  const goodBox = shop.page.locator(`#good-${line.id}`);
  const exists = await goodBox.count();
  check(exists > 0, "the incoming delivery line is on the shop's page", `found ${exists}`);

  const im = await goodBox.getAttribute("inputmode");
  // prefilled with what was sent ("10.5") — clear or type() just appends
  await goodBox.fill("");
  await goodBox.type("10.1", { delay: 80 });
  const gShown = await goodBox.inputValue();
  console.log(`    Good box: inputMode="${im}", typed "10.1" -> shows "${gShown}"`);
  check(
    gShown === "10.1",
    `Good box keeps the decimal (inputMode=${im}); stripping "." turns 10.1 into 101`,
    gShown
  );
  await shot(shop.page, "fq2-02-shop-confirm-typed");

  // Only proceed to the real confirm if the box is not mangling input — a
  // mangled value would write junk stock into a shop and pollute the run.
  if (gShown === "10.1") {
    await shop.page.getByRole("button", { name: /confirm/i }).first().click();
    const t2 = await toast(shop.page, { timeout: 15000 });
    console.log(`    toast: ${t2}`);
    await shop.page.waitForTimeout(1500);

    const d = await q(`deliveries?id=eq.${line.delivery_id}&select=status`);
    check(
      d[0]?.status === "discrepancy",
      "0119 REGRESSION — a 0.4 shortfall marks the delivery `discrepancy`, not `confirmed`",
      String(d[0]?.status)
    );
    const dl2 = await q(`delivery_lines?id=eq.${line.id}&select=qty_received,qty_outstanding`);
    check(Number(dl2[0]?.qty_received) === 10.1, "qty_received is 10.1", String(dl2[0]?.qty_received));
    check(
      Math.abs(Number(dl2[0]?.qty_outstanding) - 0.4) < 1e-9,
      "qty_outstanding is exactly 0.4 (numeric, not float drift)",
      String(dl2[0]?.qty_outstanding)
    );
    await reconcile("shop confirm");
  } else {
    check(false, "SKIPPED the confirm — the Good box mangled the typed value", gShown);
  }

  console.log(`\nFIXTURE line=${line.id} delivery=${line.delivery_id} shop=${SHOP_NAME}`);
  console.log("CONSOLE ERRORS:", [...errors, ...(shop?.errors ?? [])].slice(0, 5));
} catch (e) {
  console.error("\nFQ2 THREW:", e.message);
  await shot(page, "fq2-crash").catch(() => {});
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
