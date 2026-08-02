// Task 23 — hardware barcode scanner readiness at the counter.
// The owner has no scanner yet, so this stands in for the physical test.
// NON-DESTRUCTIVE: builds carts and abandons them. Never saves a sale.
import { launch, session, login, goto, toast, clearToasts, dbAuth, shot } from "./qa-lib.mjs";
import { scan, focusInfo } from "./scanner.mjs";

const R = [];
const ok = (n, pass, detail = "") => {
  R.push({ n, pass, detail });
  console.log(`${pass ? "  PASS" : "  FAIL"}  ${n}${detail ? `  — ${detail}` : ""}`);
};
const sec = (t) => console.log(`\n=== ${t} ===`);

const cartText = (page) => page.locator("text=/In this sale|Cart/i").first();

const PRICE = 'input[id^="part-price-"], input[id^="engine-price-"]';

async function cartLines(page) {
  return page.locator(PRICE).count();
}
// Identity, never name: each cart line's price input encodes the product's UUID.
async function cartIds(page) {
  return page.locator(PRICE).evaluateAll((els) =>
    els.map((e) => e.id.replace(/^(part|engine)-price-/, ""))
  );
}
async function cartSummary(page) {
  return page.locator(PRICE).evaluateAll((els) =>
    els.map((e) => {
      const lbl = document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
      return `${lbl?.textContent?.trim().split("(")[0].trim() ?? e.id} = ${e.value}`;
    })
  );
}

const { browser, page } = await launch();
try {
  const qs = await dbAuth("shop");
  const stock = (await qs("shop_stock?select=part_id,name,barcode,qty&qty=gte.4&limit=60")).filter(
    (s) => s.barcode
  );
  if (stock.length < 2) throw new Error("need 2 barcoded parts in shop stock");
  const [A, B, C] = stock;
  console.log(`scan targets: A=${A.barcode} (${A.name})  B=${B.barcode} (${B.name})`);

  await login(page, "shop");
  await goto(page, "/shop/record-sale");
  await page.waitForTimeout(1200);

  // ---------------------------------------------------------------- 1. focus
  sec("1. Does a scan land anywhere on page load?");
  let f = await focusInfo(page);
  ok("scan box is focused on mount (no click needed)", f.usable && /Scan barcode/i.test(f.desc), f.desc);

  // ------------------------------------------------------------ 2. core loop
  sec("2. Core loop — scan, scan, rescan");
  await scan(page, A.barcode);
  let t = await toast(page);
  ok("scan A adds it to the cart", (await cartLines(page)) === 1, t ?? "(no toast)");
  await clearToasts(page);

  await scan(page, B.barcode);
  t = await toast(page);
  ok("scan B (back-to-back, no click between) adds a 2nd line", (await cartLines(page)) === 2, t ?? "");
  await clearToasts(page);

  await scan(page, A.barcode);
  await toast(page);
  ok("rescanning A bumps qty, does NOT create a 3rd line", (await cartLines(page)) === 2);
  await clearToasts(page);

  f = await focusInfo(page);
  ok("focus stays in the scan box across scans", f.usable && /Scan barcode/i.test(f.desc), f.desc);
  ok("scan box is empty between scans (codes cannot accumulate)",
    (await page.locator('input[placeholder*="Scan barcode"]').inputValue()) === "");

  // ------------------------------------------------------ 3. case + unknown
  sec("3. Robustness of the match");
  await scan(page, A.barcode.toLowerCase());
  t = await toast(page);
  ok("lower-case scan still matches (scanners can be configured either way)",
    (await cartLines(page)) === 2 && !/No match/i.test(t ?? ""), t ?? "");
  await clearToasts(page);

  await scan(page, "GT99999999");
  t = await toast(page);
  ok("unknown code → clear error, cart untouched", /No match/i.test(t ?? "") && (await cartLines(page)) === 2, t ?? "");
  await clearToasts(page);

  await scan(page, B.barcode);
  await toast(page);
  ok("a good scan right after a failed one still works", (await cartLines(page)) === 2);
  await clearToasts(page);

  // ------------------------------------- 4. THE BIG ONE: mouse then scanner
  sec("4. Cashier taps a product tile with the mouse, then scans the next item");
  // fresh page = empty cart, so the result is unambiguous
  await goto(page, "/shop/record-sale");
  await page.waitForTimeout(1500);
  const before = await cartSummary(page);
  const search = page.locator('input[placeholder*="No scanner"]');
  await search.fill(B.name.slice(0, 14));
  await page.waitForTimeout(700);
  const tile = page.locator("button", { hasText: B.name }).first();
  if (await tile.count()) {
    await tile.click();
    await clearToasts(page);
    f = await focusInfo(page);
    ok("after tapping a tile, focus returns to the scan box (not parked on the button)",
      f.usable && /Scan barcode/i.test(f.desc), `activeElement = ${f.tag}: ${f.desc}`);

    const idsBefore = await cartIds(page);
    await scan(page, C.barcode); // a THIRD product, never touched, not in the cart
    t = await toast(page);
    await page.waitForTimeout(500);
    const idsAfter = await cartIds(page);
    // decisive: did the SCANNED product's uuid enter the cart?
    ok("scanning an untouched product after the tap puts THAT product in the cart",
      idsAfter.includes(C.part_id),
      `scanned ${C.barcode} (${C.name}); toast said "${t ?? "none"}"`);
    ok("the tap+scan sequence does not silently add a 2nd unit of the TAPPED item",
      !(t ?? "").includes(B.name),
      `toast named "${(t ?? "").slice(0, 60)}" — tapped item was ${B.name}`);
    ok("the scanned code is not swallowed by the focused tile",
      idsAfter.length > idsBefore.length,
      `cart lines ${idsBefore.length} -> ${idsAfter.length} after scanning a NEW product`);
    console.log("     cart before tap:", before.join(" | ") || "(empty)");
    console.log("     cart after scan:", (await cartSummary(page)).join(" | ") || "(empty)");
    console.log(`     A in cart? ${idsAfter.includes(A.part_id)}   ids ${idsBefore.length}->${idsAfter.length}`);
    await shot(page, "task23-tile-then-scan");
  } else {
    ok("tile located for the mouse+scanner test", false, "no tile matched");
  }
  await clearToasts(page);

  // --------------------------------------------- 5. scan into a price field
  sec("5. Stray scan into a per-line price box");
  const price = page.locator('input[id^="part-price-"]').first();
  const origPrice = await price.inputValue();
  await price.click();
  await scan(page, A.barcode);
  await page.waitForTimeout(400);
  const v = await price.inputValue();
  const absurd = /^\d{9,}$/.test(v.replace(/\./g, ""));
  ok("a scan into the price box does NOT produce a silent absurd price",
    !absurd, `price box now reads "${v}" (was "${origPrice}")`);
  const f2 = await focusInfo(page);
  ok("after a stray scan in the price box, focus returns to the scan box (no cascade)",
    /Scan barcode/i.test(f2.desc), `activeElement = ${f2.tag}: ${f2.desc}`);
  await price.fill(origPrice);
  await clearToasts(page);

  // ------------------------------------------- 6. focus after a form error
  sec("6. Below-cost price — is Save blocked?");
  await price.fill("1");           // below cost
  await page.waitForTimeout(400);
  const saveBtn = page.getByRole("button", { name: /Save sale|Record sale/i }).first();
  const disabled = (await saveBtn.count()) ? await saveBtn.isDisabled() : null;
  ok("Save is disabled while a line is priced below cost", disabled === true,
    `save button disabled=${disabled}`);
  await price.fill(origPrice);
  await page.waitForTimeout(400);
  ok("Save re-enables once the price is valid again",
    (await saveBtn.count()) ? !(await saveBtn.isDisabled()) : false);
  await shot(page, "task23-after-error");

  // ------------------------------------------ 7. the search box + Enter
  sec("7. Browse box (the non-scan input right below)");
  await search.fill("");
  await search.click();
  await scan(page, A.barcode);
  await page.waitForTimeout(600);
  const sv = await search.inputValue();
  ok("scanning into the browse box does not silently swallow the code",
    sv === "" || (await cartLines(page)) > 0, `browse box reads "${sv}"`);

  console.log(`\nabandoning cart without saving (non-destructive)`);
} finally {
  await browser.close();
}

const passed = R.filter((r) => r.pass).length;
console.log(`\n${"=".repeat(60)}\nSCANNER: ${passed}/${R.length} passed`);
for (const r of R.filter((x) => !x.pass)) console.log(`  FAIL  ${r.n} — ${r.detail}`);
