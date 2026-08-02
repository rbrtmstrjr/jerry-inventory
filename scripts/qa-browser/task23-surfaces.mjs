// The remaining scan-capable surfaces the audit flagged. Verifying each myself
// rather than trusting the reading. NON-DESTRUCTIVE — nothing is saved.
import { launch, login, goto, toast, clearToasts, dbAuth, shot } from "./qa-lib.mjs";
import { scan, focusInfo } from "./scanner.mjs";

const R = [];
const ok = (n, pass, detail = "") => {
  R.push({ n, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${n}${detail ? `  — ${detail}` : ""}`);
};
const sec = (t) => console.log(`\n=== ${t} ===`);

const { browser, page } = await launch();
try {
  const qs = await dbAuth("shop");
  const stock = (await qs("shop_stock?select=part_id,name,barcode,qty&qty=gte.4&limit=60")).filter(
    (s) => s.barcode
  );
  const [A, B] = stock;

  await login(page, "shop");
  await goto(page, "/shop/record-sale");
  await page.waitForTimeout(1500);

  // ------------------------------------------------------- browse/search box
  sec("Browse box — scan lands there by mistake");
  const search = page.locator('input[placeholder*="No scanner"]');
  await search.click();
  await scan(page, A.barcode);
  await page.waitForTimeout(600);
  const v1 = await search.inputValue();
  await scan(page, B.barcode);
  await page.waitForTimeout(800);
  const v2 = await search.inputValue();
  const concat = v2.length > v1.length && v2.includes(A.barcode) && v2.includes(B.barcode);
  ok("two scans into the browse box do not concatenate into an unmatchable string",
    !concat, `after scan1 "${v1}" -> after scan2 "${v2}"`);
  if (concat) {
    const body = await page.locator("body").innerText();
    console.log(`     page says: ${/Nothing in stock matches/i.test(body)
      ? '"Nothing in stock matches your search" — for items that ARE in stock'
      : "(no empty-state banner)"}`);
  }
  await search.fill("");
  await clearToasts(page);

  // --------------------------------------------------------------- suki field
  sec("Suki card field — a failed scan is retried");
  // focus the scan box explicitly: the cart must be non-empty for the suki field
  // to render, and focus was last left in the browse box
  await page.locator('input[placeholder*="Scan barcode"]').click();
  await scan(page, A.barcode);
  await toast(page);
  await clearToasts(page);
  const suki = page.locator('input[placeholder*="Suki"]');
  if (await suki.count()) {
    await suki.click();
    await scan(page, "BADCARD001");
    // wait for the lookup to actually answer, not a fixed guess
    const t1 = await toast(page, { timeout: 15000 });
    await page.waitForTimeout(400);
    const s1 = await suki.inputValue();
    await clearToasts(page);
    ok("after a rejected suki card the field clears for the retry",
      s1 === "", `field holds "${s1}" | toast "${t1 ?? "none"}"`);

    await scan(page, "BADCARD002");
    await toast(page, { timeout: 15000 });
    await page.waitForTimeout(400);
    const s2 = await suki.inputValue();
    ok("a second suki scan does not concatenate onto the first",
      !(s2.includes("BADCARD001") && s2.includes("BADCARD002")), `field holds "${s2}"`);
    await suki.fill("");
    await clearToasts(page);
    await shot(page, "task23-suki");
  } else {
    ok("suki field present with a non-empty cart", false, "field not found");
  }

  // ------------------------------------------ warranty card-number recording
  sec("Warranty card-no dialog — recording two cards in a row");
  await goto(page, "/shop/warranties");
  await page.waitForTimeout(1800);
  const trigger = page
    .getByRole("button", { name: /Record card no|card number/i })
    .first();
  if (await trigger.count()) {
    await trigger.click();
    await page.waitForTimeout(900);
    const f = await focusInfo(page);
    ok("the card-no dialog focuses its input so a card can be scanned straight in",
      f.usable, `activeElement = ${f.tag}: ${f.desc}`);
    // leave without saving
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
    const after = await focusInfo(page);
    console.log(`     after closing the dialog, focus = ${after.tag}: ${after.desc}`);
    ok("closing the dialog does not park focus on a button that a scan's Enter would re-fire",
      after.tag !== "BUTTON", `activeElement = ${after.tag}`);
    await shot(page, "task23-cardno");
  } else {
    console.log("     (no card-no trigger on screen — every warranty may already have a number)");
  }
} finally {
  await browser.close();
}

const passed = R.filter((r) => r.pass).length;
console.log(`\n${"=".repeat(60)}\nSURFACES: ${passed}/${R.length} passed`);
for (const r of R.filter((x) => !x.pass)) console.log(`  FAIL  ${r.n} — ${r.detail}`);
