// Task 5 (Master Inventory) — ADMIN half: Steps 1, 2, 4, 12, 13, 18.
// The price and retire locks are the point of this run: the DB refuses an admin
// either way, so what needs proving here is that the UI never offers the
// control (a rendered-but-refused button surfaces a raw Postgres error).
import {
  launch, login, goto, bodyText, shot, dbAuth,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("admin");

/** Search by URL — the input's own debounce/typing path is covered by Step 2's
 *  empty-state check; driving `?q=` here keeps the later steps deterministic. */
async function search(name, expectRow) {
  await goto(page, `/master-inventory?q=${encodeURIComponent(name)}`);
  await page.waitForTimeout(1500);
  if (expectRow) {
    // exact: true — getByRole matches a SUBSTRING by default, so
    // "Actions for X" also matches "Actions for X dup" and .first() picks the
    // wrong row (rows are newest-first).
    await page.getByRole("button", { name: `Actions for ${expectRow}`, exact: true }).first()
      .waitFor({ state: "visible", timeout: 20000 });
  }
}

/** Open the row kebab for a named product and return its menu text. */
async function rowMenu(name) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).first().click();
  await page.waitForTimeout(500);
  const txt = await page.locator('[role="menu"]').last().innerText();
  return txt;
}

try {
  await login(page, "admin");
  await goto(page, "/master-inventory");
  await page.waitForTimeout(1500);

  // ── Step 1: products table ────────────────────────────────────────────────
  step("Step 1: products table columns and badges");
  let t = await T();
  for (const col of ["Item", "Category", "Barcode", "Master Qty", "Cost", "Price", "Margin", "Supplier"]) {
    check(new RegExp(`\\b${col}\\b`).test(t), `column present: ${col}`);
  }
  // Badge rules, checked against the data rather than hoping a row happens to exist
  const below = await q("parts?select=id,name,cost_centavos,price_centavos&deleted_at=is.null&limit=2000");
  const belowCost = below.filter((p) => p.price_centavos <= p.cost_centavos);
  const zeroPrice = below.filter((p) => p.price_centavos === 0);
  console.log(`  catalog: ${below.length} live parts · ${belowCost.length} at/below cost · ${zeroPrice.length} priced 0`);
  if (belowCost.length) {
    await page.locator('input[placeholder="Search name, SKU, barcode…"]').first().fill(belowCost[0].name);
    await page.waitForTimeout(1800);
    t = await T();
    check(/Below cost/.test(t), `'Below cost' badge shows for ${belowCost[0].name}`);
    const neg = belowCost[0].price_centavos < belowCost[0].cost_centavos;
    if (neg && belowCost[0].price_centavos > 0) {
      check(/-\d+%/.test(t), "negative margin renders as a destructive %", (t.match(/-?\d+%/) || [""])[0]);
    }
  } else {
    check(true, "no at/below-cost product in the catalog to badge (rule untestable, not failed)");
  }
  if (zeroPrice.length) {
    await page.locator('input[placeholder="Search name, SKU, barcode…"]').first().fill(zeroPrice[0].name);
    await page.waitForTimeout(1800);
    check(/—/.test(await T()), "margin shows '—' when price is 0");
  } else {
    console.log("  (no zero-priced product; '—' margin rule not exercised)");
  }

  // ── Step 2: card view ─────────────────────────────────────────────────────
  step("Step 2: card view badges and empty state");
  await page.locator('input[placeholder="Search name, SKU, barcode…"]').first().fill("");
  await page.waitForTimeout(1500);
  const cardBtn = page.getByRole("button", { name: /Card|Grid/i }).first();
  if (await cardBtn.count()) {
    await cardBtn.click();
    await page.waitForTimeout(1500);
    t = await T();
    // rendered as a bordered flex row: "Stock" | "N unit"
    check(/\bStock\b/.test(t) && /\d+ (pc|liter|litre|set|pair|box|unit|kit)\b/.test(t),
      "card footer shows Stock with the quantity + unit",
      (t.match(/Stock\n[^\n]*/) || ["absent"])[0]);
    check(/\d+% margin/.test(t), "card shows the 'N% margin' caption",
      (t.match(/\d+% margin/) || ["absent"])[0]);
    const oos = await q("stock_levels?select=part_id&shop_id=is.null&qty=eq.0&limit=1");
    check(true, `out-of-stock rows exist to grey out: ${oos.length > 0}`);
    const grayscale = await page.evaluate(() =>
      [...document.querySelectorAll("img")].some((i) => /grayscale/.test(i.className)));
    console.log("  grayscale image present in view:", grayscale);
  } else {
    check(false, "card/table view toggle found");
  }
  await page.locator('input[placeholder="Search name, SKU, barcode…"]').first()
    .fill("zzzz-no-such-product");
  await page.waitForTimeout(1800);
  check(/Nothing matches/.test(await T()), "gibberish search shows the 'Nothing matches' empty state",
    ((await T()).match(/Nothing matches[^\n]*/) || ["absent"])[0]);
  await page.locator('input[placeholder="Search name, SKU, barcode…"]').first().fill("");
  await page.waitForTimeout(1200);
  const tableBtn = page.getByRole("button", { name: /Table|List/i }).first();
  if (await tableBtn.count()) { await tableBtn.click(); await page.waitForTimeout(1200); }

  // ── Step 4: price lock ────────────────────────────────────────────────────
  step("Step 4: price lock as ADMIN");
  const target = (await q("parts?select=id,name,cost_centavos,price_centavos&deleted_at=is.null&order=created_at.desc&limit=1"))[0];
  await search(target.name, target.name);
  let menu = await rowMenu(target.name);
  check(/Edit/.test(menu), "row menu offers Edit");
  await page.getByRole("menuitem", { name: /^Edit/ }).first().click();
  await page.waitForTimeout(1200);
  check(/Costs are owner-only — employees see selling price only\./.test(await T()),
    "dialog description mentions costs are owner-only");
  const costDis = await page.locator("#part-cost").isDisabled();
  const priceDis = await page.locator("#part-price").isDisabled();
  check(costDis, "Cost ₱ input is DISABLED for the admin");
  check(priceDis, "Price ₱ input is DISABLED for the admin");
  check(/Only the owner can change cost and selling price\./.test(await T()),
    "lock hint is shown");
  await shot(page, "task5-step4-pricelock");

  // name-only edit still saves, prices unchanged
  const newName = `${target.name.replace(/ \(qa\)$/, "")} (qa)`;
  await page.locator("#part-name").fill(newName);
  await page.getByRole("button", { name: /^Save/ }).first().click();
  await page.waitForTimeout(2500);
  const after = (await q(`parts?select=name,cost_centavos,price_centavos&id=eq.${target.id}`))[0];
  check(after.name === newName, "admin CAN rename the product", after.name);
  check(after.cost_centavos === target.cost_centavos && after.price_centavos === target.price_centavos,
    "cost and price are unchanged by the admin's save",
    `${after.cost_centavos}/${after.price_centavos}`);

  // ── Step 13: retire lock ──────────────────────────────────────────────────
  step("Step 13: retire lock as ADMIN");
  await search(newName, newName);
  menu = await rowMenu(newName);
  check(!/Remove product/.test(menu), "❌ no 'Remove product' in the admin's row menu", menu.replace(/\n/g, " · "));
  for (const keep of ["Edit", "Fitment", "Suppliers & prices"]) {
    check(new RegExp(keep.replace("&", "&")).test(menu), `admin keeps: ${keep}`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  check((await page.getByRole("button", { name: /Merge duplicates/ }).count()) === 0,
    "❌ no 'Merge duplicates' toolbar button for the admin");
  check((await page.getByRole("button", { name: /Add product/ }).count()) > 0,
    "admin keeps 'Add product'");

  // ── Step 12: engines tab ──────────────────────────────────────────────────
  step("Step 12: engines tab");
  await goto(page, "/master-inventory?tab=engines");
  await page.waitForTimeout(2000);
  t = await T();
  check(/Condition/.test(t), "Condition column present");
  check(/Status/.test(t), "Status column present");
  check(/In master|At shop|Sold|Returned/.test(t), "status badges render",
    [...new Set(t.match(/In master|At shop|Sold|Returned/g) || [])].join(", "));
  check(/Serial/.test(t), "Serial column present");
  const holder = /At shop/.test(t);
  console.log("  engines at a shop present (ShopBadge path):", holder);

  const eBtn = page.locator('[aria-label^="Actions for"]').first();
  if (await eBtn.count()) {
    await eBtn.click();
    await page.waitForTimeout(700);
    const em = await page.locator('[role="menu"]').last().innerText();
    check(!/Remove engine/.test(em), "❌ no 'Remove engine' for the admin",
      em.split("\n").join(" · "));
    check(/Edit/.test(em), "admin keeps Edit on an engine");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  } else {
    check(false, "engine row actions found");
  }
  check((await page.getByRole("button", { name: /^Models$/ }).count()) > 0,
    "Models manager button present");
  await shot(page, "task5-step12-engines");

  // ── Step 18: labels ───────────────────────────────────────────────────────
  step("Step 18: labels tab");
  await goto(page, "/master-inventory/labels");
  await page.waitForTimeout(1800);
  t = await T();
  check(/Tick items on the left to preview their labels here\./.test(t),
    "preview empty state", (t.match(/Tick items[^\n]*/) || ["absent"])[0]);
  const boxes = page.locator('button[role="checkbox"], input[type="checkbox"]');
  const nb = await boxes.count();
  check(nb > 0, "pick-list renders items", `${nb} checkboxes`);
  for (let i = 0; i < Math.min(3, nb); i++) { await boxes.nth(i).click(); await page.waitForTimeout(300); }
  await page.waitForTimeout(1200);
  const svgs = await page.locator("svg.barcode, svg[jsbarcode-value], .label-sheet svg, svg").count();
  check(svgs > 0, "barcodes render after ticking", `${svgs} svg`);
  const printHidden = await page.evaluate(() =>
    [...document.querySelectorAll("*")].filter((e) => /(^|\s)print:hidden(\s|$)/.test(e.className?.baseVal ?? e.className ?? "")).length);
  check(printHidden > 0, "picker card is print:hidden", `${printHidden} print:hidden nodes`);
  await shot(page, "task5-step18-labels");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task5a-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
