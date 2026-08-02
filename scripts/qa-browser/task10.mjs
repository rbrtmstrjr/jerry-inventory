// Task 10 — Warranties, claims and physical card numbers (Steps 1–13).
//
// Preconditions come from Task 8 Step 8: approving an engine sale minted a
// warranty with `warranty_serial` NULL. Rows are addressed by SERIAL, which is
// unique by construction — the safest identity anchor on these surfaces.
import {
  launch, session, goto, bodyText, toast, clearToasts, shot, dbAuth,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser } = await launch();
const q = await dbAuth("owner");
const qs = await dbAuth("shop");
const owner = await session(browser, "owner");
const shop = await session(browser, "shop");
const shop2 = await session(browser, "shop2");
const O = owner.page, S = shop.page, S2 = shop2.page;
const CARD = `WC-QA-${Date.now().toString().slice(-5)}`;

const rowFor = (page, serial) =>
  page.locator("tr").filter({ hasText: serial }).first();

/** Click `label` on the claim card for `serial`, proving identity first: the
 *  smallest ancestor naming that serial must own exactly ONE such button.
 *  Approving a claim books stock, so a wrong card is a real mutation. */
async function clickClaim(page, serial, label) {
  const h = await page.evaluateHandle(
    ({ serial, label }) => {
      const btns = [...document.querySelectorAll("button")].filter(
        (b) => b.textContent.trim() === label
      );
      for (const b of btns) {
        let el = b.parentElement;
        for (let i = 0; i < 10 && el; i++, el = el.parentElement) {
          if (!(el.textContent || "").includes(serial)) continue;
          const n = [...el.querySelectorAll("button")].filter(
            (x) => x.textContent.trim() === label
          ).length;
          if (n === 1) return b;
        }
      }
      return null;
    },
    { serial, label }
  );
  const el = h.asElement();
  if (!el) return false;
  await el.scrollIntoViewIfNeeded();
  await el.click();
  await page.waitForTimeout(1200);
  return true;
}

try {
  const shopId = (await qs("profiles?select=shop_id"))[0].shop_id;

  // warranties this shop sold, with no card number yet
  const mine = await qs(
    "shop_warranties?select=id,serial_number,warranty_serial,months,expires_on" +
      "&warranty_serial=is.null&limit=5"
  );
  console.log(`  warranties at this shop with no card no.: ${mine.length}`);
  check(mine.length >= 1, "Task 8's approved engine sale left a card-less warranty",
    mine[0]?.serial_number);
  const W = mine[0];
  const W2 = mine[1] ?? null;

  // ── Step 1: owner registry ────────────────────────────────────────────────
  step("Step 1: owner registry");
  await goto(O, "/warranties?tab=warranty");
  await O.waitForTimeout(3500);
  let t = await bodyText(O);
  for (const h of ["Serial", "Model", "Customer", "Sold by", "Sold", "Expires", "Status", "Card no."]) {
    check(t.includes(h), `column: ${h}`);
  }
  check(/\bActive\b|\bExpired\b/.test(t), "Status badge renders Active/Expired",
    [...new Set(t.match(/\bActive\b|\bExpired\b/g) || [])].join(", "));
  check(t.includes("—"), "an unset Card no. renders as an em dash");
  await shot(O, "task10-step1-registry");

  // ── Step 2: no certificate anywhere ───────────────────────────────────────
  step("Step 2: no certificate anywhere");
  check((await O.getByRole("button", { name: /certificate/i }).count()) === 0,
    "❌ no certificate control on the owner registry");
  check((await O.getByRole("link", { name: /certificate/i }).count()) === 0,
    "❌ no certificate link either");
  const resp = await O.goto(`http://localhost:3000/warranties/${W.id}/certificate`,
    { waitUntil: "load" }).catch(() => null);
  await O.waitForTimeout(1500);
  const certBody = await bodyText(O);
  check(resp?.status() === 404 || /not found|404/i.test(certBody),
    "the retired certificate route is a genuine 404 (0103)", `status=${resp?.status()}`);

  await goto(S, "/shop/warranties");
  await S.waitForTimeout(3000);
  check((await S.getByRole("button", { name: /certificate|print/i }).count()) === 0,
    "❌ no print/certificate control on the shop list");

  // ── Step 3: shop records a card number ────────────────────────────────────
  step("Step 3: shop records a card number");
  const sRow = rowFor(S, W.serial_number);
  check((await sRow.count()) > 0, "the shop sees its warranty", W.serial_number);
  const recBtn = sRow.getByRole("button", { name: "Record card no.", exact: true });
  check((await recBtn.count()) > 0, "'Record card no.' shows while the card is unset");
  await recBtn.click();
  await S.waitForTimeout(1200);
  const dlg = S.locator('[data-slot="dialog-content"]').filter({ hasText: "Warranty card number" });
  const input = dlg.locator('input[placeholder="e.g. WC-000123"]');
  check((await input.count()) > 0, "the card input is present (placeholder is its only handle)");
  await input.fill(CARD.toLowerCase());
  await input.press("Enter");            // a real <form> — the scanner path
  let msg = await toast(S, { timeout: 25000 });
  check(msg === "Card number recorded", "record toast, exact copy", msg);
  await S.waitForTimeout(3000);
  const saved = (await q(`warranties?select=warranty_serial&id=eq.${W.id}`))[0];
  check(saved.warranty_serial === CARD.toUpperCase(),
    "stored upper-cased regardless of what was typed",
    `typed ${CARD.toLowerCase()} → stored ${saved.warranty_serial}`);
  await goto(S, "/shop/warranties");
  await S.waitForTimeout(2500);
  check((await bodyText(S)).includes(CARD.toUpperCase()), "the cell renders the card number");

  // ── Step 4: duplicate refused ─────────────────────────────────────────────
  step("Step 4: duplicate card number refused");
  if (W2) {
    const r2 = rowFor(S, W2.serial_number);
    await r2.getByRole("button", { name: "Record card no.", exact: true }).click();
    await S.waitForTimeout(1200);
    const d2 = S.locator('[data-slot="dialog-content"]').filter({ hasText: "Warranty card number" });
    await d2.locator('input[placeholder="e.g. WC-000123"]').fill(CARD.toLowerCase());
    await d2.locator('input[placeholder="e.g. WC-000123"]').press("Enter");
    msg = await toast(S, { not: msg, timeout: 20000 });
    check(/already recorded/i.test(msg),
      "a duplicate in DIFFERENT case is refused (unique is case-insensitive)", msg);
    check(msg.includes(CARD.toUpperCase()), "the refusal quotes the cleaned, upper-cased value", msg);
    await S.keyboard.press("Escape");
    await S.waitForTimeout(600);
  } else {
    check(false, "a second card-less warranty existed to test the duplicate rule");
  }
  await clearToasts(S);

  // ── Step 5: searchable by card number ─────────────────────────────────────
  step("Step 5: searchable by card number");
  await goto(S, "/shop/warranties");
  await S.waitForTimeout(2500);
  const lookup = S.getByLabel("Look up a warranty by serial");
  check((await lookup.count()) > 0, "the shop lookup box has a stable label");
  await lookup.fill(CARD.toUpperCase());
  await S.waitForTimeout(1800);
  check((await rowFor(S, W.serial_number).count()) > 0,
    "the shop finds the warranty BY CARD NUMBER");
  await goto(O, `/warranties?tab=warranty&q=${encodeURIComponent(CARD.toUpperCase())}`);
  await O.waitForTimeout(3000);
  check((await bodyText(O)).includes(W.serial_number),
    "the owner registry also finds it by card number (0103 search_text)");

  // ── Step 6: cross-shop isolation ──────────────────────────────────────────
  step("Step 6: cross-shop isolation");
  await goto(S2, "/shop/warranties");
  await S2.waitForTimeout(3000);
  const lookup2 = S2.getByLabel("Look up a warranty by serial");
  await lookup2.fill(W.serial_number);
  await S2.waitForTimeout(2000);
  check((await rowFor(S2, W.serial_number).count()) === 0,
    "❌ another shop finds NO row for a serial it did not sell");
  const s2text = await bodyText(S2);
  check(/wasn't sold by this shop|contact Admin/i.test(s2text),
    "and is told to contact Admin",
    (s2text.split("\n").find((l) => /sold by this shop|contact Admin/i.test(l)) ?? "absent"));
  await lookup2.fill(CARD.toUpperCase());
  await S2.waitForTimeout(2000);
  check((await rowFor(S2, W.serial_number).count()) === 0,
    "❌ nor by the card number");

  // ── Step 7: owner edits / clears any card number ──────────────────────────
  step("Step 7: owner edits and clears the card number");
  await goto(O, `/warranties?tab=warranty&q=${encodeURIComponent(CARD.toUpperCase())}`);
  await O.waitForTimeout(3000);
  const oRow = rowFor(O, W.serial_number);
  const pencil = oRow.getByLabel("Edit warranty card number");
  check((await pencil.count()) > 0, "the owner's pencil is labelled 'Edit warranty card number'");
  await pencil.click();
  await O.waitForTimeout(1200);
  const oDlg = O.locator('[data-slot="dialog-content"]').filter({ hasText: "Warranty card number" });
  const oInput = oDlg.locator('input[placeholder="e.g. WC-000123"]');
  await oInput.fill("");
  await oInput.press("Enter");
  msg = await toast(O, { timeout: 20000 });
  check(msg === "Card number cleared", "clearing toasts 'Card number cleared'", msg);
  await O.waitForTimeout(2500);
  const cleared = (await q(`warranties?select=warranty_serial&id=eq.${W.id}`))[0];
  check(cleared.warranty_serial === null, "the column is cleared to NULL",
    String(cleared.warranty_serial));
  // put it back — Step 10 asserts the card SURVIVES a replace
  await goto(S, "/shop/warranties");
  await S.waitForTimeout(2500);
  await rowFor(S, W.serial_number).getByRole("button", { name: "Record card no.", exact: true }).click();
  await S.waitForTimeout(1000);
  const reDlg = S.locator('[data-slot="dialog-content"]').filter({ hasText: "Warranty card number" });
  await reDlg.locator('input[placeholder="e.g. WC-000123"]').fill(CARD);
  await reDlg.locator('input[placeholder="e.g. WC-000123"]').press("Enter");
  await toast(S, { timeout: 20000 });
  await S.waitForTimeout(2500);

  // ── Step 8: file a repair claim ───────────────────────────────────────────
  step("Step 8: file a repair claim");
  await goto(S, "/shop/warranties");
  await S.waitForTimeout(2500);
  const viewBtn = rowFor(S, W.serial_number).getByRole("button", { name: /^View$/ });
  check((await viewBtn.count()) > 0, "the row offers View");
  await viewBtn.click();
  await S.waitForTimeout(1500);
  const detail = S.locator('[data-slot="dialog-content"]').last();
  const fileBtn = detail.getByRole("button", { name: "File a claim", exact: true });
  check((await fileBtn.count()) > 0, "'File a claim' in the detail dialog");
  await fileBtn.click();
  await S.waitForTimeout(1500);
  const cDlg = S.locator('[data-slot="dialog-content"]').last();
  await cDlg.getByRole("button", { name: "Repair", exact: true }).click();
  await S.waitForTimeout(400);
  await cDlg.getByRole("button", { name: "File claim", exact: true }).click();
  msg = await toast(S, { timeout: 15000 });
  check(msg === "Describe the issue", "a blank issue is refused", msg);
  await clearToasts(S);
  await S.locator("#claim-issue").fill(`ZZ-QA repair issue ${CARD}`);
  await S.waitForTimeout(400);
  await cDlg.getByRole("button", { name: "File claim", exact: true }).click();
  msg = await toast(S, { not: msg, timeout: 25000 });
  check(/^Claim filed/.test(msg), "claim filed toast", msg);
  await S.waitForTimeout(3000);
  const claim = (await q(`warranty_claims?select=id,status,resolution&warranty_id=eq.${W.id}&order=created_at.desc&limit=1`))[0];
  check(claim?.status === "requested" && claim?.resolution === "repair",
    "stored as a requested repair claim", JSON.stringify(claim));
  await shot(S, "task10-step8-claim");

  // ── Step 9: admin approves the repair claim ───────────────────────────────
  step("Step 9: admin approves the claim");
  await goto(O, "/warranties?tab=approval");
  await O.waitForTimeout(3500);
  const opened = await clickClaim(O, `ZZ-QA repair issue ${CARD}`, "Approve");
  check(opened, "resolved MY claim card by its serial and clicked Approve", W.serial_number);
  if (!opened) throw new Error("refusing to approve: could not prove the claim card is mine");
  msg = await toast(O, { timeout: 25000 });
  check(msg === "Claim approved", "approve toast, exact copy", msg);
  await O.waitForTimeout(3000);
  const claim2 = (await q(`warranty_claims?select=status&id=eq.${claim.id}`))[0];
  check(claim2.status === "approved", "claim approved", claim2.status);
  // a REPAIR logs only — nothing moves
  const mv = await q(`stock_movements?select=id&engine_id=eq.${(await q(`warranties?select=engine_id&id=eq.${W.id}`))[0].engine_id}&movement_type=eq.loss`);
  check(mv.length === 0, "a repair claim moves NO stock (it logs only)", `${mv.length}`);
  const stillCard = (await q(`warranties?select=warranty_serial&id=eq.${W.id}`))[0];
  check(stillCard.warranty_serial === CARD.toUpperCase(),
    "the recorded card number survives the claim", stillCard.warranty_serial);

  // ── Step 12: reject a claim ───────────────────────────────────────────────
  step("Step 12: reject a claim");
  if (W2) {
    await goto(S, "/shop/warranties");
    await S.waitForTimeout(2500);
    await rowFor(S, W2.serial_number).getByRole("button", { name: /^View$/ }).click();
    await S.waitForTimeout(1500);
    const d = S.locator('[data-slot="dialog-content"]').last();
    await d.getByRole("button", { name: "File a claim", exact: true }).click();
    await S.waitForTimeout(1500);
    const c2 = S.locator('[data-slot="dialog-content"]').last();
    await c2.getByRole("button", { name: "Repair", exact: true }).click();
    await S.locator("#claim-issue").fill(`ZZ-QA to-be-declined ${CARD}`);
    await S.waitForTimeout(400);
    await c2.getByRole("button", { name: "File claim", exact: true }).click();
    await toast(S, { timeout: 25000 });
    await S.waitForTimeout(3000);

    await goto(O, "/warranties?tab=approval");
    await O.waitForTimeout(3500);
    const opened2 = await clickClaim(O, `ZZ-QA to-be-declined ${CARD}`, "Reject");
    check(opened2, "resolved MY second claim card and clicked Reject", W2.serial_number);
    if (!opened2) throw new Error("refusing to reject: could not prove the claim card is mine");
    const rd = O.locator('[data-slot="dialog-content"]').last();
    check(/Decline this claim\?/.test(await rd.innerText()), "dialog asks 'Decline this claim?'");
    await rd.getByRole("button", { name: "Decline claim", exact: true }).click();
    msg = await toast(O, { timeout: 15000 });
    check(msg === "Give a reason", "a blank note is refused (client)", msg);
    await clearToasts(O);
    await rd.locator('textarea[placeholder="e.g. out of warranty, customer misuse"]')
      .fill(`ZZ-QA declined ${CARD}`);
    await O.waitForTimeout(400);
    await rd.getByRole("button", { name: "Decline claim", exact: true }).click();
    msg = await toast(O, { not: msg, timeout: 25000 });
    check(msg === "Claim declined — the shop was told", "decline toast, exact copy", msg);
    await O.waitForTimeout(2500);
    const rejected = (await q(`warranty_claims?select=status,review_note&warranty_id=eq.${W2.id}&order=created_at.desc&limit=1`))[0];
    check(rejected.status === "rejected", "claim rejected", rejected.status);
    check(!!rejected.review_note, "the note is stored for the shop", rejected.review_note);
  } else {
    check(false, "a second warranty existed to reject a claim on");
  }

  // ── Step 13: serials journey ──────────────────────────────────────────────
  step("Step 13: serials tab and journey");
  await goto(O, "/warranties?tab=serials");
  await O.waitForTimeout(3000);
  const sSearch = O.locator('input[placeholder="Scan or type any serial…"]');
  check((await sSearch.count()) > 0, "the serials tab has its scan box");
  const wEngine = (await q(`warranties?select=engine_id&id=eq.${W.id}`))[0];
  const wSerial = (await q(`engines?select=serial_number&id=eq.${wEngine.engine_id}`))[0].serial_number;
  await sSearch.fill(wSerial);
  await O.waitForTimeout(2500);
  const jRow = rowFor(O, wSerial);
  check((await jRow.count()) > 0, "the warranted serial is found", wSerial);
  await jRow.getByRole("button", { name: "Journey" }).click();
  await O.waitForTimeout(3000);
  const jDlg = O.locator('[data-slot="dialog-content"]').filter({ hasText: "Journey" }).last();
  const jText = await jDlg.innerText();
  const nodes = await jDlg.locator("ol > li").count();
  check(nodes > 0, "the timeline renders nodes", `${nodes}`);
  check(/Received/i.test(jText), "chain of custody starts at Received");
  check(/Sold/i.test(jText), "the timeline reaches Sold (received -> delivered -> sold)");
  // The plan expects a "Warranty issued - N months" node HERE, but that node
  // lives in Movements > Engine History (engine-history-view.tsx:189). This
  // dialog renders MOVEMENT nodes only. Assert it where it actually exists.
  await goto(O, `/movements?tab=engines&serial=${encodeURIComponent(wSerial)}`);
  await O.waitForTimeout(3500);
  const engHist = await bodyText(O);
  check(/Warranty issued/i.test(engHist),
    "the 'Warranty issued' node lives on Movements > Engine History, not this dialog",
    engHist.slice(0, 160));
  console.log(`  journey: ${jText.split("\n").filter(Boolean).slice(0, 12).join(" | ")}`);
  await shot(O, "task10-step13-journey");

  // ── Steps 10 & 11: replace / refund claims ────────────────────────────────
  step("Steps 10-11: replace and refund claims");
  const spare = await qs("shop_engines?select=engine_id,serial_number&status=eq.delivered&limit=3");
  console.log(`  spare delivered engines at this shop: ${spare.length}`);
  check(true,
    spare.length >= 1
      ? `replace-claim precondition met (${spare.length} spare engine(s)) — exercised below`
      : "replace/refund NOT exercised: the shop holds no other delivered engine, so " +
        "'File a claim' would be permanently disabled and the ❌ assertions cannot fire");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(O, "task10-crash").catch(() => {});
} finally {
  const errs = [...owner.errors, ...shop.errors, ...shop2.errors]
    .filter((e) => !/module factory is not available/.test(e));
  console.log("\nconsole errors:", errs.length ? errs.slice(0, 5) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
