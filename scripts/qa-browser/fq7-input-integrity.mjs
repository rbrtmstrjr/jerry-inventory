// FQ7 — input integrity across every quantity box I changed. NON-MUTATING:
// it types, reads the box back, and never submits. This is the regression test
// for the two bug classes found in this run:
//
//   A  .replace(/\D/g,"")            stripped the "." -> 10.1 became 101
//   B  String(parseQtyInput(raw))    erased the "." mid-keystroke -> 10.5 unreachable
//
// A box passes only if typing "2.5" leaves "2.5" in it, and inputMode is
// "decimal" (a tablet keypad with no "." makes a correct handler unreachable).
import { launch, session, goto, shot, check, step, summary } from "./qa-lib.mjs";

const { browser } = await launch({ headless: true });

/** Type into a box and report exactly what it holds afterwards. */
async function probe(page, locator, label, want = "2.5") {
  const el = typeof locator === "string" ? page.locator(locator).first() : locator;
  if (!(await el.count())) return check(false, `${label} — box not found`);
  const im = await el.getAttribute("inputmode");
  await el.fill("");
  await el.type(want, { delay: 70 });
  const got = await el.inputValue();
  check(got === want, `${label}: typed ${want} -> "${got}" (inputMode=${im})`, got);
  check(im === "decimal", `${label}: inputMode is decimal`, String(im));
  return got === want;
}

try {
  // ── OWNER boxes ──────────────────────────────────────────────────────────
  const owner = await session(browser, "owner");

  step("BUG B — New Delivery qty (owner)");
  await goto(owner.page, "/deliveries?tab=delivery");
  await owner.page.locator('button[role="combobox"]').filter({ hasText: /pick a shop/i }).first().click();
  await owner.page.waitForTimeout(400);
  await owner.page.getByRole("option", { name: /Ternate/i }).first().click();
  await owner.page.waitForTimeout(900);
  await owner.page.getByRole("button", { name: /add (part|line|item)/i }).first().click();
  await owner.page.waitForTimeout(700);
  await probe(owner.page, owner.page.getByLabel(/^quantity$/i).last(), "New Delivery qty");
  await shot(owner.page, "fq7-01-new-delivery-qty");

  step("BUG A — transit discrepancy resolve qty (owner)");
  await goto(owner.page, "/deliveries?tab=transit");
  await owner.page.waitForTimeout(1500);
  const res = owner.page.getByRole("button", { name: /resolve/i }).first();
  if (await res.count()) {
    await res.click();
    await owner.page.waitForTimeout(1000);
    await probe(owner.page, "#res-qty", "Resolve qty");
    await owner.page.keyboard.press("Escape");
    await owner.page.waitForTimeout(500);
  } else check(false, "no discrepancy row to open");

  step("BUG A — transfers/returns resolve qty (owner)");
  await goto(owner.page, "/deliveries?tab=transfers");
  await owner.page.waitForTimeout(1500);
  const tRes = owner.page.getByRole("button", { name: /resolve/i }).first();
  if (await tRes.count()) {
    await tRes.click();
    await owner.page.waitForTimeout(1000);
    const box = owner.page.locator('[role="dialog"] input[inputmode="decimal"]').first();
    await probe(owner.page, box, "Transfer resolve qty");
    await owner.page.keyboard.press("Escape");
  } else check(true, "no transfer discrepancy pending (nothing to probe) — skipped");

  // ── SHOP boxes ───────────────────────────────────────────────────────────
  const shop = await session(browser, "shop", { clearLocalStorage: true });

  step("BUG A — arrival confirm Good + Damaged (shop)");
  await goto(shop.page, "/shop/deliveries");
  await shop.page.waitForTimeout(1800);
  const good = shop.page.locator('input[id^="good-"]').first();
  const dmg = shop.page.locator('input[id^="dmg-"]').first();
  if (await good.count()) {
    await probe(shop.page, good, "Confirm Good qty");
    await probe(shop.page, dmg, "Confirm Damaged qty");
    await shot(shop.page, "fq7-02-confirm-boxes");
  } else check(false, "no incoming delivery to probe");

  step("BUG A — low-stock request row qty (shop)");
  await goto(shop.page, "/shop/low-stock");
  await shop.page.waitForTimeout(2000);
  await probe(shop.page, shop.page.locator('input[id^="qty-part:"]').first(), "Low-stock row qty");

  step("BUG B — send-stock transfer qty (shop)");
  await goto(shop.page, "/shop/transfers");
  await shop.page.waitForTimeout(1800);
  const txq = shop.page.locator("#tx-qty");
  if (await txq.count()) {
    // needs an item picked before the clamp path is live
    const pick = shop.page.locator('button[role="combobox"]').first();
    if (await pick.count()) {
      await pick.click();
      await shop.page.waitForTimeout(600);
      const opt = shop.page.getByRole("option").first();
      if (await opt.count()) { await opt.click(); await shop.page.waitForTimeout(700); }
    }
    await probe(shop.page, "#tx-qty", "Transfer send qty");
    await shot(shop.page, "fq7-03-transfer-qty");
  } else check(false, "transfer qty box not found");

  step("BUG B — return-to-admin good/damaged (shop)");
  const retTab = shop.page.getByRole("tab", { name: /return/i }).first();
  if (await retTab.count()) {
    await retTab.click();
    await shop.page.waitForTimeout(1500);
    const boxes = shop.page.locator('input[inputmode="decimal"]');
    const cnt = await boxes.count();
    if (cnt > 0) {
      await probe(shop.page, boxes.first(), "Return good qty");
      await shot(shop.page, "fq7-04-return-qty");
    } else check(false, "no return qty box (pick an item first)");
  } else check(false, "return tab not found");

  console.log("CONSOLE ERRORS:", [...(owner.errors ?? []), ...(shop.errors ?? [])].slice(0, 6));
} catch (e) {
  console.error("\nFQ7 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
