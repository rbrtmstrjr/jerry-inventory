/**
 * QA: a Receiving part line shows the product's MASTER on-hand quantity.
 *
 * Admin had to open Master Inventory in another tab to see what was already
 * there. Master only — shop stock is deliberately not counted.
 *
 * Run: node scripts/qa-browser/rs1-receiving-stock.mjs   (needs npm run dev)
 */
import { launch, login, goto, check, summary, shot, ok, dbAuth } from "./qa-lib.mjs";

const { browser, page } = await launch();

try {
  await login(page, "owner");
  await goto(page, "/suppliers?tab=receiving");

  // The form starts closed — showForm defaults to false.
  const openForm = page.getByRole("button", { name: /new receiving/i });
  if (await openForm.isVisible().catch(() => false)) await openForm.click();
  await page.waitForTimeout(500);

  const addPart = page.getByRole("button", { name: /add part/i });
  check(await addPart.isVisible().catch(() => false), "Receiving form opened (Add part visible)");
  await addPart.click();

  // The line's item picker reads "Pick item…" — the supplier's says
  // "Pick the supplier…", so match on the item wording specifically.
  const picker = page.getByRole("combobox").filter({ hasText: /pick item/i }).first();
  check(await picker.isVisible().catch(() => false), "the line's item picker is present");
  await picker.click();
  await page.waitForTimeout(600);

  // Type to filter — the list's FIRST entry is "New product…", which is the
  // create-inline path and deliberately has no stock to show.
  await page.getByPlaceholder(/search/i).last().fill("Anode");
  await page.waitForTimeout(700);

  const option = page
    .locator("[role='option']")
    .filter({ hasNotText: /new product/i })
    .first();
  check(await option.isVisible().catch(() => false), "an existing product is offered");
  const chosen = (await option.innerText()).trim().split("\n")[0].trim();
  await option.click();
  await page.waitForTimeout(900);
  ok(`picked "${chosen}"`);

  // The per-line caption must now carry the master figure.
  const caption = page.getByText(/In master:/i).first();
  const shown = await caption.isVisible().catch(() => false);
  check(shown, "the line shows an 'In master:' figure");
  await shot(page, "rs1-receiving-line");

  if (!shown) throw new Error("no 'In master:' caption — nothing else is meaningful");

  const text = (await caption.innerText()).trim();
  ok(`caption reads: ${text}`);

  // It must match the DATABASE, and must be MASTER only (shop stock excluded).
  const q = await dbAuth("owner");
  const rows = await q(`parts?select=id,unit&name=eq.${encodeURIComponent(chosen)}`);
  const part = rows?.[0];
  check(!!part, `found "${chosen}" in the database`);

  if (part) {
    const master = await q(`stock_levels?select=qty&part_id=eq.${part.id}&shop_id=is.null`);
    const shops = await q(`stock_levels?select=qty&part_id=eq.${part.id}&shop_id=not.is.null`);
    const masterQty = Number(master?.[0]?.qty ?? 0);
    const shopQty = (shops ?? []).reduce((s, r) => s + Number(r.qty), 0);

    const num = (text.match(/In master:\s*([\d.]+)/i) ?? [])[1];
    check(num !== undefined, "the caption contains a number");
    check(
      Number(num) === masterQty,
      `caption ${num} equals MASTER ${masterQty} in the DB`
    );
    // the real point of the feature: shop stock must not be folded in
    if (shopQty > 0) {
      check(
        Number(num) !== masterQty + shopQty,
        `shop stock (${shopQty}) is NOT included — would have shown ${masterQty + shopQty}`
      );
    } else {
      ok(`(this product has no shop stock, so the exclusion is untested here)`);
    }
    check((text.match(/\b/) && text.includes(part.unit)) === true, `caption names the unit "${part.unit}"`);
  }
} finally {
  await browser.close();
}
summary();
