// Task 4 (Suppliers → Receiving), write half: Steps 10–12, 14–17.
// Saves real rows in STAGING; everything is prefixed ZZ-QA for later sweeping.
//
// Success is a "Stock received" DIALOG, not a toast — asserting on a toast here
// reports failure for a receiving that saved perfectly.
import {
  launch, login, goto, bodyText, toast, clearToasts, pickSelect, shot, dbAuth,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const STAMP = process.env.QA_STAMP || String(Date.now()).slice(-6);
const q = await dbAuth("admin");

async function openForm() {
  await goto(page, "/suppliers?tab=receiving");
  await page.getByRole("button", { name: "New Receiving" }).click();
  await page.waitForTimeout(700);
}
async function pickSupplier(name) {
  await pickSelect(page, 0, name);
  await page.waitForTimeout(2500);
}
async function addPart(nth, qty, cost) {
  await page.getByRole("button", { name: "Add part" }).click();
  await page.waitForTimeout(400);
  await page.locator('button[role="combobox"]').filter({ hasText: "Pick item" }).first().click();
  await page.waitForTimeout(600);
  const items = page.locator("[cmdk-item]");
  const name = (await items.nth(nth).innerText()).split("\n")[0].trim();
  await items.nth(nth).click();
  await page.waitForTimeout(600);
  const qb = page.getByLabel("Quantity");
  await qb.nth((await qb.count()) - 1).fill(String(qty));
  const cb = page.getByLabel("Unit cost in pesos");
  await cb.nth((await cb.count()) - 1).fill(String(cost));
  await page.waitForTimeout(400);
  return name;
}
async function setStatus(label) {
  await page.locator('button[role="combobox"]')
    .filter({ hasText: /^(Paid in full|Partially paid|Unpaid \(on credit\))$/ }).first().click();
  await page.waitForTimeout(300);
  await page.getByRole("option", { name: label, exact: true }).first().click();
  await page.waitForTimeout(600);
}
/** Click Receive stock, then RACE the success dialog against a refusal toast.
 *  Waiting for the dialog first burns the toast's lifetime and reports a
 *  refusal as silence. */
async function submit(prevToast = "") {
  await page.getByRole("button", { name: "Receive stock" }).click();
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    if (await page.getByRole("heading", { name: "Stock received" }).isVisible().catch(() => false))
      return { saved: true, msg: "" };
    const msgs = await page.locator("[data-sonner-toast]").allTextContents();
    const m = msgs.join(" | ").trim();
    if (m && m !== prevToast) return { saved: false, msg: m };
    await page.waitForTimeout(150);
  }
  return { saved: false, msg: "" };
}

try {
  await login(page, "admin");

  // ── Step 11: partial-payment validation ───────────────────────────────────
  step("Step 11: partial payment validation");
  await openForm();
  await pickSupplier("Motorcentral");
  await addPart(1, 2, "100.00");
  await setStatus("Partially paid");
  check(/Receiving total/.test(await T()), "live Receiving total");

  await page.locator("#rcv-paid").fill("200"); // == total
  await page.waitForTimeout(400);
  let r = await submit("");
  check(r.msg.includes("A partial payment must be less than the total — use Paid in full"),
    "amount == total refused", r.msg);
  await clearToasts(page);

  await page.locator("#rcv-paid").fill("0");
  r = await submit(r.msg);
  check(r.msg.includes("Enter how much you paid"), "amount 0 refused", r.msg);
  await clearToasts(page);

  await page.locator("#rcv-paid").fill("50");
  await page.waitForTimeout(700);
  let flat = (await T()).replace(/\s+/g, " ");
  check(/Balance:\s*₱150\.00/.test(flat), "live Balance: ₱150.00");
  check(/This adds ₱150\.00 to what you owe Motorcentral\./.test(flat),
    "debt caption names the supplier");

  // ── Step 12: due date required ────────────────────────────────────────────
  step("Step 12: due date is required when not paid in full");
  r = await submit(r.msg);
  check(r.msg.includes("Pick a due date — use the presets or the calendar"),
    "missing due date refused", r.msg);
  await clearToasts(page);
  const dueBefore = await page.locator("#rcv-due").innerText().catch(() => "");
  await page.getByRole("button", { name: "3 months", exact: true }).click();
  await page.waitForTimeout(600);
  const dueAfter = await page.locator("#rcv-due").innerText().catch(() => "");
  check(dueAfter && dueAfter !== dueBefore, "'3 months' preset fills the DatePicker",
    `${dueBefore} → ${dueAfter}`);
  check(/usually gives net-\d+ — but the date you pick here is the one that counts\./.test(await T()),
    "helper references the supplier's net-N terms");

  // ── Step 14: credit-limit override ────────────────────────────────────────
  step("Step 14: credit-limit override");
  flat = (await T()).replace(/\s+/g, " ");
  check(/→ after this ₱[\d,\.]+ of ₱[\d,\.]+ limit/.test(flat),
    "banner projects the post-receiving balance against the limit");
  check(/This will put .+ at ₱[\d,\.]+ against a ₱[\d,\.]+ limit\./.test(flat),
    "banner spells out the overage in words");
  check((await page.locator("#rcv-override").count()) > 0,
    "'Reason for going over' textarea is present");
  check(await page.evaluate(() =>
    [...document.querySelectorAll("div")].some((d) =>
      /This will put/.test(d.textContent || "") &&
      d.querySelector("svg.lucide-triangle-alert, svg.lucide-alert-triangle"))),
    "banner carries the AlertTriangle icon");
  await shot(page, "task4-step14-override");

  r = await submit(r.msg);
  check(r.msg.includes("This exceeds the credit limit — give a reason to proceed"),
    "blank override reason refused", r.msg);
  await clearToasts(page);

  // ── Step 15: atomicity ────────────────────────────────────────────────────
  step("Step 15: atomicity (2 existing parts + inline-new part + engine, partial)");
  const REASON = `ZZ-QA ${STAMP} over-limit reason`;
  const NOTE = `ZZ-QA Task4 atomicity ${STAMP}`;
  const NEWNAME = `ZZ-QA Widget ${STAMP}`;
  const SERIAL = `ZZQA${STAMP}`;
  await page.locator("#rcv-override").fill(REASON);
  await addPart(2, 3, "150.00");

  await page.getByRole("button", { name: "Add part" }).click();
  await page.waitForTimeout(400);
  await page.locator('button[role="combobox"]').filter({ hasText: "Pick item" }).first().click();
  await page.waitForTimeout(600);
  await page.locator("[cmdk-item]").filter({ hasText: "New product" }).first().click();
  await page.waitForTimeout(700);
  await page.locator("#np-name").fill(NEWNAME);
  await page.locator("#np-price").fill("250");
  await page.getByRole("button", { name: "Add to receiving" }).click();
  await page.waitForTimeout(700);
  flat = await T();
  check(flat.includes(NEWNAME), "inline-new part appears on a line");
  check(/New product — created with this receiving/.test(flat), "NEW line caption");
  check((await page.locator("text=NEW").count()) > 0, "line shows a NEW badge");
  let qb = page.getByLabel("Quantity");
  await qb.nth((await qb.count()) - 1).fill("4");
  let cb = page.getByLabel("Unit cost in pesos");
  await cb.nth((await cb.count()) - 1).fill("120.00");

  await page.getByRole("button", { name: "Add engine" }).click();
  await page.waitForTimeout(500);
  await page.getByLabel("Serial number").last().fill(SERIAL);
  await page.locator('button[role="combobox"]').filter({ hasText: "Pick a model" }).first().click();
  await page.waitForTimeout(500);
  const opts = page.getByRole("option");
  for (let i = 0, n = await opts.count(); i < n; i++) {
    const txt = (await opts.nth(i).innerText()).trim();
    if (!/New model/.test(txt)) { await opts.nth(i).click(); break; }
  }
  await page.waitForTimeout(600);
  await page.getByLabel("Cost in pesos").last().fill("5000.00");
  await page.getByLabel("Price in pesos").last().fill("7000.00");
  await page.locator("#rcv-paid").fill("100");
  await page.locator("#rcv-note").fill(NOTE);
  await page.waitForTimeout(600);

  r = await submit(r.msg);
  check(r.saved, "receiving saved — 'Stock received' dialog", r.msg);
  const dlgText = r.saved ? await page.locator('[role="dialog"]').last().innerText() : "";
  check(/4 lines · ₱[\d,\.]+ into master inventory/.test(dlgText.replace(/\s+/g, " ")),
    "dialog summarises 4 lines + total", dlgText.split("\n").slice(0, 3).join(" ⏎ "));
  check(/including 1 new product: ZZ-QA Widget/.test(dlgText.replace(/\s+/g, " ")),
    "dialog names the new product", dlgText.split("\n").slice(0, 3).join(" ⏎ "));

  // ── Step 16: post-save print labels ───────────────────────────────────────
  step("Step 16: post-save print labels");
  const link = page.locator('a[href*="/master-inventory/labels"]').first();
  check((await link.count()) > 0, "print-labels link offered");
  const href = (await link.count()) ? await link.getAttribute("href") : "";
  check(/^\/master-inventory\/labels\?ids=[0-9a-f-]{36}/.test(href || ""),
    "routes to /master-inventory/labels?ids=<new part id>", href);
  const target = (await link.count()) ? await link.getAttribute("target") : "";
  check(target === "_blank", "opens in a new tab", target);

  // ── Step 15 verification, from the database ───────────────────────────────
  step("Step 15: persisted state (read back from the database)");
  const recs = await q(`receivings?select=id,note,total_amount,amount_paid,payment_status,limit_override,limit_override_reason,due_date&note=eq.${encodeURIComponent(NOTE)}`);
  check(recs.length === 1, "exactly ONE receiving row", `${recs.length} rows`);
  const rec = recs[0] || {};
  const lines = rec.id ? await q(`receiving_lines?select=id,part_id,engine_id,qty,unit_cost_centavos&receiving_id=eq.${rec.id}`) : [];
  check(lines.length === 4, "all 4 lines saved", `${lines.length} lines`);
  check(lines.filter((l) => l.part_id).length === 3, "3 part lines");
  check(lines.filter((l) => l.engine_id).length === 1, "1 engine line");
  const expTotal = 2 * 10000 + 3 * 15000 + 4 * 12000 + 500000;
  check(rec.total_amount === expTotal, "total = Σ(qty × unit cost)",
    `${rec.total_amount} vs ${expTotal}`);
  check(rec.amount_paid === 10000 && rec.payment_status === "partial",
    "payment recorded as partial ₱100.00", `${rec.amount_paid}/${rec.payment_status}`);
  check(rec.limit_override === true && rec.limit_override_reason === REASON,
    "override + reason recorded on the receiving",
    `${rec.limit_override} / ${rec.limit_override_reason}`);
  check(!!rec.due_date, "due date stored", String(rec.due_date));

  const balRows = rec.id ? await q(`receiving_balances?select=balance,overdue&receiving_id=eq.${rec.id}`) : [];
  const bal = balRows[0]?.balance;
  check(bal === expTotal - 10000, "payable balance = total − paid", `${bal}`);

  const np = await q(`parts?select=id,name,cost_centavos,price_centavos&name=eq.${encodeURIComponent(NEWNAME)}`);
  check(np.length === 1, "the inline-new part exists in the catalog");
  check(np[0]?.cost_centavos === 12000 && np[0]?.price_centavos === 25000,
    "new part carries the line's cost and the entered price",
    `${np[0]?.cost_centavos}/${np[0]?.price_centavos}`);
  const sl = np[0] ? await q(`stock_levels?select=qty&part_id=eq.${np[0].id}&shop_id=is.null`) : [];
  check(sl[0]?.qty === 4, "master stock for the new part = 4", JSON.stringify(sl));
  const eng = await q(`engines?select=id,serial_number,status&serial_number=eq.${SERIAL}`);
  check(eng.length === 1 && eng[0].status === "in_master",
    "engine created in master with its serial", JSON.stringify(eng));

  // ── Step 17: detail dialog and ?view= deep link ───────────────────────────
  step("Step 17: detail dialog and ?view= deep link");
  await goto(page, "/suppliers?tab=receiving");
  await page.locator("tr").filter({ hasText: NOTE }).first()
    .getByRole("button", { name: /View/ }).click();
  await page.waitForTimeout(2500);
  const detail = await page.locator('[role="dialog"]').last().innerText();
  check(/Engine/.test(detail), "engine line carries an Engine badge");
  // rendered as two flex-separated spans ("4 lines" | "Total cost: ₱X"),
  // not the plan's literal "N line(s) · Total cost: ₱X"
  const flatDetail = detail.replace(/\s+/g, " ");
  check(/\b4 lines\b/.test(flatDetail) && /Total cost: ₱[\d,\.]+/.test(flatDetail),
    "footer shows the line count and total cost",
    (detail.match(/Total cost[^\n]*/) || ["absent"])[0]);
  await shot(page, "task4-step17-detail");
  await page.keyboard.press("Escape");

  // the deep link is an INBOUND entry point (e.g. from Suppliers & Prices),
  // so drive it by URL rather than expecting View to push history
  await goto(page, `/suppliers?tab=receiving&view=${rec.id}`);
  await page.waitForTimeout(2000);
  check((await page.locator('[role="dialog"]').count()) > 0,
    "?view=<id> opens the detail dialog directly");
  check((await bodyText(page)).includes(NOTE), "the deep-linked dialog shows that receiving");

  // ── Step 10: paid in full ─────────────────────────────────────────────────
  step("Step 10: paid in full");
  const NOTE2 = `ZZ-QA Task4 paidfull ${STAMP}`;
  await openForm();
  await pickSupplier("Cavite Marine Supply");
  await addPart(1, 1, "75.00");
  await setStatus("Paid in full");
  check(!/Pick a due date/.test(await T()), "no due date demanded for paid-in-full");
  check((await page.locator("#rcv-ref").getAttribute("placeholder")) === "Optional",
    "Reference no. placeholder is 'Optional' for Cash");
  await page.locator("#rcv-note").fill(NOTE2);
  r = await submit(r.msg);
  check(r.saved, "paid-in-full receiving saved", r.msg);
  const r2 = await q(`receivings?select=payment_status,total_amount,amount_paid,due_date&note=eq.${encodeURIComponent(NOTE2)}`);
  check(r2[0]?.payment_status === "paid" && r2[0]?.amount_paid === r2[0]?.total_amount,
    "stored as fully paid", JSON.stringify(r2[0]));
  check(!r2[0]?.due_date, "no due date stored for paid-in-full", String(r2[0]?.due_date));
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task4b-crash").catch(() => {});
} finally {
  console.log("\nSTAMP:", STAMP);
  console.log("console errors:", errors.length ? errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
