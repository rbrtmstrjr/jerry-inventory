// FQ9 — pin down the two FQ8 failures: is each a real bug or my test's fault?
import { launch, session, goto, shot, check, step, summary, dbAuth } from "./qa-lib.mjs";

const NAILS_NAME = process.argv[2];
const { browser } = await launch({ headless: true });
const q = await dbAuth("owner");

try {
  // ── 1. What exactly is the "2.0" on the Approval Queue? ──────────────────
  step("Is the Approval Queue's '2.0' a quantity or something else?");
  const owner = await session(browser, "owner");
  await goto(owner.page, "/approvals?tab=sales");
  await owner.page.waitForTimeout(2500);
  const ctx = await owner.page.evaluate(() => {
    const out = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walk.nextNode())) {
      const t = n.nodeValue || "";
      if (/\b\d+\.0\b/.test(t)) {
        const el = n.parentElement;
        out.push({
          text: t.trim().slice(0, 60),
          parent: (el?.innerText || "").trim().replace(/\s+/g, " ").slice(0, 110),
          cls: (el?.className || "").toString().slice(0, 60),
        });
      }
    }
    return out.slice(0, 8);
  });
  console.log("  occurrences of N.0:", JSON.stringify(ctx, null, 1));
  const looksLikeQty = ctx.some((c) => /×|x \d|qty|kg|pc\b/i.test(c.parent));
  check(!looksLikeQty, "the N.0 is NOT a rendered quantity", JSON.stringify(ctx[0] ?? {}));
  await shot(owner.page, "fq9-01-approvals-n0");

  // ── 2. Return qty: clamp-to-available, or the dot being eaten? ───────────
  step("Return qty box — pick a line with plenty on hand, then type 2.5");
  const shop = await session(browser, "shop", { clearLocalStorage: true });
  await goto(shop.page, "/shop/transfers");
  await shop.page.waitForTimeout(1800);
  await shop.page.getByRole("tab", { name: /return to admin/i }).first().click();
  await shop.page.waitForTimeout(1500);

  const combo = shop.page.locator('button[role="combobox"]').first();
  await combo.click();
  await shop.page.waitForTimeout(700);
  // our kg fixture has 10.1 on hand at this shop — plenty of headroom
  const search = shop.page.getByPlaceholder(/search/i).last();
  if (await search.count()) { await search.fill(NAILS_NAME); await shop.page.waitForTimeout(700); }
  const opt = shop.page.getByRole("option", { name: new RegExp(NAILS_NAME, "i") }).first();
  const gotOpt = await opt.count();
  check(gotOpt > 0, "the kg fixture is offered as returnable", `${gotOpt}`);
  if (gotOpt) {
    await opt.click();
    await shop.page.waitForTimeout(700);
    const add = shop.page.getByRole("button", { name: /^add$/i }).first();
    if (await add.count()) { await add.click(); await shop.page.waitForTimeout(1000); }

    const boxes = shop.page.locator('input[inputmode="decimal"]');
    console.log(`  ${await boxes.count()} decimal boxes`);
    const el = boxes.first();
    await el.fill("");
    await el.type("2.5", { delay: 70 });
    const got = await el.inputValue();
    check(got === "2.5", `return good qty holds 2.5 (10.1 on hand, so no clamp)`, got);

    // and prove the clamp still bites above what is on hand
    await el.fill("");
    await el.type("99", { delay: 60 });
    const clamped = await el.inputValue();
    check(
      Number(clamped) <= 10.1 && Number(clamped) > 0,
      `typing 99 clamps to what is on hand, not junk`,
      clamped
    );
    await shot(shop.page, "fq9-02-return-qty");
  }

  console.log("CONSOLE ERRORS:", [...(owner.errors ?? []), ...(shop.errors ?? [])].slice(0, 5));
} catch (e) {
  console.error("\nFQ9 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
