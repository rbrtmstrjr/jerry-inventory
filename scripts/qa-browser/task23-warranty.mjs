// Does the shop warranty serial lookup survive two scans in a row?
// Claim under test: the box never self-clears, so scan #2 appends to scan #1,
// matches nothing, and the page tells the customer their engine was not sold here.
import { launch, login, goto, dbAuth, shot } from "./qa-lib.mjs";
import { scan, focusInfo } from "./scanner.mjs";

const { browser, page } = await launch();
try {
  const qs = await dbAuth("shop");
  const w = await qs("shop_warranties?select=serial_number&limit=2");
  if (!w.length) throw new Error("no warranties visible to this shop");
  const S1 = w[0].serial_number;
  const S2 = w[1]?.serial_number ?? w[0].serial_number;
  console.log(`serial 1 = ${S1}\nserial 2 = ${S2}\n`);

  await login(page, "shop");
  await goto(page, "/shop/warranties");
  await page.waitForTimeout(1500);

  const f = await focusInfo(page);
  console.log(`focus on load: ${f.tag} (${f.desc})`);

  const box = page.locator('input[placeholder*="erial"], input[placeholder*="can"]').first();
  await box.click();

  console.log(`\n>>> scan #1: ${S1}`);
  await scan(page, S1);
  await page.waitForTimeout(1200);
  console.log(`   box now reads: "${await box.inputValue()}"`);

  console.log(`\n>>> scan #2 (no clearing in between): ${S2}`);
  await scan(page, S2);
  await page.waitForTimeout(1200);
  const val = await box.inputValue();
  console.log(`   box now reads: "${val}"`);

  const body = await page.locator("body").innerText();
  const falseNegative = /wasn't sold by this shop|was not sold by this shop|contact Admin/i.test(body);
  await shot(page, "task23-warranty-double-scan");

  console.log(`\n${"=".repeat(64)}`);
  if (val !== S2) {
    console.log(`DEFECT: after two scans the box holds "${val}" — the codes concatenated.`);
    console.log(`Page shows the "not sold by this shop" banner: ${falseNegative}`);
    if (falseNegative)
      console.log(`=> the customer is wrongly told their engine wasn't sold here.`);
  } else {
    console.log(`OK: the box held only the second serial ("${val}").`);
  }
} finally {
  await browser.close();
}
