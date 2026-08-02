// Void the stray APPROVED ZZ-QB office expenses left by crashed Task 15 runs.
// Only these count toward reports/P&L — the shop-recorded claims stay `recorded`
// and are P&L-neutral until approved, so they are left alone.
// Rows are found by their own description, never by index.
import { launch, login, goto, dbAuth, step, check, summary, toast, clearToasts } from "./qa-lib.mjs";

const { browser, page, errors } = await launch();
const q = await dbAuth("owner");

try {
  step("cleanup: void stray approved ZZ-QB office expenses");
  const strays = await q("expenses?select=id,description,amount&description=like.ZZ-QB expense*&status=eq.approved&deleted_at=is.null");
  console.log(`  ${strays.length} stray approved expense(s):`,
    strays.map((s) => `${s.description} (${s.amount})`).join(" | ") || "none");
  if (!strays.length) { check(true, "nothing to clean"); }

  await login(page, "owner");
  for (const s of strays) {
    await goto(page, "/expenses");
    await page.waitForTimeout(3000);
    await page.getByPlaceholder(/Search/).first().fill(s.description);
    await page.waitForTimeout(1800);
    const kebabs = page.getByRole("button", { name: "Expense actions", exact: true });
    if ((await kebabs.count()) !== 1) {
      check(false, `search narrowed to exactly one row for ${s.description}`,
        `${await kebabs.count()} rows`);
      continue;
    }
    await kebabs.click();
    await page.waitForTimeout(600);
    await page.getByRole("menuitem", { name: /Void/ }).click();
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Void", exact: true }).last().click();
    await toast(page);
    await page.waitForTimeout(2200);
    await clearToasts(page);
    const after = (await q(`expenses?select=deleted_at&id=eq.${s.id}`))[0];
    check(after.deleted_at !== null, `voided ${s.description}`, String(after.deleted_at));
  }
  const left = await q("expenses?select=id&description=like.ZZ-QB expense*&status=eq.approved&deleted_at=is.null");
  check(left.length === 0, "no approved ZZ-QB office expenses remain", `${left.length} left`);
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 5) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
