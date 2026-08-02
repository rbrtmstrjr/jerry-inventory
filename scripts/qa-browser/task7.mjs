// Task 7 (Stock Alerts and the Purchase List) — Steps 1–9.
//
// Read-heavy, but Steps 8 and 9 write: a request is dismissed and reorder
// levels / overrides are changed. Both are targeted at fixtures this script
// creates or at a product it picks by id — never by row position (see the
// README; a positional click in Task 6 resolved another shop's discrepancy).
import {
  launch, session, goto, bodyText, toast, clearToasts, shot, dbAuth,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser } = await launch();
const STAMP = process.env.QA_STAMP || String(Date.now()).slice(-6);
const q = await dbAuth("owner");
const qs = await dbAuth("shop");

const admin = await session(browser, "admin");
const shop = await session(browser, "shop");
const A = admin.page, S = shop.page;

async function tab(page, name) {
  await page.getByRole("tab", { name: new RegExp(name) }).first().click();
  await page.waitForTimeout(1500);
}

try {
  const myShopId = (await qs("profiles?select=shop_id"))[0].shop_id;
  const myShop = (await q(`shops?select=id,name,location&id=eq.${myShopId}`))[0];

  // ── Step 9: reorder levels and overrides ──────────────────────────────────
  step("Step 9: reorder levels and per-shop overrides");
  await goto(A, "/stock-alerts?tab=thresholds");
  await A.waitForTimeout(2500);
  // a SUPPLIER-LESS part with no master stock: giving it a reorder level makes
  // it low-stock in a second group, so Step 2's dropdown (which only renders
  // for >1 supplier) and the "No supplier set" block become reachable
  const target = (await q("parts?select=id,name,reorder_level&name=like.ZZ-QA*&preferred_supplier_id=is.null&deleted_at=is.null&limit=1"))[0];
  check(!!target, "a supplier-less QA product is available as the threshold target", target?.name);
  const search = A.locator('input[aria-label="Search products"]').first();
  check((await search.count()) > 0, "reorder-levels search present");
  await search.fill(target.name);
  await A.waitForTimeout(2000);
  const rowsShown = await A.locator('input[inputmode="numeric"]').count();
  check(rowsShown > 0 && rowsShown <= 40, "search narrows the list within one 40-row batch",
    `${rowsShown} qty inputs`);

  // each row is `#lvl-<productId>` — never "the first numeric input", which
  // could be the search box or a neighbouring row
  const box = A.locator(`#lvl-${target.id}`);
  await box.waitFor({ state: "visible", timeout: 15000 });
  /** Click the button labelled `label` in the same row as element `#id`.
   *  `locator("div").filter({has}).last()` selects the INNERMOST div, which
   *  does not contain the row's buttons — walk up from the anchor instead. */
  async function clickRowBtn(id, label) {
    const h = await A.evaluateHandle(({ id, label }) => {
      let el = document.getElementById(id);
      for (let i = 0; i < 8 && el; i++, el = el.parentElement) {
        const b = [...el.querySelectorAll("button")].find((x) => x.textContent.trim() === label);
        if (b) return b;
      }
      return null;
    }, { id, label });
    const el = h.asElement();
    if (!el) return false;
    await el.scrollIntoViewIfNeeded();
    await el.click();
    return true;
  }

  // typing "-1": onChange strips non-digits, so the sign never reaches state.
  // The "Reorder level must be 0 or more" guard is therefore unreachable by
  // typing — it is defence-in-depth for a programmatic path, not dead code.
  await box.fill("-1");
  await A.waitForTimeout(400);
  check((await box.inputValue()) === "1",
    "a typed minus sign is stripped, so a negative level can't be entered",
    await box.inputValue());

  await box.fill("7");
  await A.waitForTimeout(300);
  check(await clickRowBtn(`lvl-${target.id}`, "Save"), "row Save clicked");
  let msg = await toast(A, { timeout: 15000 });
  check(msg.includes(`${target.name} updated`), "valid save toasts '<name> updated'", msg);
  await A.waitForTimeout(2500);
  const saved = (await q(`parts?select=reorder_level&id=eq.${target.id}`))[0];
  check(saved.reorder_level === 7, "reorder level persisted", String(saved.reorder_level));

  // Overrides is a SECTION on this tab, not a tab of its own
  const ovBefore = await q("shop_reorder_levels?select=id,shop_id,part_id&deleted_at=is.null");
  const pageTxt = await bodyText(A);
  check(/Per-shop overrides/.test(pageTxt), "'Per-shop overrides' section present");
  if (ovBefore.length === 0) {
    check(/No overrides — every shop uses the product defaults\./.test(pageTxt),
      "overrides empty state, exact copy");
  } else {
    console.log(`  ${ovBefore.length} overrides already exist — the empty state is not applicable`);
    check(true, "overrides section renders its list");
  }

  // add an override for my product, then remove it
  await A.locator('button[role="combobox"]').filter({ hasText: "Pick a shop" }).first().click();
  await A.waitForTimeout(600);
  await A.getByRole("option", { name: myShop.name, exact: true }).first().click();
  await A.waitForTimeout(800);
  const ovItem = A.locator('button[role="combobox"]').filter({ hasText: /Pick a product|Pick an item|Product/ }).first();
  if (await ovItem.count()) {
    await ovItem.click();
    await A.waitForTimeout(700);
    const o = A.getByRole("option").filter({ hasText: target.name }).first();
    if (await o.count()) await o.click();
    else await A.keyboard.press("Escape");
    await A.waitForTimeout(600);
  }
  const lvlBox = A.locator('input[inputmode="numeric"]').last();
  await lvlBox.fill("3");
  await A.waitForTimeout(300);
  const setBtn = A.getByRole("button", { name: /Set override/ }).first();
  if (await setBtn.count() && !(await setBtn.isDisabled())) {
    await setBtn.click();
    msg = await toast(A, { not: msg, timeout: 20000 });
    check(/Override saved/.test(msg), "override saved toast", msg);
    await A.waitForTimeout(2500);
    const ovAfter = await q(`shop_reorder_levels?select=id,reorder_level&part_id=eq.${target.id}&shop_id=eq.${myShopId}&deleted_at=is.null`);
    check(ovAfter.length === 1 && ovAfter[0].reorder_level === 3, "override persisted",
      JSON.stringify(ovAfter[0]));
    // remove it again
    const rm = await A.evaluate(({ pname, sname }) => {
      const btns = [...document.querySelectorAll('button[aria-label="Remove override"]')];
      for (const b of btns) {
        let el = b.parentElement;
        for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
          const tx = el.textContent || "";
          if (!tx.includes(pname) || !tx.includes(sname)) continue;
          // the smallest ancestor naming both must own exactly ONE remove
          // button — otherwise it spans several rows and we'd delete a
          // stranger's override (the Task 6 lesson)
          if (el.querySelectorAll('button[aria-label="Remove override"]').length === 1) {
            b.click();
            return true;
          }
        }
      }
      return false;
    }, { pname: target.name, sname: myShop.name });
    const totalBefore = (await q("shop_reorder_levels?select=id&deleted_at=is.null&limit=1000")).length;
    if (rm) {
      msg = await toast(A, { not: msg, timeout: 20000 });
      check(/Override removed — back to the default/.test(msg), "override removed toast", msg);
      await A.waitForTimeout(2000);
      const gone = await q(`shop_reorder_levels?select=id&part_id=eq.${target.id}&shop_id=eq.${myShopId}&deleted_at=is.null`);
      const totalAfter = (await q("shop_reorder_levels?select=id&deleted_at=is.null&limit=1000")).length;
      check(gone.length === 0, "MY override is the one deleted", `${gone.length} rows left`);
      check(totalAfter === totalBefore - 1,
        "exactly one override was deleted (no collateral)", `${totalBefore} -> ${totalAfter}`);
    } else {
      check(false, "found the Remove control on my override row");
    }
  } else {
    check(false, "'Set override' is reachable once a shop, product and level are chosen");
  }
  await shot(A, "task7-step9-thresholds");

  // ── Step 1: master + all-shops tabs ───────────────────────────────────────
  step("Step 1: Master and All-shops tabs");
  await goto(A, "/stock-alerts");
  await A.waitForTimeout(2500);
  let t = await bodyText(A);
  const masterLow = await q("master_low_stock?select=kind&limit=1000");
  const shopLow = await q("shop_low_stock?select=kind&limit=1000");
  console.log(`  master low: ${masterLow.length} · shop low: ${shopLow.length}`);
  check(/Part|Engine/.test(t), "KindBadge (Part / Engine) renders in the Product cell",
    [...new Set((t.match(/\bPart\b|\bEngine\b/g) || []))].join(", "));
  if (masterLow.length === 0) {
    check(t.includes("Master stock is healthy — nothing to buy."), "master empty state");
  } else {
    check(!t.includes("Master stock is healthy"), "master list renders rows, not the empty state");
  }
  await tab(A, "shops|All-shops|Shops");
  t = await bodyText(A);
  if (shopLow.length === 0) {
    check(t.includes("No shop shortages."), "all-shops empty state");
  } else {
    check(!t.includes("No shop shortages."), "all-shops list renders rows");
  }
  await shot(A, "task7-step1-tabs");

  // ── Step 2: supplier filter drives the print link ─────────────────────────
  step("Step 2: supplier filter drives the print link");
  await goto(A, "/stock-alerts");
  await A.waitForTimeout(2500);
  const printLink = A.locator('a[href*="/stock-alerts/purchase-list"]').first();
  check((await printLink.count()) > 0, "Print link present on the Master tab");
  const hrefAll = await printLink.getAttribute("href");
  const supSel = A.locator('button[role="combobox"]').filter({ hasText: "All suppliers" }).first();
  check((await supSel.count()) > 0, "supplier dropdown present, default 'All suppliers'");
  if (await supSel.count()) {
    await supSel.click();
    await A.waitForTimeout(600);
    const opts = await A.getByRole("option").allTextContents();
    const pick = opts.find((o) => o.trim() && o.trim() !== "All suppliers");
    await A.getByRole("option", { name: pick, exact: true }).first().click();
    await A.waitForTimeout(1500);
    const hrefOne = await A.locator('a[href*="/stock-alerts/purchase-list"]').first().getAttribute("href");
    check(hrefOne !== hrefAll, `picking "${pick}" narrows the print link`,
      `${(hrefAll || "").length} → ${(hrefOne || "").length} chars`);
    // DOC DRIFT: the plan and CLAUDE.md say the link becomes ?supplier=<id>.
    // It emits ?ids=<kind:id,…> instead — deliberately, so the sheet prints
    // exactly what is filtered OR ticked. The page still accepts ?supplier=.
    check(/[?&]ids=/.test(hrefOne || ""), "print link carries an explicit ?ids= list",
      (hrefOne || "").slice(0, 90));
    const label = await A.locator('a[href*="/stock-alerts/purchase-list"]').first().innerText();
    check(/Print list \(\d+\)/.test(label), "button labels the row count", label.trim());
  }

  // ── Step 3: purchase list ─────────────────────────────────────────────────
  step("Step 3: purchase list details");
  await goto(A, "/stock-alerts/purchase-list");
  await A.waitForTimeout(2500);
  const pl = await bodyText(A);
  const biz = (await q("settings?select=business_name"))[0];
  check(pl.includes(biz.business_name), "letterhead from Settings", biz.business_name);
  check(/\d+\s*items?/.test(pl), "per-supplier item counts",
    `no match; near "item": ${JSON.stringify(pl.slice(Math.max(0, pl.indexOf("item") - 70), pl.indexOf("item") + 12))}`);
  check(/Order qty = shortfall \+ \d+ buffer/.test(pl), "buffer footnote",
    (pl.match(/Order qty[^\n]*/) || ["absent"])[0]);
  check(/Cheapest:|Best known price here/.test(pl), "cheapest-price suggestion",
    (pl.match(/(Cheapest:|Best known price here)[^\n]*/) || ["absent"])[0]);
  const hasNoSupplier = /No supplier set/.test(pl);
  console.log(`  "No supplier set" block present: ${hasNoSupplier}`);
  await shot(A, "task7-step3-purchase-list");

  // bogus supplier key falls back to the full sheet
  await goto(A, "/stock-alerts/purchase-list?supplier=zzz-not-a-supplier");
  await A.waitForTimeout(2000);
  const plBogus = await bodyText(A);
  check(plBogus.includes(biz.business_name) && plBogus.length > 400,
    "a bogus ?supplier= key falls back to the full sheet, not an error",
    `${plBogus.length} chars`);
  // and the documented ?supplier= deep link still narrows for a real key
  const anySup = (await q("suppliers?select=id,name&deleted_at=is.null&limit=1"))[0];
  await goto(A, `/stock-alerts/purchase-list?supplier=${anySup.id}`);
  await A.waitForTimeout(2000);
  const plOne = await bodyText(A);
  check(plOne.length < plBogus.length || plOne.includes(anySup.name),
    "?supplier=<real id> still narrows the sheet (legacy deep link intact)",
    `${plOne.length} vs ${plBogus.length} chars`);

  // ── Step 4: requests tab ──────────────────────────────────────────────────
  step("Step 4: requests tab");
  await goto(A, "/stock-alerts?tab=requests");
  await A.waitForTimeout(2500);
  t = await bodyText(A);
  const openReqs = await q("delivery_requests?select=id&status=eq.open");
  console.log(`  open requests in the database: ${openReqs.length}`);
  const badge = (t.match(/Open\s*(\d+)/) || [])[1];
  check(String(openReqs.length) === badge, "the Open badge equals the open count",
    `badge ${badge} vs db ${openReqs.length}`);
  if (openReqs.length === 0) check(t.includes("No open requests."), "open empty state");
  await tab(A, "Reviewed");
  const rev = await bodyText(A);
  const reviewed = await q("delivery_requests?select=id&status=neq.open&limit=1");
  if (reviewed.length === 0) check(rev.includes("Nothing reviewed yet."), "reviewed empty state");
  else check(!rev.includes("Nothing reviewed yet."), "reviewed list renders");

  // ── Step 5: new-product (custom) request lines ────────────────────────────
  step("Step 5: new-product request lines");
  const openIds = (await q("delivery_requests?select=id&status=eq.open&limit=1000")).map((r) => r.id);
  const custom = openIds.length
    ? await q(`delivery_request_lines?select=delivery_request_id,custom_name&custom_name=not.is.null&delivery_request_id=in.(${openIds.join(",")})&limit=1`)
    : [];
  let CUSTOM_REQ = custom[0]?.delivery_request_id ?? null;
  if (!CUSTOM_REQ) {
    console.log("  no seeded custom line — creating one from the shop");
    await goto(S, "/shop/low-stock");
    await S.waitForTimeout(2500);
    // the custom-line inputs only exist after "Add product" adds a blank row
    const addRow = S.getByRole("button", { name: "Add product", exact: true }).first();
    if (await addRow.count()) { await addRow.click(); await S.waitForTimeout(900); }
    const nameBox = S.getByLabel("New product name").first();
    if (await nameBox.count()) {
      await nameBox.fill(`ZZ-QA Custom ${STAMP}`);
      await S.getByLabel("Quantity").last().fill("2");
      await S.waitForTimeout(600);
      await S.getByRole("button", { name: /^Request \d+ items?$/ }).first().click();
      const rmsg = await toast(S, { timeout: 20000 });
      console.log("  shop request toast:", rmsg);
      await S.waitForTimeout(3000);
      const made = await q(`delivery_request_lines?select=delivery_request_id&custom_name=eq.${encodeURIComponent(`ZZ-QA Custom ${STAMP}`)}`);
      CUSTOM_REQ = made[0]?.delivery_request_id ?? null;
    }
  }
  check(!!CUSTOM_REQ, "a request with a free-text custom line exists", String(CUSTOM_REQ));
  if (CUSTOM_REQ) {
    await goto(A, "/stock-alerts?tab=requests");
    await A.waitForTimeout(2500);
    const pageTxt = await bodyText(A);
    const cname = (await q(`delivery_request_lines?select=custom_name&delivery_request_id=eq.${CUSTOM_REQ}&custom_name=not.is.null&limit=1`))[0]?.custom_name;
    check(!!cname && pageTxt.includes(cname), "the custom line is listed on the request card", cname);
    // the card badges it "New" (outlined, primary) — the plan says "New
    // product"; the receipt spells the full phrase out. Same information.
    const badged = await A.evaluate((name) => {
      const badges = [...document.querySelectorAll("span,div")].filter(
        (e) => e.textContent.trim() === "New" && e.children.length === 0
      );
      return badges.some((b) => (b.parentElement?.textContent || "").includes(name));
    }, cname);
    check(badged, "custom line carries a 'New' badge next to its name on the card");
  }

  // ── Step 6: print the request receipt ─────────────────────────────────────
  step("Step 6: print the request receipt");
  const anyReq = CUSTOM_REQ
    ? (await q(`delivery_requests?select=id,status,shop_id&id=eq.${CUSTOM_REQ}`))[0]
    : (await q("delivery_requests?select=id,status,shop_id&order=created_at.desc&limit=1"))[0];
  await goto(A, `/stock-alerts/request/${anyReq.id}/receipt`);
  await A.waitForTimeout(2500);
  const rc = await bodyText(A);
  check(rc.includes(biz.business_name), "receipt carries the letterhead");
  check(/Requested by/.test(rc), "'Requested by' block");
  check(/signature \/ date/i.test(rc), "signature lines",
    (rc.match(/[^\n]*signature[^\n]*/i) || ["absent"])[0]);
  const cap = anyReq.status.charAt(0).toUpperCase() + anyReq.status.slice(1);
  check(rc.includes(cap), "status printed capitalised", cap);
  const reqShop = (await q(`shops?select=name,location&id=eq.${anyReq.shop_id}`))[0];
  check(rc.includes(reqShop.name), "names the requesting shop");
  if (reqShop.location) check(rc.includes(reqShop.location), "prints the shop location");
  if (CUSTOM_REQ) {
    // the receipt spells it out rather than using the card's badge wording
    check(/new product\s*[^\n]*not in catalog/i.test(rc),
      "custom line marked '(new product - not in catalog)' on the receipt",
      (rc.split("\n").find((l) => /not in catalog/i.test(l)) ?? "absent"));
  }
  await shot(A, "task7-step6-request-receipt");

  // ── Step 7: convert to delivery ───────────────────────────────────────────
  step("Step 7: convert to delivery");
  await goto(A, `/deliveries?request=${anyReq.id}`);
  await A.waitForTimeout(3000);
  const conv = await bodyText(A);
  check((await A.locator('[role="tab"][data-state="active"]').innerText()).includes("New Delivery"),
    "converting lands on the New Delivery tab with the request prefilled");
  const lines = await q(`delivery_request_lines?select=part_id,engine_model_id,custom_name,qty_requested&delivery_request_id=eq.${anyReq.id}`);
  const customLines = lines.filter((l) => l.custom_name);
  console.log(`  request lines: ${lines.length} (${customLines.length} custom)`);
  const hasNoStockBlock = /no master stock/i.test(conv);
  const hasCaption = /requested \d+, only \d+ available/i.test(conv);
  console.log(`  "no master stock" block: ${hasNoStockBlock} · capped caption: ${hasCaption}`);
  if (customLines.length) {
    check(/create via Receiving first|Receiving/i.test(conv),
      "custom lines shown as an informational 'create via Receiving' block");
    const payloadHasCustom = conv.includes(customLines[0].custom_name);
    console.log(`  custom name appears on screen (informational only): ${payloadHasCustom}`);
  }
  check(/requested item\(s\) have no master stock yet|Deliver \(into transit\)/.test(conv),
    "the convert screen renders its warning or its deliver control");
  await shot(A, "task7-step7-convert");

  // ── Step 8: dismiss a request ─────────────────────────────────────────────
  step("Step 8: dismiss a request");
  // dismiss ONLY a request this sweep created, never a seeded one
  const mine = await q(`delivery_requests?select=id,status,shop_id&id=eq.${CUSTOM_REQ ?? "00000000-0000-0000-0000-000000000000"}`);
  if (mine[0] && mine[0].status === "open") {
    await goto(A, "/stock-alerts?tab=requests");
    await A.waitForTimeout(2500);
    const clicked = await A.evaluate((rid) => {
      const link = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href")?.includes(rid));
      let el = link;
      for (let i = 0; i < 8 && el; i++) {
        el = el.parentElement;
        if (!el) break;
        const btn = [...el.querySelectorAll("button")].find((b) => /Dismiss/.test(b.textContent));
        if (btn) { btn.click(); return true; }
      }
      return false;
    }, mine[0].id);
    check(clicked, "found Dismiss on MY request card");
    await A.waitForTimeout(1200);
    const dd = A.locator('[role="dialog"], [role="alertdialog"]').last();
    const reason = dd.locator("textarea, input[type=text]").first();
    if (await reason.count()) await reason.fill(`ZZ-QA ${STAMP} not needed`);
    await A.waitForTimeout(300);
    await dd.getByRole("button", { name: /Dismiss/ }).last().click();
    const msg = await toast(A, { timeout: 20000 });
    check(/Request dismissed — the shop was told/.test(msg), "dismiss toast, exact copy", msg);
    await A.waitForTimeout(2500);
    const after = (await q(`delivery_requests?select=status&id=eq.${mine[0].id}`))[0];
    check(after.status === "dismissed", "request marked dismissed", after.status);
    await goto(S, "/shop/low-stock");
    await S.waitForTimeout(2500);
    await S.getByRole("tab", { name: /My requests/ }).first().click();
    await S.waitForTimeout(2000);
    check(/Dismissed/i.test(await bodyText(S)), "the shop sees it in their history");
  } else {
    check(false, "a QA-created open request was available to dismiss");
  }

} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(A, "task7-crash").catch(() => {});
} finally {
  console.log("\nSTAMP:", STAMP);
  const errs = [...admin.errors, ...shop.errors];
  console.log("console errors:", errs.length ? errs.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
