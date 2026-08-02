// Task 12 — Monthly Count. Steps 1–6, as GERRY.
//
// SHOP CHOICE: Gerwin-Bacoor. Deliberately NOT Gerwin-Ternate (shop1) or
// Gerwin-Naic (shop2) — the concurrent agent's shop sessions run there.
//
// APPROVAL IS NOT EXERCISED. Step 5 says "approve one and confirm stock
// deducts"; approving is an Approval Queue action, which belongs to the other
// agent's Task 8, and it books an IRREVERSIBLE stock movement. This script
// sends the shortage to the queue and verifies it ARRIVED as `pending` — the
// count's own responsibility — and stops there. The single pending loss it
// leaves is listed in the fixtures table.
//
// Rows are addressed by their own aria-label ("Counted quantity for <part>"),
// never by index — see the README's costly lesson.
import {
  launch, login, goto, bodyText, shot, dbAuth,
  step, check, summary, toast, clearToasts, APP,
} from "./qa-lib.mjs";

const SHOP = "Gerwin-Bacoor";
const NOTE = `ZZ-QB count ${new Date().toISOString().slice(0, 10)}`;

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner");

/** Filter to one part, then drive it by its own label. */
async function countField(partName) {
  await page.getByLabel("Find an item to count").fill(partName);
  await page.waitForTimeout(1200);
  return page.getByLabel(`Counted quantity for ${partName}`, { exact: true });
}
async function save() {
  await page.getByRole("button", { name: /^Save/ }).first().click();
}

try {
  await login(page, "owner");

  // ── Step 1: create a session ──────────────────────────────────────────────
  step("Step 1: create a count session");
  await goto(page, "/counts");
  await page.waitForTimeout(3000);
  const existing = await q("count_snapshots?select=id&deleted_at=is.null");
  if (existing.length === 0) {
    check(/No count sheets yet\./.test(await T()), "empty state 'No count sheets yet.'");
  } else {
    check(true, `${existing.length} count sheet(s) already exist — empty state not reachable`);
  }

  // The form is an inline Card on the page, not a dialog, and the submit is
  // "Create & print".
  const createBtn = page.getByRole("button", { name: /Create & print/ });
  await createBtn.click();
  const tNoShop = await toast(page);
  check(/Pick a shop/.test(tNoShop), "❌ create with no shop → 'Pick a shop'", tNoShop);
  await clearToasts(page);

  // Scope the shop select by its own placeholder — the DataTable's "Rows per
  // page" select is also a button[role="combobox"] on this page.
  await page.locator('button[role="combobox"]').filter({ hasText: "Pick a shop" }).first().click();
  await page.waitForTimeout(700);
  await page.getByRole("option", { name: SHOP, exact: true }).click();
  await page.waitForTimeout(400);
  await page.locator("#cnt-note").fill(NOTE);
  await createBtn.click();
  const tCreate = await toast(page);
  check(/Count sheet created — expected quantities frozen/.test(tCreate),
    "toast 'Count sheet created — expected quantities frozen'", tCreate);
  await page.waitForTimeout(3500);
  await clearToasts(page);

  const snap = (await q(`count_snapshots?select=id,shop_id,snapshot_date&note=eq.${encodeURIComponent(NOTE)}&deleted_at=is.null`))[0];
  check(!!snap, "snapshot row persisted");
  const SNAP = snap.id;
  const lines = await q(`count_snapshot_lines?select=id,part_id,expected_qty&snapshot_id=eq.${SNAP}&order=expected_qty.desc&limit=400`);
  check(lines.length > 0, "expected quantities were frozen into lines", `${lines.length} lines`);
  // the frozen figures must match the shelf at snapshot time
  const shopStock = await q(`stock_levels?select=part_id,qty&shop_id=eq.${snap.shop_id}&limit=1000`);
  const byPart = new Map(shopStock.map((r) => [r.part_id, r.qty]));
  const mismatched = lines.filter((l) => byPart.get(l.part_id) !== l.expected_qty);
  check(mismatched.length === 0, "every frozen expected_qty equals the shop's on-hand at that moment",
    `${mismatched.length} mismatched of ${lines.length}`);

  // pick two parts with room to move, by NAME (never by row index)
  const usable = lines.filter((l) => l.expected_qty >= 3).slice(0, 2);
  check(usable.length === 2, "found two lines with expected_qty ≥ 3 to vary");
  const names = await q(`parts?select=id,name&id=in.(${usable.map((l) => l.part_id).join(",")})`);
  const A = { ...usable[0], name: names.find((n) => n.id === usable[0].part_id).name };
  const B = { ...usable[1], name: names.find((n) => n.id === usable[1].part_id).name };
  console.log(`  part A: ${A.name} (expected ${A.expected_qty})`);
  console.log(`  part B: ${B.name} (expected ${B.expected_qty})`);

  // ── Step 2: print the blank sheet ─────────────────────────────────────────
  step("Step 2: printable count sheet");
  await goto(page, `/counts/${SNAP}/sheet`);
  await page.waitForTimeout(3500);
  let t = await T();
  const biz = (await q("settings?select=business_name"))[0].business_name;
  check(t.includes(biz), "letterhead carries the business name", biz);
  check(t.includes(SHOP), "sheet names the shop", SHOP);
  check(/Counted by: _+/.test(t), "'Counted by: ____' signature block",
    (t.match(/Counted by:[^\n]*/) || ["absent"])[0]);
  check(/Date\/time: _+/.test(t), "'Date/time: ____' block");
  check(/Expected/i.test(t), "Expected column shown on the normal sheet");
  const engines = await q(`engines?select=id&shop_id=eq.${snap.shop_id}&status=eq.delivered&deleted_at=is.null`);
  if (engines.length) {
    // heading is `uppercase` — innerText returns caps
    check(/Engines on hand — tick if present/i.test(t),
      "engines tick-list renders (this shop holds delivered engines)", `${engines.length} engines`);
  } else {
    check(!/Engines on hand/i.test(t), "no engines tick-list when the shop holds none");
  }
  await shot(page, "task12-step2-sheet");

  await goto(page, `/counts/${SNAP}/sheet?blind=1`);
  await page.waitForTimeout(3000);
  t = await T();
  check(/BLIND COUNT — expected hidden/.test(t), "blind marker present");
  check(!/\bExpected\b/.test(t), "❌ expected quantities are hidden in blind mode",
    (t.match(/[^\n]*Expected[^\n]*/) || ["hidden"])[0]);
  await shot(page, "task12-step2-blind");

  // ── Step 3: enter counts ──────────────────────────────────────────────────
  step("Step 3: enter counts");
  await goto(page, `/counts/${SNAP}`);
  await page.waitForTimeout(4000);
  t = await T();
  check(new RegExp(`counted 0/${lines.length}`).test(t), "header progress starts at 0",
    (t.match(/counted \d+\/\d+/) || ["absent"])[0]);
  check(/Loading more… \(\d+ of \d+\)/.test(t), "scroll sentinel 'Loading more… (n of N)'",
    (t.match(/Loading more…[^\n]*/) || ["absent"])[0]);

  await page.getByLabel("Find an item to count").fill("zzzz-no-such-item");
  await page.waitForTimeout(1200);
  check(/Nothing matches/.test(await T()), "search empty state 'Nothing matches “…”.'",
    ((await T()).match(/Nothing matches[^\n]*/) || ["absent"])[0]);

  // a valid count on A, an INVALID one on B — the whole save must abort
  await (await countField(A.name)).fill("5");
  await page.waitForTimeout(300);
  await (await countField(B.name)).fill("-1");
  await page.waitForTimeout(300);
  await save();
  const tBad = await toast(page);
  check(new RegExp(`${B.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: invalid count`).test(tBad),
    "❌ negative count → '<part>: invalid count'", tBad);
  await page.waitForTimeout(2000);
  const afterBad = await q(`count_snapshot_lines?select=counted_qty&id=eq.${A.id}`);
  check(afterBad[0].counted_qty === null,
    "❌ the WHOLE save aborted — the valid line was not written either",
    String(afterBad[0].counted_qty));
  await clearToasts(page);

  // fix it
  await (await countField(B.name)).fill(String(B.expected_qty));
  await page.waitForTimeout(300);
  await save();
  const tOk = await toast(page);
  check(/Counts saved/.test(tOk), "toast 'Counts saved'", tOk);
  await page.waitForTimeout(2500);
  await clearToasts(page);
  await goto(page, `/counts/${SNAP}`);
  await page.waitForTimeout(3500);
  check(/counted 2\/\d+/.test(await T()), "header progress reads counted 2/N",
    ((await T()).match(/counted \d+\/\d+/) || ["absent"])[0]);

  // ── Step 4: variances ─────────────────────────────────────────────────────
  step("Step 4: variances");
  // A short by 1, B over by 2
  await (await countField(A.name)).fill(String(A.expected_qty - 1));
  await page.waitForTimeout(300);
  await (await countField(B.name)).fill(String(B.expected_qty + 2));
  await page.waitForTimeout(300);
  await save();
  await toast(page);
  await page.waitForTimeout(2500);
  await clearToasts(page);
  await goto(page, `/counts/${SNAP}`);
  await page.waitForTimeout(3500);
  t = await T();
  check(/Variances: 1 shortage\(s\), 1 overage\(s\)/.test(t), "variance card title",
    (t.match(/Variances:[^\n]*/) || ["absent"])[0]);
  check((await page.getByRole("button", { name: /Send 1 shortage\(s\) to approval queue/ }).count()) > 0,
    "Send button names the shortage count");
  // per-row badges, found via each part's own row
  await page.getByLabel("Find an item to count").fill(A.name);
  await page.waitForTimeout(1200);
  check(/-1/.test(await T()), "shortage row shows a negative variance badge",
    ((await T()).match(/-\d+/) || ["absent"])[0]);
  await page.getByLabel("Find an item to count").fill(B.name);
  await page.waitForTimeout(1200);
  check(/\+2/.test(await T()), "overage row shows a '+N' badge",
    ((await T()).match(/\+\d+/) || ["absent"])[0]);
  await page.getByLabel("Find an item to count").fill("");
  await page.waitForTimeout(1000);
  await shot(page, "task12-step4-variances");

  // Send must be hidden when there are NO shortages — clear A back to a match
  await (await countField(A.name)).fill(String(A.expected_qty));
  await page.waitForTimeout(300);
  await save();
  await toast(page);
  await page.waitForTimeout(2500);
  await clearToasts(page);
  await goto(page, `/counts/${SNAP}`);
  await page.waitForTimeout(3500);
  check((await page.getByRole("button", { name: /to approval queue/ }).count()) === 0,
    "❌ Send button is absent when shortages = 0");
  check(/Variances: 0 shortage\(s\), 1 overage\(s\)/.test(await T()),
    "variance card still reports the overage",
    ((await T()).match(/Variances:[^\n]*/) || ["absent"])[0]);
  // restore the shortage for Step 5
  await (await countField(A.name)).fill(String(A.expected_qty - 1));
  await page.waitForTimeout(300);
  await save();
  await toast(page);
  await page.waitForTimeout(2500);
  await clearToasts(page);

  // ── Step 5: send shortages to the queue (NOT approved) ────────────────────
  step("Step 5: send shortages to the approval queue");
  await goto(page, `/counts/${SNAP}`);
  await page.waitForTimeout(3500);
  await page.getByRole("button", { name: /to approval queue/ }).first().click();
  await page.waitForTimeout(1000);
  check(/Send 1 shortage\(s\) to the approval queue\?/.test(await T()),
    "confirm dialog names the count");
  await page.getByRole("button", { name: "Send to queue", exact: true }).click();
  const tSend = await toast(page);
  check(/1 loss\(es\) sent to the approval queue/.test(tSend),
    "toast 'N loss(es) sent to the approval queue'", tSend);
  await page.waitForTimeout(3000);
  await clearToasts(page);

  await goto(page, `/counts/${SNAP}`);
  await page.waitForTimeout(3500);
  await page.getByLabel("Find an item to count").fill(A.name);
  await page.waitForTimeout(1200);
  check(/Sent to queue/.test(await T()), "the sent row badges 'Sent to queue'");

  // it arrived as a PENDING loss, valued and reason-coded — verified in the DB
  const loss = (await q(`count_snapshot_lines?select=shortage_loss_id&id=eq.${A.id}`))[0];
  check(!!loss.shortage_loss_id, "the line records its shortage_loss_id (idempotency)");
  const lossRow = (await q(`losses?select=id,status,qty,reason,shop_id,part_id&id=eq.${loss.shortage_loss_id}`))[0];
  check(lossRow.status === "pending", "the loss landed as PENDING (not auto-approved)", lossRow.status);
  check(lossRow.qty === 1, "loss qty equals the shortage", String(lossRow.qty));
  check(lossRow.part_id === A.part_id, "loss points at the short part");
  check(lossRow.shop_id === snap.shop_id, "loss is booked at the counted shop");
  console.log("  NOT approving it: that is an Approval Queue action (Task 8, the");
  console.log("  other agent's) and it books an irreversible stock movement.");

  // sending twice must not double-create
  await goto(page, `/counts/${SNAP}`);
  await page.waitForTimeout(3500);
  const sendAgain = await page.getByRole("button", { name: /to approval queue/ }).count();
  check(sendAgain === 0, "❌ Send is gone once the shortage is queued (idempotent)",
    `${sendAgain} button(s)`);

  // ── Step 6: list columns ──────────────────────────────────────────────────
  step("Step 6: list columns");
  await goto(page, "/counts");
  await page.waitForTimeout(3500);
  t = await T();
  for (const col of ["Shop", "Variances", "Sent to queue"]) {
    check(new RegExp(col, "i").test(t), `column present: ${col}`);
  }
  check(/1 flagged|flagged/.test(t), "Variances cell renders 'N flagged'",
    (t.match(/\d+ flagged/) || ["absent"])[0]);
  check(/1 losses|\d+ losses/.test(t), "Sent-to-queue cell renders 'N losses'",
    (t.match(/\d+ losses/) || ["absent"])[0]);
  await shot(page, "task12-step6-list");
  console.log(`\n  fixture left: count sheet "${NOTE}" on ${SHOP} + 1 PENDING loss`);
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task12-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
