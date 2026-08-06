// FQ16 — the guard must not break the ordinary sale. Records a real sale of an
// item that HAS headroom, end to end, and checks the stored line.
import { launch, session, goto, shot, check, step, summary, toast, dbAuth } from "./qa-lib.mjs";

const { browser } = await launch({ headless: true });
const q = await dbAuth("owner");

try {
  const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
  await goto(shop.page, "/shop/record-sale");
  await shop.page.waitForTimeout(2500);

  step("An item with headroom can still be sold");
  // pick the first row whose caption shows at least 1 left and nothing pending
  const target = await shop.page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) {
      const t = (b.innerText || "").replace(/\s+/g, " ").trim();
      const m = t.match(/^(.+?)\s+(\d+(?:\.\d)?)\s+\w+ left\s+₱/);
      if (m && Number(m[2]) >= 1 && !/awaiting Admin/.test(t)) {
        return { name: m[1].trim(), left: Number(m[2]) };
      }
    }
    return null;
  });
  check(!!target, "found a sellable item with headroom", JSON.stringify(target));
  if (!target) throw new Error("no sellable item");
  console.log(`  target: ${target.name} (${target.left} left)`);

  const before = await q(`sale_lines?select=id&order=created_at.desc&limit=1`);

  await shop.page.getByRole("button", { name: new RegExp(target.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first().click();
  await shop.page.waitForTimeout(900);

  const cartText = await shop.page.evaluate(() => document.body.innerText);
  check(/cart|total/i.test(cartText), "the item landed in the cart");
  await shot(shop.page, "fq16-01-cart");

  await shop.page.getByRole("button", { name: /record sale|save sale|complete/i }).last().click();
  const t = await toast(shop.page, { timeout: 25000 });
  console.log(`  toast: ${t}`);
  check(/recorded|saved|success/i.test(t), "the sale saved", t);

  await shop.page.waitForTimeout(1500);
  const after = await q(`sale_lines?select=id,qty,description&order=created_at.desc&limit=1`);
  check(after[0]?.id !== before[0]?.id, "a new sale line exists in the database",
    JSON.stringify(after[0]));
  console.log(`  stored: ${after[0]?.description} x ${after[0]?.qty}`);

  step("The picker's number drops after recording");
  await goto(shop.page, "/shop/record-sale");
  await shop.page.waitForTimeout(2500);
  const nowLeft = await shop.page.evaluate((name) => {
    for (const b of document.querySelectorAll("button")) {
      const t = (b.innerText || "").replace(/\s+/g, " ").trim();
      if (!t.startsWith(name)) continue;
      const m = t.match(/(\d+(?:\.\d)?)\s+\w+ left/);
      if (m) return { caption: t.slice(0, 90), left: Number(m[1]) };
    }
    return null;
  }, target.name);
  console.log(`  after: ${JSON.stringify(nowLeft)}`);
  check(
    nowLeft && nowLeft.left < target.left,
    `left went ${target.left} -> ${nowLeft?.left} without the owner approving anything`,
    JSON.stringify(nowLeft)
  );
  check(
    /awaiting Admin/.test(nowLeft?.caption ?? ""),
    "and it says the difference is awaiting Admin",
    nowLeft?.caption
  );
  await shot(shop.page, "fq16-02-after");

  console.log("CONSOLE ERRORS:", (shop.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ16 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
