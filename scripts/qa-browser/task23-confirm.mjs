// Airtight confirmation of the tap-then-scan defect.
// Empty cart -> tap product B's tile -> scan product C's barcode (C is NOT in
// the cart and was never touched). If C fails to appear and B's qty rises, the
// scan's Enter re-activated the parked tile button.
import { launch, login, goto, toast, clearToasts, dbAuth, shot, SHOP_LS_KEYS } from "./qa-lib.mjs";
import { scan, focusInfo } from "./scanner.mjs";

const PRICE = 'input[id^="part-price-"], input[id^="engine-price-"]';
const ids = (page) =>
  page.locator(PRICE).evaluateAll((els) => els.map((e) => e.id.replace(/^(part|engine)-price-/, "")));

const { browser, page } = await launch();
try {
  const qs = await dbAuth("shop");
  const stock = (await qs("shop_stock?select=part_id,name,barcode,qty&qty=gte.4&limit=60")).filter(
    (s) => s.barcode
  );
  const B = stock[1];
  const C = stock[2];
  console.log(`tap target  B = ${B.barcode}  ${B.name}`);
  console.log(`scan target C = ${C.barcode}  ${C.name}  (never touched)\n`);

  await login(page, "shop");
  await goto(page, "/shop/record-sale");
  // start from a genuinely empty cart
  await page.evaluate((keys) => keys.forEach((k) => localStorage.removeItem(k)), SHOP_LS_KEYS ?? []);
  await page.evaluate(() =>
    Object.keys(localStorage)
      .filter((k) => /cart|sale/i.test(k))
      .forEach((k) => localStorage.removeItem(k))
  );
  await goto(page, "/shop/record-sale");
  await page.waitForTimeout(1500);
  console.log(`cart at start: ${(await ids(page)).length} line(s)`);

  // 1. tap B's tile with the mouse
  await page.locator('input[placeholder*="No scanner"]').fill(B.name.slice(0, 14));
  await page.waitForTimeout(800);
  await page.locator("button", { hasText: B.name }).first().click();
  await page.waitForTimeout(400);
  console.log(`after tapping B: cart = ${(await ids(page)).length} line(s), toast "${await toast(page)}"`);
  await clearToasts(page);

  const f = await focusInfo(page);
  console.log(`focus is now on: ${f.tag} (${f.desc})`);

  const beforeIds = await ids(page);

  // 2. scan C — a product that has never been touched
  console.log(`\n>>> scanning ${C.barcode} (${C.name})`);
  await scan(page, C.barcode);
  const t = await toast(page);
  await page.waitForTimeout(600);
  const afterIds = await ids(page);

  console.log(`toast said : "${t}"`);
  console.log(`cart lines : ${beforeIds.length} -> ${afterIds.length}`);
  console.log(`C in cart? : ${afterIds.includes(C.part_id)}`);
  console.log(`B in cart? : ${afterIds.includes(B.part_id)}`);
  await shot(page, "task23-confirm-tap-then-scan");

  console.log(`\n${"=".repeat(64)}`);
  if (!afterIds.includes(C.part_id)) {
    console.log(`CONFIRMED DEFECT: scanned ${C.name} — it never entered the cart.`);
    console.log(`The app instead reported: "${t}"`);
    console.log(`The scan's Enter re-activated the tile button left focused by the mouse tap.`);
  } else {
    console.log(`NOT REPRODUCED: ${C.name} did enter the cart.`);
  }
} finally {
  await browser.close();
}
