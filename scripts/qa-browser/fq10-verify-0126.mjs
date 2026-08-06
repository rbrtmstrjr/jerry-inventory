// FQ10 — verify 0126, and finish the approval leg the 556-item queue blocked.
//
// 0126 fixed two things in reviewed_items.summary:
//   1. `|| sl.qty`            -> every whole qty rendered "2.0"
//   2. `case when sl.qty > 1` -> a qty BELOW 1 printed no quantity at all
//
// Defect 2 needs a reviewed sale line with qty < 1, so this records a 0.5 kg
// sale, submits the batch, approves it, and reads the history back.
import {
  launch, session, goto, shot, check, step, summary, toast, dbAuth,
} from "./qa-lib.mjs";

const NAILS_NAME = process.argv[2];
const { browser } = await launch({ headless: true });
const q = await dbAuth("owner");
const PART = (await q(`parts?name=eq.${encodeURIComponent(NAILS_NAME)}&select=id`))[0];
const TERNATE = "a46c9c78-a995-46b3-954f-7836ab161254";

try {
  const owner = await session(browser, "owner");

  // ── 0126 part 1: no bare "N.0" in the reviewed history ───────────────────
  step("0126 — whole quantities read '2', not '2.0'");
  const rows = await q(`reviewed_items?select=summary,item_type&limit=400`);
  const dotZero = rows.filter((r) => /\b\d+\.0\b/.test(r.summary ?? ""));
  check(
    dotZero.length === 0,
    `no reviewed_items summary renders a bare N.0 (${rows.length} rows checked)`,
    JSON.stringify(dotZero.slice(0, 3).map((r) => r.summary))
  );
  const withQty = rows.filter((r) => /×/.test(r.summary ?? "")).slice(0, 3);
  console.log("  sample summaries:", JSON.stringify(withQty.map((r) => r.summary)));

  await goto(owner.page, "/approvals?tab=sales");
  await owner.page.waitForTimeout(2500);
  const txt = await owner.page.evaluate(() => document.body.innerText);
  check(!/\b\d+\.0\b/.test(txt), "the rendered Approval Queue shows no N.0",
    (txt.match(/\b\d+\.0\b/) || ["none"])[0]);
  await shot(owner.page, "fq10-01-approvals-after-0126");

  // ── Record a 0.5 kg sale (the < 1 case defect 2 hid) ─────────────────────
  step("0126 — a sale line BELOW 1 must still print its quantity");
  const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
  await goto(shop.page, "/shop/record-sale");
  await shop.page.waitForTimeout(2000);
  const scan = shop.page.locator("input#scan, input[placeholder*='can']").first();
  if (await scan.count()) { await scan.fill(NAILS_NAME); await shop.page.waitForTimeout(1200); }
  await shop.page.getByRole("button", { name: new RegExp(NAILS_NAME, "i") }).first().click();
  await shop.page.waitForTimeout(900);

  const cartQty = shop.page.getByLabel(/quantity in kg/i).first();
  await cartQty.fill("");
  await cartQty.type("0.5", { delay: 80 });
  await cartQty.blur();
  await shop.page.waitForTimeout(700);
  check((await cartQty.inputValue()) === "0.5", "cart holds 0.5");
  const cart = await shop.page.evaluate(() => document.body.innerText);
  check(/₱7\.75/.test(cart), "cart shows ₱7.75 (15.50 x 0.5)", (cart.match(/₱[\d,.]+/g) || []).slice(0, 4).join(","));
  await shot(shop.page, "fq10-02-cart-0.5");
  await shop.page.getByRole("button", { name: /record sale|save sale|complete/i }).last().click();
  console.log(`  sale toast: ${await toast(shop.page, { timeout: 20000 })}`);
  await shop.page.waitForTimeout(1500);

  // ── Submit the batch, then approve it as owner ───────────────────────────
  step("R4 — approving fractional sales deducts exactly 2.3 + 0.5");
  const before = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
  console.log(`  shop holds ${before} before approval`);

  await goto(shop.page, "/shop/submissions");
  await shop.page.waitForTimeout(1800);
  const sub = shop.page.getByRole("button", { name: /submit.*admin|submit batch/i }).first();
  if (await sub.count()) {
    await sub.click();
    await shop.page.waitForTimeout(800);
    const dlg = shop.page.locator('[role="alertdialog"], [role="dialog"]').last();
    if (await dlg.count()) {
      const go = dlg.getByRole("button", { name: /submit|confirm|yes/i }).last();
      if (await go.count()) await go.click();
    }
    console.log(`  submit toast: ${await toast(shop.page, { timeout: 20000 })}`);
    await shop.page.waitForTimeout(2000);
  }

  // Approve the Ternate batch as a unit — that is what the page is FOR
  // ("Approve all" per submission batch), and it is how Gerry works.
  await goto(owner.page, "/approvals");
  await owner.page.waitForTimeout(2500);
  const h = await owner.page.evaluateHandle(() => {
    for (const el of document.querySelectorAll("div")) {
      const t = el.innerText || "";
      if (!/Gerwin-Ternate/i.test(t)) continue;
      const btns = [...el.querySelectorAll("button")].filter((b) => /approve all/i.test(b.innerText || ""));
      if (btns.length === 1) return btns[0];
    }
    return null;
  });
  const el = h.asElement();
  check(!!el, "found 'Approve all' on the Gerwin-Ternate batch");
  if (el) {
    console.log(`  clicking: ${await owner.page.evaluate((b) => b.innerText.trim(), el)}`);
    await el.click();
    await owner.page.waitForTimeout(800);
    const conf = owner.page.locator('[role="alertdialog"]').last();
    if (await conf.count()) {
      const yes = conf.getByRole("button", { name: /approve|confirm|yes/i }).last();
      if (await yes.count()) await yes.click();
    }
    console.log(`  approve toast: ${await toast(owner.page, { timeout: 30000 })}`);
    await owner.page.waitForTimeout(3000);

    const after = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
    check(
      Math.abs(after - (before - 2.8)) < 1e-9,
      `shop stock ${before} - 2.3 - 0.5 = ${(before - 2.8).toFixed(1)}`,
      String(after)
    );

    // reconcile
    const mv = await q(`stock_movements?part_id=eq.${PART.id}&select=qty_change,shop_id,movement_type`);
    const lv = await q(`stock_levels?part_id=eq.${PART.id}&select=qty,shop_id`);
    const s = (a, k) => a.reduce((x, r) => x + Number(r[k]), 0);
    let ok = true;
    for (const sid of new Set([...mv.map((m) => m.shop_id), ...lv.map((l) => l.shop_id)])) {
      const ledger = s(mv.filter((m) => m.shop_id === sid && m.movement_type !== "transit_writeoff"), "qty_change");
      const shelf = s(lv.filter((l) => l.shop_id === sid), "qty");
      const good = Math.abs(ledger - shelf) < 1e-9;
      if (!good) ok = false;
      console.log(`      ${sid ?? "master"}: ledger ${ledger} vs shelf ${shelf} ${good ? "OK" : "MISMATCH"}`);
    }
    check(ok, "invariant holds after approving both fractional sales");
  }

  // ── 0126 part 2: the 0.5 line must now print its quantity ────────────────
  step("0126 — the 0.5 line shows '× 0.5' in the reviewed history");
  const after = await q(
    `reviewed_items?item_type=eq.sale&select=summary&order=event_at.desc&limit=40`
  );
  const half = after.filter((r) => /0\.5/.test(r.summary ?? ""));
  check(
    half.length > 0,
    "a reviewed summary contains '0.5' (before 0126 it printed nothing)",
    JSON.stringify(after.slice(0, 3).map((r) => r.summary))
  );
  console.log("  matching summaries:", JSON.stringify(half.slice(0, 2).map((r) => r.summary)));
  check(
    !after.some((r) => /\b\d+\.0\b/.test(r.summary ?? "")),
    "and still no N.0 among the newest reviewed rows"
  );

  await goto(owner.page, "/approvals?tab=sales");
  await owner.page.waitForTimeout(2500);
  await shot(owner.page, "fq10-03-reviewed-history");

  console.log("CONSOLE ERRORS:", [...(owner.errors ?? []), ...(shop.errors ?? [])].slice(0, 6));
} catch (e) {
  console.error("\nFQ10 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
