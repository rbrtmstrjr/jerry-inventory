// Task 13 — Movements: Journal, Stock Card, Engine History. Steps 1–7, as GERRY.
//
// The page is read-only by construction (`stock_movements` has no
// INSERT/UPDATE/DELETE policy for anyone), so nothing here can mutate the
// ledger. It is safe to run beside another agent.
//
// ASSERT STRUCTURE, NEVER ABSOLUTE TOTALS. A second agent is writing movements
// continuously, so a row count or a balance captured at read time is stale by
// the next assertion. What IS stable:
//   · which columns, filters and empty states exist,
//   · that a filter returns a SUBSET of what it filtered,
//   · that the stock card's own arithmetic closes (opening + Σ qty_change =
//     closing) within a single render,
//   · that the page's own reconciliation banner renders.
// The one number worth checking is the card's internal consistency, because the
// server computes the balance and the on-hand quantity in the SAME render — so
// a mismatch is the app disagreeing with itself, not with a moving dataset.
import {
  launch, login, goto, bodyText, shot, dbAuth,
  step, check, summary, APP,
} from "./qa-lib.mjs";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner");

const rowCount = () => page.locator("tbody tr").count();
/** Read the journal's rendered rows as objects (never compared to the DB). */
async function journalRows() {
  return page.locator("tbody tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const td = [...tr.querySelectorAll("td")].map((c) => c.innerText.trim());
      return { when: td[0], location: td[1], product: td[2], type: td[3],
               qtyIn: td[4], qtyOut: td[5], source: td[6], actor: td[7] };
    })
  );
}

try {
  await login(page, "owner");

  // ── Step 1: journal filters ───────────────────────────────────────────────
  step("Step 1: journal filters and default range");
  await goto(page, "/movements");
  await page.waitForTimeout(3500);
  let t = await T();
  // The header row is `uppercase`, so innerText returns caps — match
  // case-insensitively. The reference column is "Reference", not "Source".
  for (const col of ["When", "Location", "Product", "Type", "In", "Out", "Reference", "Actor"]) {
    check(new RegExp(`\\b${col}\\b`, "i").test(t), `column present: ${col}`);
  }
  // default range must be today-30 → today, never "all time"
  // DatePicker is a Button (#mv-from / #mv-to) printing "MMM d, yyyy", not a
  // native <input type=date>.
  const from = (await page.locator("#mv-from").innerText()).trim();
  const to = (await page.locator("#mv-to").innerText()).trim();
  const days = Math.round((new Date(to) - new Date(from)) / 86400000);
  check(!/Pick a date/.test(from) && !/Pick a date/.test(to),
    "both date pickers are populated (not 'all time')", `${from} → ${to}`);
  check(days === 30, "default range spans 30 days", `${from} → ${to} = ${days}d`);

  const baseline = await rowCount();
  console.log(`  ${baseline} rows in the default window (not asserted — the ledger is live)`);
  check(baseline > 0, "the default window renders rows to filter");

  // each filter must return a SUBSET — a relative check, immune to new writes
  for (const [label, url] of [
    ["location=master", "/movements?location=master"],
    ["type=sale", "/movements?type=sale"],
  ]) {
    await goto(page, url);
    await page.waitForTimeout(3000);
    const n = await rowCount();
    check(n <= baseline + 5, `${label} returns no more than the unfiltered window`,
      `${n} vs baseline ${baseline} (+5 slack for concurrent writes)`);
  }
  // a filter that cannot match anything
  await goto(page, "/movements?q=zzzz-no-such-movement-zzzz");
  await page.waitForTimeout(3000);
  check(/No movements match these filters\./.test(await T()),
    "empty state 'No movements match these filters.'",
    ((await T()).match(/No movements[^\n]*/) || ["absent"])[0]);
  await shot(page, "task13-step1-journal");

  // filter controls exist with their documented options
  await goto(page, "/movements");
  await page.waitForTimeout(3000);
  for (const lbl of ["Location", "Type", "Product", "Actor"]) {
    check((await page.getByText(lbl, { exact: true }).count()) > 0, `filter control: ${lbl}`);
  }
  check((await page.getByLabel("Search movements").count()) === 1,
    "search box is aria-labelled 'Search movements'");

  // ── Step 2: transit rows read correctly ───────────────────────────────────
  step("Step 2: transit write-offs report at 'transit'");
  await goto(page, "/movements?location=transit&from=2024-01-01&to=2026-12-31");
  await page.waitForTimeout(4000);
  const transit = await journalRows();
  if (transit.length) {
    check(transit.every((r) => /never reached a shop/.test(r.location)),
      "every transit row appends '(never reached a shop)'",
      transit[0].location.replace(/\n/g, " "));
    check(transit.every((r) => !/^Master$/.test(r.location.split("\n")[0])),
      "…and is NOT labelled Master", transit[0].location.split("\n")[0]);
    check(transit.every((r) => /Write-off|transit/i.test(r.type)),
      "the type column marks them as write-offs",
      [...new Set(transit.map((r) => r.type))].join(", "));
  } else {
    check(false, "at least one transit_writeoff row exists to inspect");
  }

  // a loss row appends its reason in the Product cell
  await goto(page, "/movements?type=loss&from=2024-01-01&to=2026-12-31");
  await page.waitForTimeout(4000);
  const losses = await journalRows();
  const reasons = ["nasira", "nawala", "expired", "sample", "correction", "warranty"];
  check(losses.length > 0, "loss rows render");
  check(losses.some((r) => reasons.some((x) => r.product.toLowerCase().includes(x))),
    "a loss row appends its reason in the Product cell",
    losses.slice(0, 3).map((r) => r.product.replace(/\n/g, " ")).join(" | "));
  await shot(page, "task13-step2-transit");

  // ── Step 3: deep links ────────────────────────────────────────────────────
  step("Step 3: rows deep-link to their source document");
  await goto(page, "/movements?from=2024-01-01&to=2026-12-31");
  await page.waitForTimeout(4000);
  // Probe each source type through its OWN type filter. Scanning whichever 50
  // rows happen to be on page 1 makes the result depend on what the other agent
  // wrote a minute ago — a receiving row simply may not be there.
  const hrefs = async () =>
    page.locator("tbody a").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? ""));

  const SOURCES = [
    { type: "received", name: "receiving", re: /\/suppliers\?tab=receiving&view=[0-9a-f-]{36}/ },
    { type: "delivery", name: "delivery note", re: /\/deliveries\/[0-9a-f-]{36}\/note/ },
    { type: "sale", name: "sale", re: /\/approvals\?item=sale:[0-9a-f-]{36}/ },
    { type: "loss", name: "loss", re: /\/approvals\?item=loss:[0-9a-f-]{36}/ },
    { type: "return", name: "return", re: /\/deliveries\?tab=transfers/ },
  ];
  for (const s of SOURCES) {
    await goto(page, `/movements?type=${s.type}&from=2024-01-01&to=2026-12-31`);
    await page.waitForTimeout(3000);
    const hs = await hrefs();
    if (!hs.length) { check(true, `no ${s.name} rows in range to link-check`); continue; }
    const hit = hs.find((h) => s.re.test(h));
    check(!!hit, `a ${s.name} row deep-links to its own document`,
      hit ?? (hs.filter((h) => !/tab=(ledger|engines)/.test(h)).slice(0, 2).join(" | ") || "(product links only)"));
  }

  // follow a product link and a receiving link for real
  await goto(page, "/movements?from=2024-01-01&to=2026-12-31");
  await page.waitForTimeout(3000);
  const all = await hrefs();
  const prodLink = all.find((h) => /tab=ledger&part=/.test(h));
  if (prodLink) {
    await page.goto(`${APP}${prodLink}`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(4000);
    check(/Opening balance/.test(await T()),
      "following a product link opens its stock card", prodLink);
  }
  await goto(page, "/movements?type=received&from=2024-01-01&to=2026-12-31");
  await page.waitForTimeout(3000);
  const rcvLink = (await hrefs()).find((h) => /tab=receiving&view=/.test(h));
  if (rcvLink) {
    await page.goto(`${APP}${rcvLink}`, { waitUntil: "load", timeout: 60000 });
    await page.waitForTimeout(5000);
    const rt = await T();
    check(/line|Total cost|Received/i.test(rt) && !/Pick the supplier/.test(rt.slice(0, 200)),
      "following a receiving link opens THAT receiving's detail, not the list",
      (rt.match(/[^\n]*Total cost[^\n]*/) || rt.match(/[^\n]*line\(s\)[^\n]*/) || ["(dialog text not found)"])[0]);
  }

  // ── Step 4: stock card ────────────────────────────────────────────────────
  step("Step 4: stock card opening → running → closing");
  await goto(page, "/movements?tab=ledger");
  await page.waitForTimeout(3000);
  check(/Pick a product to see its stock card\./.test(await T()), "idle state");

  // Choose a (part, shop) pair that HAS movements. This is fixture SELECTION,
  // not an assertion — the numbers it produces are never compared to anything.
  const mv = await q("stock_movements?select=part_id,shop_id&part_id=not.is.null&shop_id=not.is.null&order=created_at.desc&limit=200");
  const pick = mv.find((m) => m.part_id && m.shop_id);
  check(!!pick, "found a (part, shop) pair with movements to chart");
  await goto(page, `/movements?tab=ledger&part=${pick.part_id}&shop=${pick.shop_id}&from=2024-01-01&to=2026-12-31`);
  await page.waitForTimeout(5000);
  t = await T();
  check(/Opening balance/.test(t), "Opening balance row renders");
  check(/Closing balance/.test(t), "Closing balance row renders");

  // The card's OWN arithmetic must close inside one render.
  const card = await page.locator("tbody tr, tfoot tr").evaluateAll((trs) =>
    trs.map((tr) => [...tr.querySelectorAll("td")].map((c) => c.innerText.trim())));
  const num = (s) => Number(String(s).replace(/[^\d.-]/g, "")) || 0;
  const opening = card.find((r) => /Opening balance/.test(r.join(" ")));
  const closing = card.find((r) => /Closing balance/.test(r.join(" ")));
  if (opening && closing) {
    const openVal = num(opening[opening.length - 1]);
    const closeVal = num(closing[closing.length - 1]);
    // sum the signed movement column between them
    const body = card.filter((r) => r.length >= 5 && !/balance/i.test(r.join(" ")));
    const delta = body.reduce((s, r) => s + num(r[3]) - num(r[4]), 0);
    check(openVal + delta === closeVal,
      "opening + Σ(in − out) === closing (the card's own arithmetic closes)",
      `${openVal} + ${delta} = ${openVal + delta}, card says ${closeVal}`);
  } else {
    check(false, "opening and closing rows both readable");
  }
  // the page's own reconciliation banner — the app comparing itself to itself
  const matches = /Closing balance matches on-hand stock/.test(t);
  const mismatch = /Closing balance is .* but on-hand stock says/.test(t);
  check(matches || mismatch, "the card renders a reconciliation banner");
  if (mismatch) {
    console.log("  banner reports a MISMATCH — re-rendering once in case a");
    console.log("  concurrent write landed mid-render…");
    await page.reload({ waitUntil: "load" });
    await page.waitForTimeout(5000);
    const t2 = await T();
    check(/Closing balance matches on-hand stock/.test(t2),
      "reconciliation banner says 'matches' on a settled read",
      (t2.match(/Closing balance[^\n]*/) || ["absent"])[0]);
  } else {
    check(matches, "reconciliation banner says 'matches'",
      (t.match(/Closing balance matches[^\n]*/) || ["absent"])[0]);
  }
  check(/never reached this location, so it is not on this card/.test(t),
    "standing transit footnote present");
  await shot(page, "task13-step4-stockcard");

  // a period with no movement
  await goto(page, `/movements?tab=ledger&part=${pick.part_id}&shop=${pick.shop_id}&from=2019-01-01&to=2019-01-31`);
  await page.waitForTimeout(4000);
  check(/No movements in this period\. The opening balance carried straight through\./.test(await T()),
    "empty-period copy", ((await T()).match(/No movements in this period[^\n]*/) || ["absent"])[0]);

  // ── Step 5: stock card print ──────────────────────────────────────────────
  step("Step 5: stock card print");
  await goto(page, `/movements/stock-card/print?part=${pick.part_id}&shop=${pick.shop_id}&from=2024-01-01&to=2026-12-31`);
  await page.waitForTimeout(4000);
  t = await T();
  const biz = (await q("settings?select=business_name"))[0].business_name;
  check(t.includes(biz), "letterhead carries the business name from Settings", biz);
  check(/Notes/i.test(t), "Notes box present");
  check(/Checked by/i.test(t), "signature line present ('Checked by')",
    (t.match(/[^\n]*Checked by[^\n]*/i) || ["absent"])[0]);
  await shot(page, "task13-step5-print");

  const res = await page.goto(`${APP}/movements/stock-card/print`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(1500);
  check(res.status() === 404 || /not found|404|could not be found/i.test(await T()),
    "❌ print with no ?part= is 404",
    `status ${res.status()} · ${(await T()).slice(0, 60).replace(/\n/g, " ")}`);

  // ── Step 6: engine history ────────────────────────────────────────────────
  step("Step 6: engine history");
  await goto(page, "/movements?tab=engines");
  await page.waitForTimeout(3000);
  check(/Scan or enter a serial to trace an engine's whole life\./.test(await T()),
    "idle state");
  await goto(page, "/movements?tab=engines&serial=ZZQB-NO-SUCH-SERIAL");
  await page.waitForTimeout(3500);
  check(/No engine with serial/.test(await T()), "bogus serial → 'No engine with serial <X>.'",
    ((await T()).match(/No engine with serial[^\n]*/) || ["absent"])[0]);

  // a real serial — chosen from the DB, asserted only for STRUCTURE
  const eng = (await q("engines?select=serial_number,status&deleted_at=is.null&status=eq.sold&order=created_at.desc&limit=1"))[0]
    ?? (await q("engines?select=serial_number,status&deleted_at=is.null&order=created_at.desc&limit=1"))[0];
  await goto(page, `/movements?tab=engines&serial=${encodeURIComponent(eng.serial_number)}`);
  await page.waitForTimeout(4500);
  t = await T();
  check(t.includes(eng.serial_number), "the serial is echoed on the page", eng.serial_number);
  check(/In master|At shop|Sold|Returned|In transit|Defective/i.test(t),
    "header card shows a state badge",
    (t.match(/In master|At shop|Sold|Returned|In transit|Defective/i) || ["absent"])[0]);
  check(/₱[\d,]+/.test(t), "header card shows a unit cost");
  check(/Received|Delivered|Sold/i.test(t), "the life chain renders events",
    [...new Set(t.match(/Received|Delivered|Sold/gi) || [])].join(" → "));
  await shot(page, "task13-step6-engine");

  // ── Step 7: reconciliation spot-check ─────────────────────────────────────
  step("Step 7: reconciliation spot-check (structural)");
  // Deliberately NOT Σ movements vs stock_levels computed here: the other agent
  // is writing, so any figure I capture is stale before I can compare it. The
  // page already does this comparison server-side within one render — assert
  // THAT, on a second independent product.
  const other = mv.find((m) => m.part_id !== pick.part_id && m.shop_id);
  if (other) {
    await goto(page, `/movements?tab=ledger&part=${other.part_id}&shop=${other.shop_id}&from=2024-01-01&to=2026-12-31`);
    await page.waitForTimeout(5000);
    const t3 = await T();
    check(/Closing balance matches on-hand stock|Closing balance is .* but on-hand stock says/.test(t3),
      "a second product also renders the reconciliation banner");
    check(/Closing balance matches on-hand stock/.test(t3),
      "…and it reconciles",
      (t3.match(/Closing balance[^\n]*/) || ["absent"])[0]);
  } else {
    check(false, "a second product with movements exists");
  }
  console.log("  (Σ movements = stock_levels across the whole ledger is proven by");
  console.log("   test-movements.mjs, not re-derived here against live data.)");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task13-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
