/**
 * QA 0133 follow-up: a GRAM product is priced PER KILO and stored per gram.
 *
 * The bug this closes: ₱100/kg typed into a per-gram field booked ₱100 a gram,
 * and 4000 g came out as ₱400,000 on a delivery note.
 *
 * Run: node scripts/qa-browser/gp1-gram-price-per-kilo.mjs   (needs npm run dev)
 */
import { launch, login, goto, check, summary, shot, ok, dbAuth } from "./qa-lib.mjs";

const NAME = `ZZ-GP Gram Nails ${Date.now().toString(36).toUpperCase()}`;
const { browser, page } = await launch();

try {
  await login(page, "owner");
  await goto(page, "/master-inventory");

  await page.getByRole("button", { name: /add product/i }).click();
  await page.waitForTimeout(600);

  await page.getByLabel(/^name/i).first().fill(NAME);

  // Pick the Gram unit — the labels must switch to "per kilo".
  await page.getByLabel("Unit").click();
  await page.waitForTimeout(400);
  await page.getByRole("option", { name: /^Gram$/i }).click();
  await page.waitForTimeout(400);

  check(
    await page.getByText(/Cost ₱ per kilo/i).isVisible().catch(() => false),
    "cost label switches to 'per kilo' for a gram product"
  );
  check(
    await page.getByText(/Price ₱ per kilo/i).isVisible().catch(() => false),
    "price label switches to 'per kilo'"
  );

  // An off-grid price must be REFUSED, not silently rounded.
  await page.getByLabel(/Price ₱ per kilo/i).fill("145");
  await page.waitForTimeout(400);
  const offGrid = page.getByText(/can't be priced per gram/i).first();
  check(
    await offGrid.isVisible().catch(() => false),
    "₱145/kg is flagged as impossible per gram"
  );
  const hintText = await offGrid.innerText().catch(() => "");
  check(/140/.test(hintText) && /150/.test(hintText),
    `the hint offers both neighbours (${hintText.trim()})`);
  await shot(page, "gp1-off-grid");

  // On-grid: ₱100/kg cost, ₱150/kg price.
  await page.getByLabel(/Cost ₱ per kilo/i).fill("100");
  await page.getByLabel(/Price ₱ per kilo/i).fill("150");
  await page.waitForTimeout(500);
  check(
    await page.getByText(/=\s*₱?0\.10\s*per gram/i).isVisible().catch(() => false),
    "₱100/kg shows '= ₱0.10 per gram'"
  );
  check(
    await page.getByText(/=\s*₱?0\.15\s*per gram/i).isVisible().catch(() => false),
    "₱150/kg shows '= ₱0.15 per gram'"
  );

  await page.getByLabel(/opening qty/i).fill("4000");
  await shot(page, "gp1-on-grid");
  await page.getByRole("button", { name: /^add product$/i }).last().click();
  await page.waitForTimeout(3000);

  // The DATABASE is the point: it must hold per-GRAM centavos.
  const q = await dbAuth("owner");
  const rows = await q(`parts?select=id,unit,cost_centavos,price_centavos&name=eq.${encodeURIComponent(NAME)}`);
  const p = rows?.[0];
  check(!!p, "the product was created");

  if (p) {
    ok(`stored: unit=${p.unit} cost=${p.cost_centavos}c price=${p.price_centavos}c`);
    check(p.unit === "g", "unit is g");
    check(p.cost_centavos === 10, `cost stored as 10 centavos/gram (got ${p.cost_centavos})`);
    check(p.price_centavos === 15, `price stored as 15 centavos/gram (got ${p.price_centavos})`);

    // 4000 g at those prices is ₱400 / ₱600 — NOT ₱400,000 / ₱600,000.
    const lvl = await q(`stock_levels?select=qty&part_id=eq.${p.id}&shop_id=is.null`);
    const qty = Number(lvl?.[0]?.qty ?? 0);
    check(qty === 4000, `master holds 4000 g (got ${qty})`);
    check(qty * p.cost_centavos === 40000, `4000 g at cost = ₱400.00, not ₱400,000`);
    check(qty * p.price_centavos === 60000, `4000 g at selling = ₱600.00`);
  }
  // ── the EDIT dialog keeps a PER-GRAM price, with a kilo caption ──────────
  await goto(page, "/master-inventory");
  // usePersistedView remembers the last view per browser profile — force table.
  const tableBtn = page.getByRole("button", { name: "Table view" });
  if (await tableBtn.isVisible().catch(() => false)) await tableBtn.click();
  await page.getByPlaceholder(/search/i).first().fill(NAME);
  await page.waitForTimeout(1800);
  // the row menu is labelled "Actions for <product>" — target it by name
  await page.getByRole("button", { name: `Actions for ${NAME}` }).click();
  await page.getByRole("menuitem", { name: /^edit/i }).first().click();
  await page.waitForTimeout(900);

  check(await page.getByText(/Cost ₱ per gram/i).isVisible().catch(() => false),
    "edit dialog labels cost as PER GRAM (not per kilo)");
  const kiloCaption = page.getByText(/=\s*₱?100\.00\s*per kilo/i).first();
  check(await kiloCaption.isVisible().catch(() => false),
    "edit dialog shows the kilo equivalent of the stored 0.10");
  await shot(page, "gp1-edit-dialog");

} finally {
  await browser.close();
}
summary();
