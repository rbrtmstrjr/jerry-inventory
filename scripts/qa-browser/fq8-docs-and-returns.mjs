// FQ8 — the printed record, and the one input left unverified.
//
// R8: a quantity must read "10.5" / "2.3" / "0.4" on every document, and NEVER
// "10.50000000000001" or a bare "12.0". fmt_qty() in SQL and formatQty() in TS
// have to agree, or a printed document disagrees with the screen it came from.
import {
  launch, session, goto, shot, check, step, summary, dbAuth,
} from "./qa-lib.mjs";

const NAILS_NAME = process.argv[2];
const { browser } = await launch({ headless: true });
const q = await dbAuth("owner");
const PART = (await q(`parts?name=eq.${encodeURIComponent(NAILS_NAME)}&select=id`))[0];

const FLOAT = /\d\.\d{4,}/;           // 0.40000000000000036, 2.2999999999
const TRAILING_ZERO = /\b\d+\.0\b/;   // "12.0" — Postgres numeric leaking raw

/** Assert a rendered surface is free of both artefacts. */
async function sweep(page, label, mustContain = []) {
  const txt = await page.evaluate(() => document.body.innerText);
  check(!FLOAT.test(txt), `${label}: no raw float`, (txt.match(FLOAT) || ["none"])[0]);
  check(!TRAILING_ZERO.test(txt), `${label}: no bare "N.0"`, (txt.match(TRAILING_ZERO) || ["none"])[0]);
  for (const m of mustContain) {
    check(new RegExp(m.replace(".", "\\.")).test(txt), `${label}: shows ${m}`,
      txt.replace(/\n+/g, " ").slice(0, 100));
  }
  return txt;
}

try {
  const owner = await session(browser, "owner", { stubPrint: true });

  // our fixture's delivery + sale
  const dl = await q(`delivery_lines?part_id=eq.${PART.id}&select=delivery_id,qty,qty_received&order=id.desc&limit=1`);
  const del = dl[0];
  const sl = await q(`sale_lines?part_id=eq.${PART.id}&select=sale_id,qty&order=created_at.desc&limit=1`);
  const sale = sl[0];
  console.log(`  delivery=${del?.delivery_id} (${del?.qty} sent, ${del?.qty_received} received)`);
  console.log(`  sale=${sale?.sale_id} (${sale?.qty})`);

  step("R8 — Delivery Note (owner copy)");
  await goto(owner.page, `/deliveries/${del.delivery_id}/note`);
  await owner.page.waitForTimeout(1500);
  await sweep(owner.page, "owner delivery note", ["10.1"]);
  await shot(owner.page, "fq8-01-delivery-note-owner");

  step("R8 — Movements journal + stock card");
  await goto(owner.page, `/movements?tab=journal&product=${PART.id}`);
  await owner.page.waitForTimeout(2000);
  await sweep(owner.page, "movements journal");
  await shot(owner.page, "fq8-02-journal");

  await goto(owner.page, `/movements?tab=ledger&part=${PART.id}`);
  await owner.page.waitForTimeout(2000);
  await sweep(owner.page, "stock card");
  await shot(owner.page, "fq8-03-stock-card");

  step("R8 — Approval Queue / reviewed detail");
  await goto(owner.page, "/approvals?tab=sales");
  await owner.page.waitForTimeout(2000);
  await sweep(owner.page, "approval queue");

  // ── shop side ────────────────────────────────────────────────────────────
  const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });

  step("R8 — Delivery Note (shop copy) + My Shop Stock");
  await goto(shop.page, `/shop/deliveries/${del.delivery_id}/note`);
  await shop.page.waitForTimeout(1500);
  await sweep(shop.page, "shop delivery note", ["10.1"]);
  await shot(shop.page, "fq8-04-delivery-note-shop");

  await goto(shop.page, "/shop");
  await shop.page.waitForTimeout(2000);
  const stockTxt = await sweep(shop.page, "my shop stock");
  console.log(`  shop stock page mentions fixture: ${new RegExp(NAILS_NAME, "i").test(stockTxt)}`);
  await shot(shop.page, "fq8-05-shop-stock");

  step("R8 — Submissions (the shop's own record of the 2.3 sale)");
  await goto(shop.page, "/shop/submissions");
  await shop.page.waitForTimeout(2000);
  await sweep(shop.page, "submissions");
  await shot(shop.page, "fq8-06-submissions");

  // ── the one input not yet verified ───────────────────────────────────────
  step("BUG B — return-to-admin good/damaged boxes (shop)");
  await goto(shop.page, "/shop/transfers");
  await shop.page.waitForTimeout(1800);
  const tabs = await shop.page.getByRole("tab").allTextContents();
  console.log(`  transfer tabs: ${JSON.stringify(tabs)}`);
  const retTab = shop.page.getByRole("tab", { name: /return/i }).first();
  if (await retTab.count()) {
    await retTab.click();
    await shop.page.waitForTimeout(1500);
    // pick an item, then Add — the form needs both before qty boxes appear
    const combo = shop.page.locator('button[role="combobox"]').first();
    if (await combo.count()) {
      await combo.click();
      await shop.page.waitForTimeout(700);
      const opt = shop.page.getByRole("option").first();
      if (await opt.count()) { await opt.click(); await shop.page.waitForTimeout(600); }
    }
    const add = shop.page.getByRole("button", { name: /^add$/i }).first();
    if (await add.count()) { await add.click(); await shop.page.waitForTimeout(900); }

    const boxes = shop.page.locator('input[inputmode="decimal"]');
    const cnt = await boxes.count();
    console.log(`  ${cnt} decimal boxes after adding a line`);
    if (cnt > 0) {
      const el = boxes.first();
      await el.fill("");
      await el.type("2.5", { delay: 70 });
      const got = await el.inputValue();
      check(got === "2.5", `return good qty: typed 2.5 -> "${got}"`, got);
      await shot(shop.page, "fq8-07-return-qty");
    } else check(false, "no qty box appeared on the return form");
  } else check(false, "no Return tab");

  console.log("CONSOLE ERRORS:", [...(owner.errors ?? []), ...(shop.errors ?? [])].slice(0, 6));
} catch (e) {
  console.error("\nFQ8 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
