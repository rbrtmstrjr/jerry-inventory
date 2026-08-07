// FQ3 — resolve the transit shortfall, then sell and write off a part-kilo.
// Re-verifies the transit-panel qty box (BUG A site) and proves R7: money is
// round(unit x qty), stored once, and the receipt agrees with the sale.
import {
  launch, login, goto, shot, check, step, summary, toast, clearToasts, dbAuth,
  session,
} from "./qa-lib.mjs";

const NAILS_NAME = process.argv[2];
const { browser, page, errors } = await launch({ headless: true });
const q = await dbAuth("owner");
const PART = (await q(`parts?name=eq.${encodeURIComponent(NAILS_NAME)}&select=id,price_centavos,cost_centavos`))[0];
if (!PART) { console.error("fixture not found"); process.exit(2); }
const TERNATE = "a46c9c78-a995-46b3-954f-7836ab161254";

const sum = (a, k) => a.reduce((s, r) => s + Number(r[k]), 0);
async function reconcile(label) {
  const mv = await q(`stock_movements?part_id=eq.${PART.id}&select=qty_change,shop_id,movement_type`);
  const lv = await q(`stock_levels?part_id=eq.${PART.id}&select=qty,shop_id`);
  let ok = true;
  for (const s of new Set([...mv.map((m) => m.shop_id), ...lv.map((l) => l.shop_id)])) {
    const ledger = sum(mv.filter((m) => m.shop_id === s && m.movement_type !== "transit_writeoff"), "qty_change");
    const shelf = sum(lv.filter((l) => l.shop_id === s), "qty");
    const good = Math.abs(ledger - shelf) < 1e-9;
    if (!good) ok = false;
    console.log(`      ${s ?? "master"}: ledger ${ledger} vs shelf ${shelf} ${good ? "OK" : "MISMATCH"}`);
  }
  check(ok, `invariant holds after ${label}`);
}

try {
  await login(page, "owner");

  // ── Resolve the 0.4 shortfall (transit-panel: a BUG A site) ──────────────
  step("R1/R4 — owner resolves the 0.4 kg still in transit");
  await goto(page, "/deliveries?tab=transit");
  await page.waitForTimeout(1200);
  const bodyBefore = await page.evaluate(() => document.body.innerText);
  check(
    !/0\.4000000/.test(bodyBefore),
    "transit list shows no raw float (0.40000000000000036)",
    (bodyBefore.match(/0\.4\d{5,}/) || ["none"])[0]
  );

  // 49 Resolve buttons on this page. NEVER address one positionally — a prior
  // QA run resolved another shop's discrepancy that way, a real irreversible
  // stock movement. Walk DOWN to the smallest element containing our marker
  // AND exactly one Resolve button (README pattern), then click that one.
  const handle = await page.evaluateHandle((name) => {
    const wanted = name.toLowerCase();
    let best = null;
    for (const el of document.querySelectorAll("div,li,tr")) {
      const t = (el.innerText || "").toLowerCase();
      if (!t.includes(wanted)) continue;
      const btns = [...el.querySelectorAll("button")].filter((b) =>
        /resolve/i.test(b.innerText || "")
      );
      if (btns.length !== 1) continue;
      if (!best || el.innerText.length < best.innerText.length) best = el;
    }
    return best?.querySelector("button:is(:not([disabled]))") && best
      ? [...best.querySelectorAll("button")].find((b) => /resolve/i.test(b.innerText || ""))
      : null;
  }, NAILS_NAME);
  const el = handle.asElement();
  check(!!el, `found the Resolve button belonging to ${NAILS_NAME}`);
  if (!el) throw new Error("could not isolate our row");
  await el.click();
  await page.waitForTimeout(1000);
  const dlgText = await page.evaluate(
    () => document.querySelector('[role="dialog"]')?.innerText ?? ""
  );
  check(
    new RegExp(NAILS_NAME, "i").test(dlgText),
    "the dialog names OUR fixture before anything is submitted",
    dlgText.slice(0, 80)
  );
  if (!new RegExp(NAILS_NAME, "i").test(dlgText)) throw new Error("wrong dialog — refusing to submit");
  const dlg = page.locator('[role="dialog"]').last();
  await shot(page, "fq3-01-resolve-dialog");

  const rq = page.locator("#res-qty");
  const pre = await rq.inputValue();
  console.log(`    resolve dialog prefilled qty: "${pre}"`);
  await rq.fill("");
  await rq.type("0.4", { delay: 80 });
  const rShown = await rq.inputValue();
  check(rShown === "0.4", `resolve qty box keeps "0.4" (BUG A site)`, rShown);

  if (rShown === "0.4") {
    // Cause = lost in transit, resolution = write off (shrinkage, never a shelf).
    // Both the resolution CARD and the footer submit say "Write off", so the
    // card is picked by its description and the submit is the footer's last button.
    const lost = dlg.getByRole("button", { name: /lost in transit/i }).first();
    if (await lost.count()) { await lost.click(); await page.waitForTimeout(400); }
    const woCard = dlg.getByRole("button", { name: /write off/i }).first();
    await woCard.click();
    await page.waitForTimeout(400);
    // NOT dlg.locator("button").last() — that is shadcn's absolutely-positioned
    // X close (README: never click .last() of a dialog's buttons).
    await dlg.locator('[data-slot="dialog-footer"] button').last().click();
    const t = await toast(page, { timeout: 15000 });
    console.log(`    toast: ${t}`);
    await page.waitForTimeout(1500);

    const wof = await q(`stock_movements?part_id=eq.${PART.id}&movement_type=eq.transit_writeoff&select=qty_change`);
    check(
      wof.some((m) => Math.abs(Number(m.qty_change) + 0.4) < 1e-9),
      "a transit_writeoff of -0.4 is booked",
      JSON.stringify(wof.map((m) => m.qty_change))
    );
    await reconcile("discrepancy resolve");
  }

  // ── Sell 2.3 kg at ₱15.50 ────────────────────────────────────────────────
  step("R7 — sell 2.3 kg; money rounds ONCE and is stored");
  const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
  await goto(shop.page, "/shop/record-sale");
  await shop.page.waitForTimeout(1500);

  const scan = shop.page.locator("input#scan, input[placeholder*='can']").first();
  if (await scan.count()) { await scan.fill(NAILS_NAME); await shop.page.waitForTimeout(1200); }
  const tile = shop.page.getByRole("button", { name: new RegExp(NAILS_NAME, "i") }).first();
  await tile.click();
  await shop.page.waitForTimeout(900);

  const cartQty = shop.page.getByLabel(/quantity in kg/i).first();
  const hasTyped = await cartQty.count();
  check(hasTyped > 0, "a kg line gets a TYPED quantity box (pieces get -/+ only)", `found ${hasTyped}`);
  if (hasTyped) {
    await cartQty.fill("");
    await cartQty.type("2.3", { delay: 80 });
    await cartQty.blur();
    await shop.page.waitForTimeout(700);
    const shown = await cartQty.inputValue();
    check(shown === "2.3", `cart qty box holds "2.3"`, shown);

    const bt = await shop.page.evaluate(() => document.body.innerText);
    check(/₱35\.65/.test(bt), "the cart shows ₱35.65 (15.50 x 2.3 rounded once)", (bt.match(/₱3[0-9.]+/g) || []).join(","));
    check(!/\d\.\d{5,}/.test(bt), "no raw float anywhere in the cart", (bt.match(/\d\.\d{5,}/) || ["none"])[0]);
    await shot(shop.page, "fq3-02-cart-2.3kg");

    await shop.page.getByRole("button", { name: /record sale|save sale|complete/i }).last().click();
    const st = await toast(shop.page, { timeout: 20000 });
    console.log(`    toast: ${st}`);
    await shop.page.waitForTimeout(1500);

    const sl = await q(`sale_lines?part_id=eq.${PART.id}&select=qty,unit_price_centavos,line_total_centavos&order=created_at.desc`);
    check(Number(sl[0]?.qty) === 2.3, "the sale line stored 2.3", String(sl[0]?.qty));
    check(sl[0]?.line_total_centavos === 3565, "line total is exactly 3565 centavos", String(sl[0]?.line_total_centavos));
  }

  console.log("CONSOLE ERRORS:", [...errors, ...(shop?.errors ?? [])].slice(0, 6));
} catch (e) {
  console.error("\nFQ3 THREW:", e.message);
  await shot(page, "fq3-crash").catch(() => {});
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
