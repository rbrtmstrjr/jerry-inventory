// Task 18 (The Shop app) — Steps 1–7.
//
// Selectors and copy come from the surface map in
// tasks/buildsheet.md (workflow task18-shop-surface-map), not from the QA
// plan's paraphrase — the plan's wording is stale in ~20 places (ASCII dashes
// for em-dashes, "PHP" for ₱, "(s)" plurals that only exist in one toast).
//
// Counts are NEVER hardcoded: another QA agent shares this staging database and
// can add rows at this shop mid-run. Everything is read back from the database
// in the same step that asserts it.
import fs from "node:fs";
import {
  launch, session, goto, bodyText, toast, clearToasts, shot, dbAuth, makePng,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser } = await launch();
const STAMP = process.env.QA_STAMP || String(Date.now()).slice(-6);
const q = await dbAuth("owner");
const qs = await dbAuth("shop");
const PNG = makePng(`${process.env.TEMP || "/tmp"}/zzqa-shop-${STAMP}.png`, 64, 48);

const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
const S = shop.page;
const peso = (c) => `₱${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

try {
  const shopId = (await qs("profiles?select=shop_id"))[0].shop_id;
  const shopRow = (await q(`shops?select=name,location&id=eq.${shopId}`))[0];
  console.log(`shop = ${shopRow.name}`);

  // fixtures with a real margin, so the suki price lands above the cost+1 cap
  const stock = await qs("shop_stock?select=part_id,name,unit,qty,cost_centavos,price_centavos,barcode&qty=gte.4&limit=10");
  const PART = stock.find((s) => Math.round((s.price_centavos * 95) / 100) > s.cost_centavos + 1) ?? stock[0];
  const PART2 = stock.find((s) => s.part_id !== PART.part_id) ?? stock[1];
  // Exclude engines already on an OPEN sale line. fn_record_sale's guard is
  // `sale_lines JOIN sales WHERE status IN (recorded,pending,questioned)`, so
  // ask exactly that through the embed. (Listing the shop's sales first and
  // filtering client-side hits the same 1000-row cap as app bug #8 — the
  // newest sale, the one actually holding the engine, falls outside it.)
  const allEng = await qs("shop_engines?select=engine_id,serial_number,cost_centavos,price_centavos&limit=20");
  const openLines = await q(
    "sale_lines?select=engine_id,sales!inner(status)&engine_id=not.is.null" +
      "&sales.status=in.(recorded,pending,questioned)&limit=1000"
  );
  const usedIds = new Set(openLines.map((l) => l.engine_id));
  const engines = allEng.filter((e) => !usedIds.has(e.engine_id));
  console.log(`engines free of open sales: ${engines.length}/${allEng.length}`);
  console.log(`part = ${PART.name} cost=${PART.cost_centavos} price=${PART.price_centavos}`);
  console.log(`engines = ${engines.map((e) => e.serial_number).join(", ")}`);

  // ── Step 1: My Shop Stock ─────────────────────────────────────────────────
  step("Step 1: My Shop Stock");
  await goto(S, "/shop");
  await S.waitForTimeout(2500);
  let t = await bodyText(S);
  check(/Items in stock/.test(t), "KPI: Items in stock");
  check(/\d+ engine\(s\) on hand/.test(t), "KPI hint uses the literal 'engine(s) on hand'",
    (t.match(/\d+ engine\(s\) on hand/) || ["absent"])[0]);
  check(/Today's recorded sales/.test(t), "KPI: Today's recorded sales");
  check(/Receivables \(utang\)/.test(t), "KPI: Receivables (utang)");

  // first paint is always the table view (a stored preference applies later)
  await S.locator('[aria-label="Table view"][aria-pressed="true"]').waitFor({ timeout: 15000 });
  check(true, "table view is the first paint");
  const panel = S.locator('[data-slot="tabs-content"][data-state="active"]');
  check((await panel.count()) > 0, "only the active tab panel is mounted");

  // card view: parts footer + cost line
  await S.locator('[aria-label="Card view"]').click();
  await S.waitForTimeout(1800);
  t = await bodyText(S);
  check(/^\d+ of \d+ items$/m.test(t), "parts card footer 'N of M items'",
    (t.match(/\d+ of \d+ items/) || ["absent"])[0]);
  check(/Cost ₱[\d,]+\.\d\d/.test(t), "cost shown beneath the selling price (the tawad floor)",
    (t.match(/Cost ₱[\d,.]+/) || ["absent"])[0]);

  // engines tab: pluralised footer, and NO search box (the plan's suspicion)
  await S.getByRole("tab", { name: "Engines" }).click();
  await S.waitForTimeout(1800);
  t = await bodyText(S);
  check(/^\d+ engines? on hand$/m.test(t), "engines card footer is pluralised ('N engines on hand')",
    (t.match(/\d+ engines? on hand/g) || ["absent"]).join(" · "));
  const engSearch = await S.locator('[data-slot="tabs-content"][data-state="active"] [aria-label="Search stock"]').count();
  check(engSearch === 0, "engines CARD grid has no search box (parts grid does) — an inconsistency, logged",
    `${engSearch} search inputs`);

  // search-miss empty state (the stocked shop can never show the no-stock one)
  await S.getByRole("tab", { name: "Parts & Goods" }).click();
  await S.waitForTimeout(1500);
  const cardSearch = S.locator('[aria-label="Search stock"]').first();
  if (await cardSearch.count()) {
    await cardSearch.fill("zzzz-no-such-item");
    await S.waitForTimeout(1500);
    check(/Nothing matches/.test(await bodyText(S)), "search-miss empty state",
      ((await bodyText(S)).match(/Nothing matches[^\n]*/) || ["absent"])[0]);
    await cardSearch.fill("");
    await S.waitForTimeout(1000);
  }
  await shot(S, "task18-step1-stock");

  // ── Step 2: photo dialog ──────────────────────────────────────────────────
  step("Step 2: edit own product photo");
  const photoBtn = S.locator(`[aria-label="Edit photo of ${PART.name}"]`);
  if (!(await photoBtn.count())) {
    await S.locator('[aria-label="Search stock"]').first().fill(PART.name);
    await S.waitForTimeout(1800);
  }
  await photoBtn.first().click();
  await S.waitForTimeout(1200);
  const dlg = S.locator('[data-slot="dialog-content"]');
  check((await dlg.count()) > 0, "photo dialog opens");
  await dlg.locator('input[type="file"]').setInputFiles(PNG);
  await S.waitForTimeout(2500);
  const saveBtn = S.getByRole("button", { name: "Save photo" });
  check(!(await saveBtn.isDisabled()), "'Save photo' enables once a file is staged");
  await saveBtn.click();
  let msg = await toast(S, { timeout: 25000 });
  check(msg === `Photo saved for ${PART.name}`, "save toast names the product", msg);
  await S.waitForTimeout(2500);
  const withImg = (await q(`parts?select=image_path&id=eq.${PART.part_id}`))[0];
  check(!!withImg.image_path, "image_path written", String(withImg.image_path));

  // remove -> undo -> remove
  await S.locator(`[aria-label="Edit photo of ${PART.name}"]`).first().click();
  await S.waitForTimeout(1200);
  await S.getByRole("button", { name: "Remove", exact: true }).click();
  await S.waitForTimeout(500);
  check(/Photo will be removed on save\./.test(await bodyText(S)), "staged-removal notice");
  await S.getByRole("button", { name: "Undo remove" }).click();
  await S.waitForTimeout(500);
  check(!/Photo will be removed on save\./.test(await bodyText(S)), "Undo clears the notice");
  await S.getByRole("button", { name: "Remove", exact: true }).click();
  await S.waitForTimeout(400);
  await S.getByRole("button", { name: "Save photo" }).click();
  msg = await toast(S, { not: msg, timeout: 25000 });
  check(msg === "Photo removed", "remove toast is exactly two words", msg);
  await S.waitForTimeout(2500);
  const cleared = (await q(`parts?select=image_path&id=eq.${PART.part_id}`))[0];
  check(!cleared.image_path, "image_path cleared", String(cleared.image_path));

  // ── Step 3: Record Sale — cash + tawad ────────────────────────────────────
  step("Step 3: Record Sale — cash, with tawad");
  await goto(S, "/shop/record-sale");
  await S.waitForTimeout(2500);
  t = await bodyText(S);
  check(/Scan or tap items on the left to add them\./.test(t), "empty-cart placeholder");
  check(/Saved as your current report\./.test(t), "cart description");

  await S.getByRole("button", { name: new RegExp(`^${PART.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
  await S.waitForTimeout(1200);
  t = await bodyText(S);
  check(/Sale \(1 line\)/.test(t), "cart header 'Sale (1 line)'",
    (t.match(/Sale \(\d+ lines?\)/) || ["absent"])[0]);

  // below cost: the SERVER rule exists, but the UI never lets you submit —
  // Save is disabled and an inline error explains why (plan says "server rejects")
  const priceBox = S.locator(`#part-price-${PART.part_id}`);
  await priceBox.fill(((PART.cost_centavos - 100) / 100).toFixed(2));
  await S.waitForTimeout(800);
  t = await bodyText(S);
  check(new RegExp(`Can't sell at or below cost ${peso(PART.cost_centavos).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(t),
    "below-cost inline error names the floor",
    (t.match(/Can't sell at or below cost[^\n]*/) || ["absent"])[0]);
  check(await S.getByRole("button", { name: "Save sale" }).isDisabled(),
    "'Save sale' is DISABLED below cost (the server raise is unreachable via the UI)");

  await priceBox.fill(((PART.cost_centavos + 100) / 100).toFixed(2));
  await S.waitForTimeout(800);
  check(!(await S.getByRole("button", { name: "Save sale" }).isDisabled()),
    "cost + ₱1 is accepted");

  // payment method: change helper is Cash+Full only
  await S.getByRole("button", { name: "Cash", exact: true }).click();
  await S.waitForTimeout(600);
  check(/Change \(sukli\)|Customer's cash/.test(await bodyText(S)), "Cash shows the change helper");
  await S.getByRole("button", { name: "GCash", exact: true }).click();
  await S.waitForTimeout(600);
  t = await bodyText(S);
  check(!/Change \(sukli\)/.test(t), "GCash hides the change helper");
  check(/Paid in full via GCash/.test(t), "GCash shows its own banner");
  await S.getByRole("button", { name: "Cash", exact: true }).click();
  await S.waitForTimeout(600);

  const autoPrint = S.locator("#auto-print");
  check(await autoPrint.isChecked(), "'Print receipt on save' defaults to checked");
  const salesBefore = (await q(`sales?select=id&shop_id=eq.${shopId}&status=eq.recorded&deleted_at=is.null`)).length;
  // the receipt iframe is transient (self-removes 500ms after afterprint), so
  // latch it as it attaches rather than looking for it afterwards
  const printFrames = [];
  S.on("frameattached", (f) => printFrames.push(f.url()));
  const framePoll = (async () => {
    for (let i = 0; i < 120; i++) {
      const src = await S.evaluate(
        () => document.getElementById("jm-receipt-print-frame")?.getAttribute("src") ?? null
      ).catch(() => null);
      if (src) return src;
      await S.waitForTimeout(50);
    }
    return null;
  })();
  await S.getByRole("button", { name: "Save sale" }).click();
  const frameSrc = await framePoll;
  msg = await toast(S, { not: msg, timeout: 30000 });
  check(/^Sale saved — printing receipt…$/.test(msg), "save toast with em-dash + ellipsis", msg);
  await S.waitForTimeout(3000);
  // the receipt renders in an off-screen iframe with its OWN window, so the
  // counter lives on that frame — and the frame self-removes 500ms after
  // afterprint, so sum across every frame still attached
  check(/\/receipt\//.test(frameSrc ?? "") || printFrames.some((u) => /receipt/.test(u)),
    "an off-screen /receipt/<id> iframe was mounted to print in place",
    `src=${frameSrc} attached=[${printFrames.join(" | ")}]`);
  const salesAfter = await q(`sales?select=id,total_centavos,payment_method,payment_type&shop_id=eq.${shopId}&status=eq.recorded&deleted_at=is.null&order=created_at.desc`);
  check(salesAfter.length === salesBefore + 1, "one sale recorded",
    `${salesBefore} → ${salesAfter.length}`);
  check(salesAfter[0].payment_method === "cash" && salesAfter[0].payment_type === "full",
    "stored as a full cash sale", JSON.stringify(salesAfter[0]));
  const SALE1 = salesAfter[0].id;

  // ── Step 4: suki card ─────────────────────────────────────────────────────
  step("Step 4: Record Sale — suki card");
  const card = (await q("discount_cards?select=id,card_no,customer_id&status=eq.active&deleted_at=is.null&limit=1"))[0];
  const cust = (await q(`customers?select=name&id=eq.${card.customer_id}`))[0];
  const rates = (await q("settings?select=suki_engine_discount_pct,suki_part_discount_pct"))[0];
  await goto(S, "/shop/record-sale");
  await S.waitForTimeout(2500);
  // the suki field lives inside the payment block, which only mounts once the
  // cart has a line — an empty cart renders no card input at all
  await S.getByRole("button", { name: new RegExp(`^${PART2.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
  await S.waitForTimeout(1500);
  await clearToasts(S); // the "<part> added" toast would be read as the next result
  const sukiBox = S.locator('[aria-label="Suki card number"]');
  check((await sukiBox.count()) > 0, "the suki field appears once the cart has a line");
  const applyBtn = S.locator('form:has([aria-label="Suki card number"]) button[type="submit"]');
  check(await applyBtn.isDisabled(), "Apply is disabled while the card box is empty");
  await sukiBox.fill("SC-NOPE-000");
  await S.waitForTimeout(400);
  await applyBtn.click();
  msg = await toast(S, { not: msg, timeout: 20000 });
  check(msg === "No active suki card with that number", "bad card refused", msg);
  await clearToasts(S);

  await sukiBox.fill(card.card_no);
  await S.waitForTimeout(400);
  await applyBtn.click();
  msg = await toast(S, { not: msg, timeout: 25000 });
  check(msg === `Suki: ${cust.name} — ${rates.suki_engine_discount_pct}% off engines, ${rates.suki_part_discount_pct}% off parts`,
    "suki toast names the customer and both rates", msg);
  await S.waitForTimeout(1500);
  const nameLocked = await S.locator("#cust-name").isDisabled();
  const phoneLocked = await S.locator('[aria-label="Customer phone"]').isDisabled();
  check(nameLocked && phoneLocked, "customer name and phone lock while a card is applied");
  check((await S.locator("#cust-name").inputValue()) === cust.name, "customer auto-filled");

  // an item added AFTER applying must come in at the card price
  await S.getByRole("button", { name: new RegExp(`^${PART.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) }).first().click();
  await S.waitForTimeout(1500);
  const expectedMax = Math.max(
    Math.round((PART.price_centavos * (100 - rates.suki_part_discount_pct)) / 100),
    PART.cost_centavos + 1
  );
  const applied = await S.locator(`#part-price-${PART.part_id}`).inputValue();
  check(Math.round(parseFloat(applied) * 100) === expectedMax,
    "a line added AFTER the card comes in at the card price",
    `${applied} vs expected ${(expectedMax / 100).toFixed(2)}`);
  check((await bodyText(S)).includes(`(suki max ${peso(expectedMax)})`),
    "the ceiling is labelled '(suki max ₱X)'");

  // above the card price: refused in the UI (the server clamp is separate)
  await S.locator(`#part-price-${PART.part_id}`).fill(((expectedMax + 5000) / 100).toFixed(2));
  await S.waitForTimeout(800);
  check(/Above the suki price/.test(await bodyText(S)), "above-max inline error",
    ((await bodyText(S)).match(/Above the suki price[^\n]*/) || ["absent"])[0]);
  check(await S.getByRole("button", { name: "Save sale" }).isDisabled(),
    "Save is disabled above the card price (client refuses; the RPC also clamps)");

  await S.locator('[aria-label="Remove suki card"]').click();
  await S.waitForTimeout(1500);
  check((await S.locator("#cust-name").inputValue()) === "", "Clear blanks the customer name");
  check(!(await S.locator("#cust-name").isDisabled()), "Clear unlocks the customer fields");
  const reverted = await S.locator(`#part-price-${PART.part_id}`).inputValue();
  check(Math.round(parseFloat(reverted) * 100) === PART.price_centavos,
    "Clear reverts the line to the catalog price",
    `${reverted} vs ${(PART.price_centavos / 100).toFixed(2)}`);
  await shot(S, "task18-step4-suki");

  // ── Step 5: utang / partial ───────────────────────────────────────────────
  step("Step 5: Record Sale — utang (partial payment)");
  await S.getByRole("button", { name: "Partial (downpayment)", exact: true }).click();
  await S.waitForTimeout(800);
  await S.locator("#downpayment").fill("100");
  await S.waitForTimeout(500);
  await S.getByRole("button", { name: "Save sale" }).click();
  msg = await toast(S, { not: msg, timeout: 20000 });
  check(/Partial payment needs the customer's name/.test(msg),
    "partial with no customer is refused", msg);
  await clearToasts(S);

  await S.locator("#cust-name").fill(`ZZ-QA Utang ${STAMP}`);
  await S.waitForTimeout(400);
  check(/Balance due/.test(await bodyText(S)), "live 'Balance due' readout");
  await S.getByRole("button", { name: "Save sale" }).click();
  msg = await toast(S, { not: msg, timeout: 30000 });
  check(/^Sale saved/.test(msg), "partial sale saved", msg);
  await S.waitForTimeout(3000);
  const partial = (await q(`sales?select=id,payment_type,amount_paid_centavos,total_centavos&shop_id=eq.${shopId}&payment_type=eq.partial&status=eq.recorded&deleted_at=is.null&order=created_at.desc&limit=1`))[0];
  check(!!partial && partial.amount_paid_centavos === 10000,
    "stored as partial with a ₱100.00 downpayment", JSON.stringify(partial));

  // the receipt says Downpayment, not Paid
  await goto(S, `/receipt/${partial.id}`);
  await S.waitForTimeout(2500);
  const rc = await bodyText(S);
  check(/Downpayment via/.test(rc), "receipt prints 'Downpayment via <method>'",
    (rc.match(/Downpayment via[^\n]*/) || ["absent"])[0]);
  check(/Balance due/.test(rc), "receipt prints the balance");
  check((await S.content()).includes("58mm"), "58 mm thermal marker present in the page CSS");
  check(rc.includes(shopRow.name), "receipt names the branch");
  await shot(S, "task18-step5-receipt");

  // ── Step 6: engine ────────────────────────────────────────────────────────
  step("Step 6: Record Sale — engine");
  await goto(S, "/shop/record-sale");
  await S.waitForTimeout(2500);
  const ENG = engines[0];
  const scan = S.locator('input[placeholder="Scan barcode or serial, then Enter…"]');
  await scan.fill(ENG.serial_number);
  await scan.press("Enter");
  msg = await toast(S, { not: msg, timeout: 15000 });
  check(msg === `Engine ${ENG.serial_number} added`, "engine added by scan", msg);
  await S.waitForTimeout(1000);
  check(/Engine/.test(await bodyText(S)), "Engine badge on the line");
  await clearToasts(S);

  // scanning the SAME serial again: one honest message, not a contradictory pair
  await scan.fill(ENG.serial_number);
  await scan.press("Enter");
  await S.waitForTimeout(2000);
  const toasts = await S.locator("[data-sonner-toast]").allTextContents();
  check(toasts.some((x) => x.includes("That engine is already in the sale")),
    "duplicate serial explains itself", toasts.join(" | "));
  check(!toasts.some((x) => x.includes("added")),
    "and does NOT also claim it was added (bug fixed this run)", toasts.join(" | "));
  await clearToasts(S);

  // an engine sale requires a customer — the warranty is registered against them
  await S.getByRole("button", { name: "Save sale" }).click();
  msg = await toast(S, { timeout: 15000 });
  check(/Engine sales need the customer's name \(for the warranty\)/.test(msg),
    "an engine sale with no customer is refused", msg);
  await clearToasts(S);
  await S.locator("#cust-name").fill(`ZZ-QA Engine ${STAMP}`);
  await S.waitForTimeout(500);
  await S.getByRole("button", { name: "Save sale" }).click();
  msg = await toast(S, { timeout: 30000 });
  check(/^Sale saved/.test(msg), "engine sale saved once a customer is named", msg);
  await S.waitForTimeout(3000);
  const focused = await S.evaluate(() => {
    const a = document.activeElement;
    return a ? `${a.tagName}${a.id ? "#" + a.id : ""}[${a.getAttribute("placeholder") ?? a.getAttribute("aria-label") ?? ""}]` : "none";
  });
  check(/Scan barcode or serial/.test(focused), "the scan input is re-focused after save", focused);
  check((await S.locator("#cust-name").count()) === 0 || (await S.locator("#cust-name").inputValue()) === "",
    "customer field reset after save");

  // ── Step 7: Record Loss ───────────────────────────────────────────────────
  step("Step 7: Record Loss");
  await goto(S, "/shop/record-loss");
  await S.waitForTimeout(2500);
  t = await bodyText(S);
  check(/What was lost\?/.test(t), "card title 'What was lost?'");

  await S.getByRole("button", { name: "Save loss report" }).click().catch(async () => {
    await S.getByRole("button", { name: /Save|Record/ }).first().click();
  });
  msg = await toast(S, { not: msg, timeout: 15000 });
  check(msg === "Pick an item", "no item is refused", msg);
  await clearToasts(S);

  const picker = S.locator('[data-slot="popover-trigger"][role="combobox"]').first();
  await picker.click();
  await S.waitForTimeout(800);
  await S.locator('input[placeholder="Search…"]').fill(PART2.name);
  await S.waitForTimeout(1000);
  await S.getByRole("option").first().click();
  await S.waitForTimeout(800);

  await S.locator("#loss-qty").fill("0");
  await S.waitForTimeout(300);
  await S.getByRole("button", { name: /Save loss report|Save|Record/ }).first().click();
  msg = await toast(S, { not: msg, timeout: 15000 });
  check(msg === "Quantity must be positive", "qty 0 is refused", msg);
  await clearToasts(S);

  await S.locator("#loss-qty").fill(String(PART2.qty + 50));
  await S.waitForTimeout(300);
  await S.getByRole("button", { name: /Save loss report|Save|Record/ }).first().click();
  msg = await toast(S, { not: msg, timeout: 15000 });
  check(/^Only \d+ .* on hand$/.test(msg), "over on-hand is refused with the real figure", msg);
  await clearToasts(S);

  await S.locator("#loss-qty").fill("1");
  await S.locator("#loss-note").fill(`ZZ-QA loss ${STAMP}`);
  await S.waitForTimeout(400);
  const reasonBefore = await S.locator('[data-slot="select-trigger"]').first().innerText();
  await S.getByRole("button", { name: /Save loss report|Save|Record/ }).first().click();
  msg = await toast(S, { not: msg, timeout: 25000 });
  check(/^Loss saved/.test(msg), "loss saved", msg);
  await S.waitForTimeout(2500);
  const loss = (await q(`losses?select=id,status,qty&shop_id=eq.${shopId}&status=eq.recorded&deleted_at=is.null&order=created_at.desc&limit=1`))[0];
  check(loss?.status === "recorded", "saved with status 'recorded'", loss?.status);
  const reasonAfter = await S.locator('[data-slot="select-trigger"]').first().innerText();
  check(reasonAfter === reasonBefore, "the reason selection is RETAINED after save",
    `${reasonBefore} → ${reasonAfter}`);
  check((await S.locator("#loss-note").inputValue()) === "", "the note IS cleared");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(S, "task18a-crash").catch(() => {});
} finally {
  fs.rmSync(PNG, { force: true });
  console.log("\nSTAMP:", STAMP);
  console.log("console errors:", shop.errors.length ? shop.errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
