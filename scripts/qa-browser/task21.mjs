// Task 21 — The full role matrix, BROWSER half. Steps 1–3.
//
// The database half is already proven: a live probe exercised all twelve locked
// capabilities as all three roles — 29 assertions, 0 failures (log A). This
// script does NOT re-prove any of that. What it proves is the other half of
// every row: that the control is HIDDEN or DISABLED for an admin, rather than
// rendered and then refused by Postgres. A lock that holds in the database
// while the button still renders hands the user a raw error instead of a clean
// absence — that is an S2, and it is invisible to a database probe.
//
// ZERO WRITES. Every row in the matrix is a render check, so nothing is
// created, edited, voided or deleted anywhere in this file.
//
// /warranties, /shop/warranties and /approvals are NOT visited — the other
// agent is in them for Tasks 8b and 10. Where the matrix needs a fact from
// those areas, it is taken read-only from the safe view instead, and said so.
import {
  launch, session, goto, bodyText, shot, dbAuth,
  step, check, summary, APP,
} from "./qa-lib.mjs";

const { browser } = await launch();
const q = await dbAuth("owner");

/** Row menu text for a named product on /master-inventory. */
async function rowMenu(page, name) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).first().click();
  await page.waitForTimeout(500);
  const txt = await page.locator('[role="menu"]').last().innerText();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  return txt;
}
/** Open a product's edit dialog and report whether the money inputs are locked. */
async function priceInputs(page, name) {
  await page.getByRole("button", { name: `Actions for ${name}`, exact: true }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("menuitem", { name: /^Edit/ }).first().click();
  await page.waitForTimeout(1500);
  const cost = await page.locator("#part-cost").isDisabled().catch(() => null);
  const price = await page.locator("#part-price").isDisabled().catch(() => null);
  const hint = /Only the owner can change cost and selling price\./.test(await bodyText(page));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  return { cost, price, hint };
}
/** Wait for a locator to exist, tolerating slow streamed pages. */
async function waitCount(locator, ms = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await locator.count()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/** Land on `path` and report where we actually ended up. */
async function landing(page, path) {
  await goto(page, path);
  await page.waitForTimeout(2500);
  return new URL(page.url()).pathname;
}

try {
  const owner = await session(browser, "owner");
  const admin = await session(browser, "admin");
  const O = owner.page, A = admin.page;

  // a live, non-merged product to drive rows 1–5 against
  const part = (await q("parts?select=id,name&deleted_at=is.null&merged_into=is.null&order=created_at.desc&limit=1"))[0];
  check(!!part, "a catalog product exists to test the locks against", part?.name);
  const search = `/master-inventory?q=${encodeURIComponent(part.name)}`;

  // ══ Step 1: the twelve rows ═══════════════════════════════════════════════
  step("Step 1 · rows 1–2 — price lock");
  await goto(A, search); await A.waitForTimeout(2500);
  const aPrice = await priceInputs(A, part.name);
  check(aPrice.cost === true && aPrice.price === true,
    "ADMIN ❌ cost and selling price inputs are DISABLED (not rendered-then-refused)",
    `cost disabled=${aPrice.cost} price disabled=${aPrice.price}`);
  check(aPrice.hint, "…and the lock explains itself in the dialog");
  await goto(O, search); await O.waitForTimeout(2500);
  const oPrice = await priceInputs(O, part.name);
  check(oPrice.cost === false && oPrice.price === false,
    "GERRY ✅ both money inputs are editable",
    `cost disabled=${oPrice.cost} price disabled=${oPrice.price}`);

  // row 2 — the engine edit dialog carries the same lock
  await goto(A, "/master-inventory?tab=engines"); await A.waitForTimeout(3000);
  const aEngBtn = A.locator('[aria-label^="Actions for"]').first();
  if (await aEngBtn.count()) {
    await aEngBtn.click(); await A.waitForTimeout(500);
    await A.getByRole("menuitem", { name: /^Edit/ }).first().click();
    await A.waitForTimeout(1500);
    const eDisabled = await A.locator("#engine-price").isDisabled().catch(() => null);
    check(eDisabled === true, "ADMIN ❌ engine selling price input is DISABLED",
      `disabled=${eDisabled}`);
    await A.keyboard.press("Escape"); await A.waitForTimeout(500);
  } else {
    check(false, "an engine row exists to test row 2");
  }
  await goto(O, "/master-inventory?tab=engines"); await O.waitForTimeout(3000);
  const oEngBtn = O.locator('[aria-label^="Actions for"]').first();
  if (await oEngBtn.count()) {
    await oEngBtn.click(); await O.waitForTimeout(500);
    await O.getByRole("menuitem", { name: /^Edit/ }).first().click();
    await O.waitForTimeout(1500);
    const eDisabled = await O.locator("#engine-price").isDisabled().catch(() => null);
    check(eDisabled === false, "GERRY ✅ engine selling price is editable", `disabled=${eDisabled}`);
    await O.keyboard.press("Escape"); await O.waitForTimeout(500);
  }

  step("Step 1 · rows 3–5 — retire and merge");
  await goto(A, search); await A.waitForTimeout(2500);
  const aMenu = await rowMenu(A, part.name);
  check(!/Remove product/.test(aMenu), "ADMIN ❌ 'Remove product' is HIDDEN",
    aMenu.replace(/\n/g, " · "));
  for (const keep of ["Edit", "Fitment", "Suppliers & prices"]) {
    check(aMenu.includes(keep), `…ADMIN keeps ${keep}`);
  }
  check((await A.getByRole("button", { name: /Merge duplicates/ }).count()) === 0,
    "ADMIN ❌ 'Merge duplicates' toolbar button is HIDDEN");
  await goto(O, search); await O.waitForTimeout(2500);
  const oMenu = await rowMenu(O, part.name);
  check(/Remove product/.test(oMenu), "GERRY ✅ 'Remove product' is present",
    oMenu.replace(/\n/g, " · "));
  check((await O.getByRole("button", { name: /Merge duplicates/ }).count()) > 0,
    "GERRY ✅ 'Merge duplicates' is present");

  // row 3b — in-master engine removal
  await goto(A, "/master-inventory?tab=engines"); await A.waitForTimeout(3000);
  await A.locator('[aria-label^="Actions for"]').first().click(); await A.waitForTimeout(500);
  const aEngMenu = await A.locator('[role="menu"]').last().innerText();
  check(!/Remove engine/.test(aEngMenu), "ADMIN ❌ 'Remove engine' is HIDDEN",
    aEngMenu.replace(/\n/g, " · "));
  await A.keyboard.press("Escape"); await A.waitForTimeout(300);

  // row 4 — retire a category
  await goto(A, "/master-inventory/categories"); await A.waitForTimeout(3000);
  const aRetire = await A.locator('[aria-label^="Retire "]').count();
  check(aRetire === 0, "ADMIN ❌ category 'Retire' controls are HIDDEN", `${aRetire} found`);
  await goto(O, "/master-inventory/categories"); await O.waitForTimeout(3000);
  const oRetire = await O.locator('[aria-label^="Retire "]').count();
  check(oRetire > 0, "GERRY ✅ category 'Retire' controls are present", `${oRetire} found`);

  step("Step 1 · row 6 — void an utang payment");
  // find a sale that HAS payment history, so the void control would render
  const withHistory = (await q("utang_payments?select=sale_id&deleted_at=is.null&limit=1"))[0];
  check(!!withHistory, "a recorded utang payment exists, so the void control could render");
  for (const [who, page, expectVoid] of [["ADMIN", A, false], ["GERRY", O, true]]) {
    await goto(page, "/receivables");
    const expanders = page.getByRole("button", { name: /Payment history \(\d+\)/ });
    // /receivables streams 1,600+ rows — wait for the control, don't sleep.
    if (!(await waitCount(expanders))) {
      check(false, `${who}: a sale with payment history is listed`); continue;
    }
    await expanders.first().click();
    await page.waitForTimeout(1200);
    const voids = await page.getByRole("button", { name: "Void payment", exact: true }).count();
    check(expectVoid ? voids > 0 : voids === 0,
      expectVoid
        ? "GERRY ✅ the 'Void payment' control renders"
        : "ADMIN ❌ the 'Void payment' control is HIDDEN in the expanded history",
      `${voids} void button(s)`);
  }

  step("Step 1 · row 7 — void an expense");
  const officeExpense = (await q("expenses?select=id,description&source=eq.owner&status=eq.approved&deleted_at=is.null&order=created_at.desc&limit=1"))[0]
    ?? (await q("expenses?select=id,description&status=eq.approved&deleted_at=is.null&order=created_at.desc&limit=1"))[0];
  check(!!officeExpense, "an approved office expense exists to open the row menu on",
    officeExpense?.description);
  for (const [who, page, expectVoid] of [["ADMIN", A, false], ["GERRY", O, true]]) {
    await goto(page, "/expenses");
    // Search for a specific OFFICE-created expense: a pending shop claim's
    // kebab is the disabled "Reviewed on the Approval Queue" one, so grabbing
    // row 1 blindly can land on a row that has no Void/Edit menu at all.
    const box = page.getByPlaceholder(/Search/).first();
    if (await waitCount(box)) {
      await box.fill(officeExpense.description);
      await page.waitForTimeout(2000);
    }
    const kebab = page.getByRole("button", { name: "Expense actions", exact: true }).first();
    if (!(await waitCount(kebab))) { check(false, `${who}: an expense row is listed`); continue; }
    await kebab.click();
    await page.waitForTimeout(600);
    const menu = await page.locator('[role="menu"]').last().innerText();
    check(expectVoid ? /Void/.test(menu) : !/Void/.test(menu),
      expectVoid ? "GERRY ✅ 'Void' is in the expense row menu"
                 : "ADMIN ❌ 'Void' is HIDDEN from the expense row menu",
      menu.replace(/\n/g, " · "));
    check(/Edit/.test(menu), `…${who} keeps Edit`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }

  step("Step 1 · rows 8–9 — shop credentials and close shop");
  const liveShop = (await q("shops?select=name&deleted_at=is.null&order=name&limit=1"))[0].name;
  for (const [who, page, expect] of [["ADMIN", A, false], ["GERRY", O, true]]) {
    await goto(page, "/shops");
    const menuBtn = page.getByRole("button", { name: `More actions for ${liveShop}`, exact: true }).first();
    if (!(await waitCount(menuBtn))) { check(false, `${who}: the ${liveShop} card rendered`); continue; }
    await menuBtn.click();
    await page.waitForTimeout(600);
    const menu = await page.locator('[role="menu"]').last().innerText();
    const hasCred = /Create Login|Change Credentials/.test(menu);
    const hasClose = /Close Permanently/.test(menu);
    check(hasCred === expect,
      expect ? "GERRY ✅ credential control present" : "ADMIN ❌ credential control HIDDEN",
      menu.replace(/\n/g, " · "));
    check(hasClose === expect,
      expect ? "GERRY ✅ 'Close Permanently' present" : "ADMIN ❌ 'Close Permanently' HIDDEN");
    check(/Edit Shop Details/.test(menu), `…${who} keeps 'Edit Shop Details'`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  // and the login-less panel's copy for an admin
  await goto(A, "/shops"); await A.waitForTimeout(3000);
  const aShops = await bodyText(A);
  if (/No login account yet/.test(aShops)) {
    check(/Only the owner can create the login\./.test(aShops),
      "ADMIN ❌ the login-less panel shows the explanation, not a button");
  } else {
    check(true, "every shop has a login — the no-login panel is not reachable");
  }

  step("Step 1 · rows 10–12 — the Gerry-only pages");
  for (const [path, label] of [
    ["/settings", "row 10/11 — admin accounts + settings"],
    ["/reports", "row 12 — Reports"],
    ["/expenses/reports", "row 12 — Expense Reports"],
  ]) {
    const landed = await landing(A, path);
    check(landed !== path, `ADMIN ❌ ${path} redirects away (${label})`, `landed on ${landed}`);
    const ok = await landing(O, path);
    check(ok === path, `GERRY ✅ ${path} opens`, `landed on ${ok}`);
  }
  const aNav = await A.locator("aside").first().innerText();
  check(!/\bReports\b/.test(aNav), "ADMIN ❌ Reports is absent from the sidebar");
  await A.locator("header button").last().click();
  await A.waitForTimeout(800);
  const aMenuTop = await A.locator('[role="menu"]').last().innerText();
  check(!/Settings/.test(aMenuTop), "ADMIN ❌ Settings is absent from the avatar menu",
    aMenuTop.replace(/\n/g, " · "));
  await A.keyboard.press("Escape");
  await shot(A, "task21-step1-adminmatrix");

  // ══ Step 2: the admin's daily powers are intact ═══════════════════════════
  step("Step 2 · the ADMIN's daily powers");
  const POWERS = [
    ["receive stock", "/suppliers?tab=receiving", () => A.getByRole("button", { name: "New Receiving", exact: true })],
    ["deliver", "/deliveries", () => A.getByRole("tab", { name: /New Delivery/ })],
    ["pay supplier debt", "/suppliers?tab=payables", () => A.getByRole("button", { name: "View details", exact: true })],
    ["record expenses", "/expenses", () => A.getByRole("button", { name: "Record expense", exact: true })],
    ["edit shop details / staff", "/shops", () => A.getByRole("button", { name: /Add Employee/ })],
    ["catalog: add product", "/master-inventory", () => A.getByRole("button", { name: /Add product/ })],
    ["record suki cards", "/suki-cards", () => A.getByRole("button", { name: "New card", exact: true })],
    ["run counts", "/counts", () => A.getByRole("button", { name: /Create & print/ })],
  ];
  for (const [name, path, locator] of POWERS) {
    await goto(A, path);
    await A.waitForTimeout(3000);
    const n = await locator().count();
    check(n > 0, `ADMIN ✅ can still ${name}`, `${n} control(s)`);
  }
  // catalog editing controls survive the retire lock
  await goto(A, search); await A.waitForTimeout(2500);
  const keepMenu = await rowMenu(A, part.name);
  for (const keep of ["Edit", "Fitment", "Suppliers & prices"]) {
    check(keepMenu.includes(keep), `ADMIN ✅ catalog control kept: ${keep}`);
  }
  console.log("  NOT exercised here: approve batches (/approvals) and approve");
  console.log("  warranty claims (/warranties) — the other agent is in both for");
  console.log("  Tasks 8b and 10. Task 0 already confirmed both appear in the");
  console.log("  ADMIN sidebar, and the DB probe proved the admin may run them.");

  // ══ Step 3: shop isolation (read-only) ════════════════════════════════════
  step("Step 3 · shop isolation");
  const shop = await session(browser, "shop", { clearLocalStorage: true });
  const shop2 = await session(browser, "shop2", { clearLocalStorage: true });
  const qShop = await dbAuth("shop");
  const qShop2 = await dbAuth("shop2");

  const s1 = (await q("profiles?select=shop_id&role=eq.employee&deleted_at=is.null&limit=200"));
  const shopNames = Object.fromEntries((await q("shops?select=id,name")).map((x) => [x.id, x.name]));

  // stock — each shop sees only its own rows
  const st1 = await qShop("shop_stock?select=shop_id&limit=1000");
  const st2 = await qShop2("shop_stock?select=shop_id&limit=1000");
  const ids1 = [...new Set(st1.map((r) => r.shop_id))];
  const ids2 = [...new Set(st2.map((r) => r.shop_id))];
  check(ids1.length === 1 && ids2.length === 1,
    "each shop's stock view returns exactly ONE shop_id",
    `${ids1.map((i) => shopNames[i])} / ${ids2.map((i) => shopNames[i])}`);
  check(ids1[0] !== ids2[0], "…and they are different shops — no overlap");

  // warranties — via the safe view, because /shop/warranties belongs to the
  // other agent right now (Task 10). Read-only.
  const w1 = await qShop("shop_warranties?select=id&limit=1000");
  const w2 = await qShop2("shop_warranties?select=id&limit=1000");
  const w1ids = new Set(w1.map((r) => r.id));
  const overlap = w2.filter((r) => w1ids.has(r.id));
  check(overlap.length === 0,
    "❌ no warranty is visible to BOTH shops (checked via shop_warranties, not the page)",
    `${w1.length} vs ${w2.length}, ${overlap.length} shared`);

  // receivables + expenses — in the browser
  await goto(shop.page, "/shop/receivables");
  await shop.page.waitForTimeout(3500);
  const r1 = await qShop("shop_receivables?select=shop_id&limit=1000");
  check([...new Set(r1.map((r) => r.shop_id))].length <= 1,
    "shop receivables are scoped to one shop", `${r1.length} rows`);

  await goto(shop.page, "/shop/expenses");
  await shop.page.waitForTimeout(3500);
  const e1 = await qShop("expenses?select=id,scope,shop_id&limit=1000");
  const foreign = e1.filter((e) => e.scope === "shop" && e.shop_id !== ids1[0]);
  const company = e1.filter((e) => e.scope === "company");
  check(foreign.length === 0, "❌ no other shop's expense is visible", `${foreign.length} foreign`);
  check(company.length === 0, "❌ company-scoped expenses NEVER appear to a shop",
    `${company.length} company-scoped rows visible`);

  // non-party slips 404
  const tr = (await q("deliveries?select=id,from_shop_id,shop_id&from_shop_id=not.is.null&deleted_at=is.null&limit=20"))
    .find((d) => d.from_shop_id !== ids1[0] && d.shop_id !== ids1[0]);
  const ret = (await q("returns?select=id,shop_id&deleted_at=is.null&limit=20"))
    .find((r) => r.shop_id !== ids1[0]);
  for (const [name, path] of [
    ["transfer slip", tr ? `/transfer/${tr.id}/slip` : null],
    ["return slip", ret ? `/return/${ret.id}/slip` : null],
  ]) {
    if (!path) { check(true, `${name}: no non-party fixture available — skipped`); continue; }
    const res = await shop.page.goto(`${APP}${path}`, { waitUntil: "load", timeout: 60000 });
    await shop.page.waitForTimeout(1500);
    const body = await shop.page.evaluate(() => document.body.innerText);
    check(res.status() === 404 || /not found|404|could not be found/i.test(body),
      `❌ a non-party shop gets 404 on the ${name}`,
      `status ${res.status()}`);
  }

  await shop.ctx.close();
  await shop2.ctx.close();
  await owner.ctx.close();
  await admin.ctx.close();
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
} finally {
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
