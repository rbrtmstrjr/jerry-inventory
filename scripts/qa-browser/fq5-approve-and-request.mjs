// FQ5 — approve the fractional sale (stock must leave the shelf as exactly
// 2.3), then file a 2.5 kg stock request: the SECOND column 0125 fixed
// (delivery_request_lines.qty_requested was int, so 2.5 silently became 3).
import {
  launch, login, goto, shot, check, step, summary, toast, dbAuth, session,
} from "./qa-lib.mjs";

const NAILS_NAME = process.argv[2];
const { browser, page, errors } = await launch({ headless: true });
const q = await dbAuth("owner");
const PART = (await q(`parts?name=eq.${encodeURIComponent(NAILS_NAME)}&select=id`))[0];
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

  // ── Approve ONLY our sale ────────────────────────────────────────────────
  step("R4 — approving a 2.3 kg sale deducts exactly 2.3 from the shop");
  const before = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
  console.log(`    shop holds ${before} before approval`);

  await goto(page, "/approvals?tab=sales");
  await page.waitForTimeout(2000);

  // 556 queued items lazy-load behind a sentinel that must stay IN VIEW.
  // Scroll until our card appears rather than paging blindly.
  let found = false;
  for (let i = 0; i < 40 && !found; i++) {
    found = await page.evaluate(
      (n) => document.body.innerText.toLowerCase().includes(n.toLowerCase()),
      NAILS_NAME
    );
    if (found) break;
    await page.evaluate(() => {
      const sc = document.scrollingElement || document.body;
      const inner = [...document.querySelectorAll("*")].find(
        (e) => e.scrollHeight > e.clientHeight + 200 && getComputedStyle(e).overflowY !== "visible"
      );
      (inner ?? sc).scrollBy(0, 1400);
    });
    await page.waitForTimeout(900);
  }
  check(found, "scrolled the lazy queue until our fractional sale appeared");

  if (found) {
    // walk DOWN to the card holding our marker AND exactly one Approve button
    const h = await page.evaluateHandle((name) => {
      const wanted = name.toLowerCase();
      let best = null;
      for (const el of document.querySelectorAll("div,li,tr")) {
        const t = (el.innerText || "").toLowerCase();
        if (!t.includes(wanted)) continue;
        const btns = [...el.querySelectorAll("button")].filter((b) => /^approve$/i.test((b.innerText || "").trim()));
        if (btns.length !== 1) continue;
        if (!best || el.innerText.length < best.innerText.length) best = el;
      }
      return best ? [...best.querySelectorAll("button")].find((b) => /^approve$/i.test((b.innerText || "").trim())) : null;
    }, NAILS_NAME);
    const el = h.asElement();
    check(!!el, "isolated the Approve button on OUR sale card (not Approve all)");

    if (el) {
      const cardText = await page.evaluate((b) => b.closest("div")?.innerText ?? "", el);
      console.log(`    card: ${cardText.replace(/\n/g, " | ").slice(0, 120)}`);
      await shot(page, "fq5-01-our-sale-card");
      await el.click();
      const t = await toast(page, { timeout: 20000 });
      console.log(`    toast: ${t}`);
      await page.waitForTimeout(2000);

      const after = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
      check(
        Math.abs(after - (before - 2.3)) < 1e-9,
        `shop stock ${before} - 2.3 = ${(before - 2.3).toFixed(1)}`,
        String(after)
      );
      const cogs = await q(`sale_line_costs?select=line_cost_centavos,unit_cost_centavos&order=created_at.desc&limit=3`);
      console.log(`    frozen COGS rows: ${JSON.stringify(cogs.slice(0, 2))}`);
      await reconcile("sale approval");
    }
  }

  // ── The other 0125 column: a 2.5 kg request must stay 2.5 ────────────────
  step("0125 — a shop requests 2.5 kg; it must NOT become 3");
  const shop = await session(browser, "shop", { clearLocalStorage: true });
  await goto(shop.page, "/shop/low-stock");
  await shop.page.waitForTimeout(2000);

  // the custom-product row takes a free-text name + qty and needs no low stock
  const customName = `ZZ-QA Custom ${Date.now().toString(36).slice(-4)}`;
  const addCustom = shop.page.getByRole("button", { name: /add (a )?(new|custom) product|product we don/i }).first();
  if (await addCustom.count()) { await addCustom.click(); await shop.page.waitForTimeout(600); }

  const nameBox = shop.page.getByPlaceholder(/product name|what do you need|item name/i).first();
  if (await nameBox.count()) {
    await nameBox.fill(customName);
    await shop.page.waitForTimeout(400);
    const qtyBoxes = shop.page.locator('input[inputmode="decimal"]');
    const qb = qtyBoxes.last();
    await qb.fill("");
    await qb.type("2.5", { delay: 80 });
    const shown = await qb.inputValue();
    check(shown === "2.5", `request qty box holds "2.5"`, shown);
    await shot(shop.page, "fq5-02-request-2.5");

    await shop.page.getByRole("button", { name: /request \d+ item|send request|request delivery/i }).last().click();
    const rt = await toast(shop.page, { timeout: 20000 });
    console.log(`    toast: ${rt}`);
    await shop.page.waitForTimeout(1800);

    const lines = await q(`delivery_request_lines?custom_name=eq.${encodeURIComponent(customName)}&select=qty_requested`);
    check(lines.length === 1, "the request line was created", `${lines.length} rows`);
    check(
      Math.abs(Number(lines[0]?.qty_requested) - 2.5) < 1e-9,
      "0125 REGRESSION — qty_requested is 2.5, not a rounded 3",
      String(lines[0]?.qty_requested)
    );
  } else {
    check(false, "could not reach the custom-product request row", "selector miss");
  }

  console.log("CONSOLE ERRORS:", [...errors, ...(shop?.errors ?? [])].slice(0, 6));
} catch (e) {
  console.error("\nFQ5 THREW:", e.message);
  await shot(page, "fq5-crash").catch(() => {});
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
