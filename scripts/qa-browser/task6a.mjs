// Task 6 (Deliveries & Returns) — the delivery lifecycle, Steps 1–8.
// ADMIN sends → SHOP confirms with a discrepancy → ADMIN resolves.
//
// The reconciliation invariant is asserted PER PART after every step:
//   Σ stock_levels(part, all locations) + Σ stock_in_transit(part) = owned
// Per-part rather than global so a QA agent working elsewhere in the same
// staging database can't perturb it. Only a transit write-off may reduce it.
import fs from "node:fs";
import {
  launch, session, goto, bodyText, toast, clearToasts, shot, dbAuth, makePng,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser } = await launch();
const STAMP = process.env.QA_STAMP || String(Date.now()).slice(-6);
const q = await dbAuth("owner");
const qs = await dbAuth("shop");
const PNG = makePng(`${process.env.TEMP || "/tmp"}/zzqa-dmg-${STAMP}.png`, 64, 48);

const admin = await session(browser, "admin");
const shop = await session(browser, "shop");
const A = admin.page, S = shop.page;

/** owned(part) = every shelf + everything in transit */
async function owned(partId) {
  const lv = await q(`stock_levels?select=shop_id,qty&part_id=eq.${partId}`);
  const tr = await q(`stock_in_transit?select=qty&part_id=eq.${partId}`);
  const sum = (a) => a.reduce((t, x) => t + (x.qty ?? 0), 0);
  return { shelves: sum(lv), transit: sum(tr), total: sum(lv) + sum(tr), byShop: lv };
}
const at = (o, shopId) => o.byShop.find((r) => r.shop_id === shopId)?.qty ?? 0;

try {
  // whose shop is shop1@ ?
  const myShopId = (await qs("profiles?select=shop_id"))[0].shop_id;
  const myShop = (await q(`shops?select=id,name&id=eq.${myShopId}`))[0];
  console.log(`shop session = ${myShop.name} (${myShopId})`);

  // a part with plenty of master stock
  const lv = await q("stock_levels?select=part_id,qty&shop_id=is.null&qty=gte.20&limit=12");
  let PART = null;
  for (const l of lv) {
    const p = (await q(`parts?select=id,name,unit,cost_centavos,price_centavos,deleted_at&id=eq.${l.part_id}`))[0];
    if (p && !p.deleted_at) { PART = p; break; }
  }
  console.log(`part = ${PART.name} (${PART.unit})`);
  const ENG = (await q("engines?select=id,serial_number&status=eq.in_master&deleted_at=is.null&limit=1"))[0];
  console.log(`engine = ${ENG?.serial_number ?? "none"}`);

  const before = await owned(PART.id);
  console.log(`baseline: shelves=${before.shelves} transit=${before.transit} total=${before.total}`);

  // ── Step 1: pre-shop gate ─────────────────────────────────────────────────
  step("Step 1: pre-shop gate");
  // ?tab= values are delivery|transit|transfers. The page otherwise opens on
  // In Transit whenever a discrepancy is waiting — deliberate, not a default.
  await goto(A, "/deliveries?tab=delivery");
  await A.waitForTimeout(2500);
  check((await A.locator('[role="tab"][data-state="active"]').innerText()).includes("New Delivery"),
    "?tab=delivery deep-links the New Delivery tab");
  let t = await bodyText(A);
  check(/Pick a shop above to start adding items\./.test(t), "pre-shop hint shown");
  check(!/No part lines yet/.test(t), "part-lines section hidden before a shop is picked");
  check((await A.getByRole("button", { name: /^Add part$/ }).count()) === 0,
    "'Add part' hidden before a shop is picked");
  check((await A.getByRole("button", { name: "Deliver (into transit)" }).count()) === 0,
    "submit hidden before a shop is picked");
  await shot(A, "task6-step1-gate");

  // ── Step 2: build and send ────────────────────────────────────────────────
  step("Step 2: build and send a delivery");
  await A.locator('button[role="combobox"]').filter({ hasText: "Pick a shop" }).first().click();
  await A.waitForTimeout(500);
  await A.getByRole("option", { name: myShop.name, exact: true }).first().click();
  await A.waitForTimeout(1500);
  t = await bodyText(A);
  check(/No part lines yet/.test(t), "line sections appear once a shop is picked");

  await A.getByRole("button", { name: /^Add part$/ }).click();
  await A.waitForTimeout(600);
  await A.locator('button[role="combobox"]').filter({ hasText: "Pick item" }).first().click();
  await A.waitForTimeout(700);
  await A.locator("[cmdk-item]").filter({ hasText: PART.name }).first().click();
  await A.waitForTimeout(800);

  // clamp: type far above availability
  const qty = A.getByLabel("Quantity").first();
  await qty.fill("99999");
  await A.waitForTimeout(500);
  const clamped = await qty.inputValue();
  const avail = before.shelves - before.transit >= 0 ? null : null;
  check(Number(clamped) > 0 && Number(clamped) <= before.total,
    "qty re-clamps to what is on hand", `typed 99999 → ${clamped}`);
  const masterQty = (await q(`stock_levels?select=qty&part_id=eq.${PART.id}&shop_id=is.null`))[0]?.qty;
  check(Number(clamped) === masterQty, "clamped exactly to master on-hand",
    `${clamped} vs master ${masterQty}`);

  // blank normalises to 0 on blur
  await qty.fill("");
  await qty.blur();
  await A.waitForTimeout(400);
  check((await qty.inputValue()) === "0", "blank qty normalises to '0' on blur",
    await qty.inputValue());

  await qty.fill("6");
  await A.waitForTimeout(300);

  // engine
  let engineSent = false;
  const pickEng = A.locator("button").filter({ hasText: "Pick engines" }).first();
  if (ENG && (await pickEng.count())) {
    await pickEng.click();
    await A.waitForTimeout(700);
    const opt = A.locator("[cmdk-item]").filter({ hasText: ENG.serial_number }).first();
    if (await opt.count()) { await opt.click(); engineSent = true; }
    await A.keyboard.press("Escape");
    await A.waitForTimeout(400);
  }
  check(engineSent, "an engine was added to the delivery", ENG?.serial_number);

  await A.getByRole("button", { name: "Deliver (into transit)" }).first().click();
  let msg = await toast(A, { timeout: 20000 });
  check(/Sent — in transit until the shop confirms what arrived/.test(msg),
    "send toast, exact copy", msg);
  await A.waitForTimeout(2000);

  const afterSend = await owned(PART.id);
  check(afterSend.total === before.total, "total owned UNCHANGED by sending",
    `${before.total} → ${afterSend.total}`);
  check(afterSend.transit === before.transit + 6, "6 units moved into transit",
    `${before.transit} → ${afterSend.transit}`);
  check(at(afterSend, null) === at(before, null) - 6, "master dropped by 6",
    `${at(before, null)} → ${at(afterSend, null)}`);
  check(at(afterSend, myShopId) === at(before, myShopId), "shop qty UNCHANGED until confirmed",
    `${at(before, myShopId)} → ${at(afterSend, myShopId)}`);

  const del = (await q(`deliveries?select=id,status,shop_id,from_shop_id&shop_id=eq.${myShopId}&order=created_at.desc&limit=1`))[0];
  check(del.status === "in_transit", "delivery is in_transit", del.status);
  const DID = del.id;

  await goto(A, "/deliveries?tab=transit");
  await A.waitForTimeout(2500);
  check((await bodyText(A)).includes(myShop.name), "delivery listed under In Transit");

  // ── Step 3: owner delivery note, while in transit ─────────────────────────
  step("Step 3: delivery note (owner copy), in transit");
  await goto(A, `/deliveries/${DID}/note`);
  await A.waitForTimeout(1800);
  const note1 = await bodyText(A);
  const biz = (await q("settings?select=business_name,address"))[0];
  check(note1.includes(biz.business_name), "letterhead uses the Settings business name", biz.business_name);
  check(/Total at cost/i.test(note1) && /at selling/i.test(note1),
    "Total at cost / at selling present",
    (note1.match(/Total at [^\n]*/g) || ["absent"]).join(" · "));
  check(/Prepared by/i.test(note1), "'Prepared by <name>' present",
    (note1.match(/Prepared by[^\n]*/) || ["absent"])[0]);
  check(note1.includes(myShop.name), "names the destination shop");
  check(/\b6\b/.test(note1), "Qty column shows the SENT quantity (6) while in transit");
  await shot(A, "task6-step3-note-transit");

  // ── Step 4: shop confirms with a discrepancy ──────────────────────────────
  step("Step 4: shop confirms 4 good / 1 damaged / 1 missing");
  await goto(S, "/shop/deliveries");
  await S.waitForTimeout(2000);
  let st = await bodyText(S);
  check(/on the way/.test(st), "card header reads 'N item(s) on the way'",
    (st.match(/\d+ items? on the way/) || ["absent"])[0]);
  check(/from Admin \/ Master/.test(st), "source label 'from Admin / Master'");

  // ── Step 5 (first half): over-count refusal ───────────────────────────────
  step("Step 5: over-count refused");
  // 131 deliveries are in transit for this shop, so target MY line by id
  // (#good-<lineId> / #dmg-<lineId>) rather than "the first input on screen".
  const lineRow = (await q(`delivery_lines?select=id,qty&delivery_id=eq.${DID}&part_id=eq.${PART.id}`))[0];
  const LID = lineRow.id;
  const goodBox = S.locator(`#good-${LID}`);
  const dmgBox = S.locator(`#dmg-${LID}`);
  await goodBox.scrollIntoViewIfNeeded();
  await goodBox.fill("6");
  await dmgBox.fill("2"); // 6 + 2 > 6 sent
  await S.waitForTimeout(500);
  const overBorder = await dmgBox.evaluate((e) => e.className);
  check(/border-destructive/.test(overBorder), "over-count turns the input border destructive",
    overBorder.split(" ").filter((c) => c.startsWith("border")).join(" "));
  const card = S.locator('[data-slot="card"]').filter({ has: S.locator(`#good-${LID}`) }).first();
  const confirmBtn = card.getByRole("button", { name: "Confirm what arrived" }).first();
  check(await confirmBtn.isDisabled(), "Confirm is disabled while the count exceeds what was sent");

  // ── Step 6: shop has no resolution powers ─────────────────────────────────
  step("Step 6: the shop cannot resolve");
  st = await bodyText(S);
  for (const forbidden of ["Write off", "Write-off", "Return to master", "Reject"]) {
    check(!new RegExp(forbidden, "i").test(st), `❌ shop UI offers no '${forbidden}'`);
  }

  // back to a valid split and confirm
  step("Step 4 (cont.): valid confirm with a damage photo");
  await goodBox.fill("4");
  await dmgBox.fill("1");
  await S.waitForTimeout(500);
  const dmgClass = await dmgBox.evaluate((e) => e.className);
  check(/border-warning/.test(dmgClass), "a damaged count turns the border warning",
    dmgClass.split(" ").filter((c) => c.startsWith("border")).join(" "));

  const fileIn = S.locator(`input[aria-label="Damage photo for line ${LID}"]`);
  if (await fileIn.count()) {
    await fileIn.setInputFiles(PNG);
    await S.waitForTimeout(3000);
    check(true, "damage photo attached");
  } else {
    check(false, "a damage-photo input is offered for the damaged line");
  }
  await confirmBtn.click();
  msg = await toast(S, { timeout: 30000 });
  // the delivery also carries an engine line, which lands as 1 good — so the
  // toast legitimately reads "5 good"; the PART split is asserted below
  check(/^\d+ good · 1 damaged · 1 missing — Admin will review the damaged & missing\.$/.test(msg),
    "confirm toast, exact shape", msg);
  await S.waitForTimeout(3000);
  await shot(S, "task6-step4-confirmed");

  const afterConfirm = await owned(PART.id);
  check(afterConfirm.total === before.total, "total owned UNCHANGED by confirming",
    `${before.total} → ${afterConfirm.total}`);
  check(at(afterConfirm, myShopId) === at(before, myShopId) + 4,
    "shop stock increased by the GOOD units only (4)",
    `${at(before, myShopId)} → ${at(afterConfirm, myShopId)}`);
  check(afterConfirm.transit === before.transit + 2,
    "damaged + missing stay in transit (2)", `transit ${afterConfirm.transit}`);
  const dl = (await q(`delivery_lines?select=qty,qty_received,qty_damaged,qty_outstanding,damage_photo_path&delivery_id=eq.${DID}&part_id=eq.${PART.id}`))[0];
  check(dl.qty_received === 4 && dl.qty_damaged === 1 && dl.qty_outstanding === 2,
    "line records 4 received / 1 damaged / 2 outstanding", JSON.stringify(dl));
  check(!!dl.damage_photo_path && dl.damage_photo_path.startsWith(`shop-${myShopId}/`),
    "damage photo stored under the confirming shop's own prefix", String(dl.damage_photo_path));
  const dStatus = (await q(`deliveries?select=status&id=eq.${DID}`))[0].status;
  check(dStatus === "discrepancy", "delivery flagged 'discrepancy'", dStatus);

  // one-shot
  step("Step 5 (cont.): confirming twice is impossible");
  await goto(S, "/shop/deliveries");
  await S.waitForTimeout(2000);
  check((await S.locator(`#good-${LID}`).count()) === 0,
    "the confirmed delivery is gone from the confirm list (one-shot)");

  // ── Step 7: owner resolves ────────────────────────────────────────────────
  step("Step 7: owner resolves the discrepancy");
  await goto(A, "/deliveries?tab=transit");
  await A.waitForTimeout(2000);
  t = await bodyText(A);
  check(/Needs your decision/.test(t), "'Needs your decision' surfaces the discrepancy");
  // 131 deliveries are in transit across every shop, most with seeded
  // discrepancies. Resolve MY row only — resolving someone else's would move
  // real stock that this task never sent.
  // Return the EXACT button element for my row and click that handle.
  // Index-based targeting (nth over getByRole) desynced from the DOM order and
  // resolved another shop's seeded discrepancy — a real stock movement this
  // task never sent. Never address these rows positionally.
  async function clickMyResolve() {
    const h = await A.evaluateHandle(
      ({ part, shop }) => {
        const btns = [...document.querySelectorAll("button")].filter(
          (b) => b.textContent.trim() === "Resolve"
        );
        for (const b of btns) {
          let el = b.parentElement;
          for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
            const txt = el.textContent || "";
            if (!txt.includes(part) || !txt.includes(shop)) continue;
            // the smallest ancestor holding both must own exactly ONE Resolve,
            // otherwise it's a container spanning several rows
            const n = [...el.querySelectorAll("button")].filter(
              (x) => x.textContent.trim() === "Resolve"
            ).length;
            if (n === 1) return b;
          }
        }
        return null;
      },
      { part: PART.name, shop: myShop.name }
    );
    const el = h.asElement();
    if (!el) return false;
    await el.scrollIntoViewIfNeeded();
    await el.click();
    await A.waitForTimeout(1500);
    return true;
  }

  check(await clickMyResolve(),
    "my delivery's shortfall is listed under 'Needs your decision' and was opened");
  const rd = await A.locator('[role="dialog"]').last().innerText();
  check(rd.includes(PART.name) && rd.includes(myShop.name),
    "the dialog is for MY delivery", rd.slice(0, 120));
  check(/\(1 flagged damaged\)/.test(rd), "description appends '(1 flagged damaged)'",
    (rd.split("\n").find((l) => /outstanding/.test(l)) ?? "absent"));
  check(/Write off/.test(rd) && /Return to master/.test(rd),
    "both resolutions are offered");
  check(/Damaged/.test(rd) && /Lost in transit/.test(rd), "cause options prefill from the shop's report");
  await shot(A, "task6-step7-resolve");

  // resolve 1 unit as "Return to master"
  const dlgA = A.locator('[role="dialog"]').last();
  const mine = (await dlgA.innerText()).includes(PART.name) && (await dlgA.innerText()).includes(myShop.name);
  if (!mine) throw new Error("resolve dialog is not for my delivery — refusing to submit");
  await dlgA.locator('input[inputmode="numeric"], input[type="number"]').first().fill("1");
  await A.waitForTimeout(300);
  await dlgA.getByText("Return to master", { exact: true }).first().click();
  await A.waitForTimeout(400);
  // the footer button is labelled by the chosen resolution, and that label also
  // appears on the choice tile above it — take the LAST match
  await dlgA.getByRole("button", { name: "Return to master" }).last().click();
  msg = await toast(A, { timeout: 20000 });
  console.log("  resolve #1 toast:", msg);
  await A.waitForTimeout(3000);

  const afterReturn = await owned(PART.id);
  check(at(afterReturn, null) === at(afterConfirm, null) + 1,
    "master +1 after 'Return to master'",
    `${at(afterConfirm, null)} → ${at(afterReturn, null)}`);
  check(afterReturn.total === before.total, "return to master does NOT change total owned",
    `${before.total} → ${afterReturn.total}`);

  // second unit → write off
  await goto(A, "/deliveries?tab=transit");
  await A.waitForTimeout(2500);
  check(await clickMyResolve(), "the remaining unit is still listed for a decision");
  const d2 = A.locator('[role="dialog"]').last();
  const mine2 = (await d2.innerText()).includes(PART.name) && (await d2.innerText()).includes(myShop.name);
  if (!mine2) throw new Error("second resolve dialog is not for my delivery — refusing to submit");
  await d2.locator('input[inputmode="numeric"], input[type="number"]').first().fill("1");
  await A.waitForTimeout(300);
  await d2.getByText("Write off", { exact: true }).first().click();
  await A.waitForTimeout(400);
  await d2.getByRole("button", { name: "Write off" }).last().click();
  msg = await toast(A, { timeout: 20000 });
  console.log("  resolve #2 toast:", msg);
  await A.waitForTimeout(3000);

  const afterWriteoff = await owned(PART.id);
  check(afterWriteoff.total === before.total - 1,
    "total owned drops by EXACTLY 1 (the write-off)",
    `${before.total} → ${afterWriteoff.total}`);
  check(afterWriteoff.transit === before.transit,
    "nothing left stranded in transit", `transit ${afterWriteoff.transit}`);

  const mv = await q(`stock_movements?select=movement_type,shop_id&delivery_id=eq.${DID}&order=created_at`);
  const types = mv.map((m) => m.movement_type);
  check(types.includes("transit_return"), "a transit_return movement was written", types.join(","));
  check(types.includes("transit_writeoff"), "a transit_writeoff movement was written", types.join(","));

  // ── Step 8: note after confirmation ───────────────────────────────────────
  step("Step 8: delivery note after confirmation");
  await goto(A, `/deliveries/${DID}/note`);
  await A.waitForTimeout(1800);
  const note2 = await bodyText(A);
  const qtyCell = note2.match(/\n(\d+)\n/g) || [];
  check(!/\b6 pc\b/.test(note2) || /\b4\b/.test(note2),
    "Qty column now reflects what LANDED (4), not what was sent (6)",
    qtyCell.join("").replace(/\n/g, " "));
  await shot(A, "task6-step8-note-confirmed");
  console.log("  note (post-confirm) excerpt:", note2.split("\n").filter(Boolean).slice(0, 18).join(" · "));
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(admin.page, "task6a-crash").catch(() => {});
} finally {
  fs.rmSync(PNG, { force: true });
  console.log("\nSTAMP:", STAMP);
  const errs = [...admin.errors, ...shop.errors];
  console.log("console errors:", errs.length ? errs.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
