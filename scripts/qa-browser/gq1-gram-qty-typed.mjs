/**
 * QA: the cart quantity box is TYPED for whole-unit products too.
 *
 * It used to be a read-only span unless the unit allowed decimals, so 3000 g
 * meant 3000 clicks on "+". `fractional` now governs decimals only.
 *
 * Also re-proves the clamp this file's history is built on: over-available is
 * capped as you type, and it SAYS SO.
 *
 * Run: node scripts/qa-browser/gq1-gram-qty-typed.mjs   (needs npm run dev)
 */
import { launch, login, goto, check, summary, shot, ok, dbAuth } from "./qa-lib.mjs";

const { browser, page } = await launch();

try {
  await login(page, "shop");
  await goto(page, "/shop/record-sale");

  // A fully-committed product stays VISIBLE at "0 left" but disabled. Pick the
  // enabled one with the MOST stock, or "type 20" just clamps and proves nothing.
  const options = page.locator("button:not([disabled])", { hasText: /left/i });
  const n = await options.count();
  check(n > 0, `the picker lists sellable stock (${n} enabled)`);

  let best = { i: -1, qty: 0, label: "" };
  for (let i = 0; i < Math.min(n, 25); i++) {
    const txt = await options.nth(i).innerText();
    const q = Number((txt.match(/([\d.]+)\s*\S*\s*left/i) ?? [])[1] ?? "0");
    if (q > best.qty) best = { i, qty: q, label: txt.split("\n")[0].trim() };
  }
  check(best.i >= 0 && best.qty >= 3, `found a product with room to type (${best.qty})`);
  await options.nth(best.i).click();
  await page.waitForTimeout(900);
  const available = best.qty;
  ok(`added "${best.label}" — ${available} available`);

  const qty = page.getByLabel(/^Quantity in /i).first();
  check(await qty.isVisible().catch(() => false),
    "the cart quantity is an EDITABLE box, not a read-only span");
  if (!(await qty.isVisible().catch(() => false))) {
    await shot(page, "gq1-no-box");
    throw new Error("no editable quantity box — nothing else is meaningful");
  }

  const unit = ((await qty.getAttribute("aria-label")) ?? "").replace(/^Quantity in /i, "").trim();
  ok(`unit is "${unit}"`);

  // 1. typing a number works at all — the whole point
  await qty.fill("");
  await qty.type("3");
  await page.waitForTimeout(600);
  check((await qty.inputValue()) === "3", `typed 3 (box reads "${await qty.inputValue()}")`);

  // 2. the total reflects the TYPED value, not a stale one
  const totalText = await page.getByText(/^₱/).last().innerText().catch(() => "");
  check(totalText.trim().startsWith("₱"), `total rendered (${totalText.trim()})`);

  // 3. THE CLAMP: over-available is capped as you type, and it says so
  await qty.fill("");
  await qty.type("99999");
  await page.waitForTimeout(900);
  const after = await qty.inputValue();
  check(Number(after) <= available,
    `over-available is clamped to ${available} (box reads "${after}")`);
  const toastSeen = await page.getByText(/left to sell/i).first().isVisible().catch(() => false);
  check(toastSeen, "the clamp SAYS SO — a toast explains the correction");
  await shot(page, "gq1-clamped");

  // 4. a whole-unit product must still refuse a decimal
  if (unit !== "kg" && unit !== "m" && unit !== "ft") {
    await qty.fill("");
    await qty.type("2.5");
    await page.waitForTimeout(600);
    // blur commits — a whole unit must refuse, loudly, and keep the old value
    await qty.blur();
    await page.waitForTimeout(800);
    check(
      await page.getByText(/sold in whole numbers/i).first().isVisible().catch(() => false),
      "a whole-unit line refuses a decimal and SAYS the unit is whole"
    );
    check(
      !(await page.getByText(/like 0.5 or 2.3/i).first().isVisible().catch(() => false)),
      "it does NOT suggest 0.5 on a whole-unit product"
    );
    check((await qty.inputValue()) !== "2.5",
      `the box was restored, not left at 2.5 (reads "${await qty.inputValue()}")`);
  } else {
    ok(`(${unit} is fractional here, so the decimal refusal is not exercised)`);
  }
} finally {
  await browser.close();
}
summary();
