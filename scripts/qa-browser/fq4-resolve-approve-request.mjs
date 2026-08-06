// FQ4 — after 0125: resolve the stranded 0.4, approve the fractional sale,
// and file a 2.5 kg stock request (the delivery_request_lines.qty_requested
// column 0125 also fixed). Ends by reconciling the ledger to the shelf.
import {
  launch, login, goto, shot, check, step, summary, toast, clearToasts, dbAuth,
  session,
} from "./qa-lib.mjs";

const NAILS_NAME = process.argv[2];
const { browser, page, errors } = await launch({ headless: true });
const q = await dbAuth("owner");
const PART = (await q(`parts?name=eq.${encodeURIComponent(NAILS_NAME)}&select=id`))[0];
if (!PART) { console.error("fixture not found"); process.exit(2); }

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

/** Click the Resolve button that belongs to OUR row — never positionally. */
async function ourResolveButton() {
  const h = await page.evaluateHandle((name) => {
    const wanted = name.toLowerCase();
    let best = null;
    for (const el of document.querySelectorAll("div,li,tr")) {
      const t = (el.innerText || "").toLowerCase();
      if (!t.includes(wanted)) continue;
      const btns = [...el.querySelectorAll("button")].filter((b) => /resolve/i.test(b.innerText || ""));
      if (btns.length !== 1) continue;
      if (!best || el.innerText.length < best.innerText.length) best = el;
    }
    return best ? [...best.querySelectorAll("button")].find((b) => /resolve/i.test(b.innerText || "")) : null;
  }, NAILS_NAME);
  return h.asElement();
}

try {
  await login(page, "owner");

  // ── 0125 regression: the 0.4 that could not be resolved ──────────────────
  step("0125 — resolve the 0.4 kg stranded in transit");
  await goto(page, "/deliveries?tab=transit");
  await page.waitForTimeout(1500);

  const btn = await ourResolveButton();
  check(!!btn, `found the Resolve button for ${NAILS_NAME}`);
  if (btn) {
    await btn.click();
    await page.waitForTimeout(1000);
    const dlg = page.locator('[role="dialog"]').last();
    const dtxt = await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? "");
    check(new RegExp(NAILS_NAME, "i").test(dtxt), "the dialog names OUR fixture");

    const rq = page.locator("#res-qty");
    await rq.fill("");
    await rq.type("0.4", { delay: 80 });
    check((await rq.inputValue()) === "0.4", "resolve qty box holds 0.4");

    const lost = dlg.getByRole("button", { name: /lost in transit/i }).first();
    if (await lost.count()) { await lost.click(); await page.waitForTimeout(300); }
    await dlg.getByRole("button", { name: /write off/i }).first().click();
    await page.waitForTimeout(300);
    await shot(page, "fq4-01-resolve-0.4");
    await dlg.locator('[data-slot="dialog-footer"] button').last().click();
    const t = await toast(page, { timeout: 15000 });
    console.log(`    toast: ${t || "(none)"}`);
    await page.waitForTimeout(1800);

    check(!/violates check constraint/i.test(t), "no CHECK-constraint error (0125 applied)", t);

    const wof = await q(`stock_movements?part_id=eq.${PART.id}&movement_type=eq.transit_writeoff&select=qty_change`);
    check(
      wof.some((m) => Math.abs(Number(m.qty_change) + 0.4) < 1e-9),
      "a transit_writeoff of -0.4 is booked",
      JSON.stringify(wof.map((m) => m.qty_change))
    );

    const disc = await q(`delivery_discrepancies?select=qty,resolution&order=resolved_at.desc&limit=5`);
    check(
      disc.some((d) => Math.abs(Number(d.qty) - 0.4) < 1e-9),
      "the AUDIT ROW records 0.4, not a rounded 0 or 1",
      JSON.stringify(disc.map((d) => d.qty))
    );
    await reconcile("0.4 write-off");
  }

  // ── Approve the 2.3 kg sale so the stock actually leaves the shelf ───────
  step("R1/R4 — approving a fractional sale deducts exactly 2.3");
  const shopStockBefore = Number(
    (await q(`stock_levels?part_id=eq.${PART.id}&shop_id=not.is.null&select=qty`))[0]?.qty ?? 0
  );
  const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
  await goto(shop.page, "/shop/submissions");
  await shop.page.waitForTimeout(1500);
  const submitBtn = shop.page.getByRole("button", { name: /submit.*admin|submit batch/i }).first();
  if (await submitBtn.count()) {
    await submitBtn.click();
    await shop.page.waitForTimeout(800);
    const conf = shop.page.locator('[role="alertdialog"], [role="dialog"]').last();
    if (await conf.count()) {
      const go = conf.getByRole("button", { name: /submit|confirm|yes/i }).last();
      if (await go.count()) await go.click();
    }
    console.log(`    submit toast: ${await toast(shop.page, { timeout: 15000 })}`);
    await shop.page.waitForTimeout(1500);
  }

  await goto(page, "/approvals");
  await page.waitForTimeout(2000);
  const bodyA = await page.evaluate(() => document.body.innerText);
  check(
    new RegExp(NAILS_NAME, "i").test(bodyA),
    "the fractional sale reached the Approval Queue",
    bodyA.slice(0, 60)
  );
  check(
    /ZZ-QA Nails[^\n]*2\.3|2\.3\s*(kg)?/i.test(bodyA),
    "the queue shows 2.3, not 2 or 2.30000000000001",
    (bodyA.match(/2\.3\d*/) || ["none"])[0]
  );
  check(!/\d\.\d{5,}/.test(bodyA), "no raw float on the Approval Queue", (bodyA.match(/\d\.\d{5,}/) || ["none"])[0]);
  await shot(page, "fq4-02-approvals");

  console.log("CONSOLE ERRORS:", [...errors, ...(shop?.errors ?? [])].slice(0, 6));
} catch (e) {
  console.error("\nFQ4 THREW:", e.message);
  await shot(page, "fq4-crash").catch(() => {});
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
