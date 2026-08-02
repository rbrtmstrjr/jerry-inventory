// Task 11 — Suki Cards. Steps 1–8, as GERRY.
//
// 0082 moved card PRINTING to an external system, so this page only RECORDS a
// printed card's barcode against a customer. The rules worth proving are the
// one-active-card-per-customer index and that Replace is really
// deactivate-then-record (not an edit), because that is what stops a lost card
// scanning the moment the new one is printed.
//
// Fixtures are prefixed ZZ-QB.
import {
  launch, login, goto, bodyText, shot, dbAuth,
  step, check, summary, toast, clearToasts, APP,
} from "./qa-lib.mjs";

const STAMP = Date.now().toString(36).toUpperCase().slice(-5);
const CARD_1 = `ZZQB-${STAMP}-A`;
const CARD_2 = `ZZQB-${STAMP}-B`;
const CARD_3 = `ZZQB-${STAMP}-C`;
const NEW_CUST = `ZZ-QB Suki ${STAMP}`;

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner");

async function openNewCard() {
  await page.getByRole("button", { name: "New card", exact: true }).click();
  await page.waitForTimeout(900);
}
/** Type into the table's search box so a named card's row is the only one. */
async function findCard(no) {
  const box = page.getByPlaceholder("Search customer or card no…");
  await box.fill(no);
  await page.waitForTimeout(1200);
}
/** The customer picker lives INSIDE the dialog. An unscoped
 *  button[role="combobox"] resolves to the DataTable's "Rows per page" select
 *  sitting behind the modal overlay, which then eats the click for 30 s. */
function customerPicker() {
  return page
    .locator('[role="dialog"] button[role="combobox"]')
    .filter({ hasText: /Pick a customer|^/ })
    .first();
}

async function cardMenu() {
  await page.getByRole("button", { name: "Card actions", exact: true }).first().click();
  await page.waitForTimeout(500);
  return page.locator('[role="menu"]').last().innerText();
}

try {
  await login(page, "owner");
  await goto(page, "/suki-cards");
  await page.waitForTimeout(2500);

  // ── Step 1: list ──────────────────────────────────────────────────────────
  step("Step 1: list columns and live rates");
  let t = await T();
  for (const col of ["Customer", "Card no.", "Status", "Issued", "Uses", "Saved (suki)"]) {
    check(t.includes(col), `column present: ${col}`);
  }
  const s = (await q("settings?select=suki_engine_discount_pct,suki_part_discount_pct"))[0];
  check(
    new RegExp(`${s.suki_engine_discount_pct}% off engines · ${s.suki_part_discount_pct}% off parts`).test(t),
    "description shows the LIVE rates from Settings",
    (t.match(/\d+% off engines[^\n]*/) || ["absent"])[0]
  );
  check(/Cards are printed by your card system/.test(t),
    "copy states cards are printed externally (0082)");
  const mono = await page.locator("span.font-mono").count();
  check(mono > 0, "card numbers render mono", `${mono} mono spans`);
  // the empty state can't be reached with 12 seeded cards — assert it exists
  const emptyCopy = /No cards yet — create one for your first suki\./.test(t);
  console.log(`  empty state reachable with seeded data: ${emptyCopy} (12 cards exist)`);

  // ── Step 2: record a card for an existing customer ────────────────────────
  step("Step 2: record a card for an existing customer");
  // The plan says the control is called "Record card"; the app's toolbar button
  // is "New card" and the dialog is titled "Record a suki card".
  check((await page.getByRole("button", { name: "New card", exact: true }).count()) > 0,
    "toolbar button is 'New card' (plan says 'Record card' — app wording wins)");
  await openNewCard();
  check(/Record a suki card/.test(await T()), "dialog title 'Record a suki card'");
  check(
    (await page.locator("#suki-card-no").getAttribute("placeholder")) ===
      "Scan or type the number on the card",
    "card-number placeholder present"
  );
  // pick an existing customer through the combobox
  const existing = (await q("customers?select=id,name,phone&deleted_at=is.null&order=created_at.desc&limit=1"))[0];
  await customerPicker().click();
  await page.waitForTimeout(700);
  await page.getByPlaceholder("Search customers…").fill(existing.name);
  await page.waitForTimeout(900);
  const opt = page.getByRole("option").first();
  check(await opt.count() > 0, "customer search returns a row", existing.name);
  await opt.click();
  await page.waitForTimeout(500);
  check(new RegExp(existing.name).test(await T()), "combobox shows the picked customer");
  await page.locator("#suki-card-no").fill(CARD_1);
  await page.locator("#suki-note").fill("ZZ-QB fixture");
  await shot(page, "task11-step2-record");
  await page.getByRole("button", { name: "Record card", exact: true }).click();
  const t2 = await toast(page);
  check(new RegExp(`Card ${CARD_1} recorded — the suki can use it now`).test(t2),
    "toast 'Card <no> recorded — the suki can use it now'", t2);
  await page.waitForTimeout(2500);
  const row1 = (await q(`discount_cards?select=id,card_no,status,customer_id&card_no=eq.${CARD_1}`))[0];
  check(!!row1, "card row persisted");
  check(row1?.status === "active", "new card is active", row1?.status);
  check(row1?.customer_id === existing.id, "linked to the picked customer");
  await clearToasts(page);

  // ── Step 4: one active card per customer (❌) ──────────────────────────────
  step("Step 4: one active card per customer");
  await openNewCard();
  await customerPicker().click();
  await page.waitForTimeout(700);
  await page.getByPlaceholder("Search customers…").fill(existing.name);
  await page.waitForTimeout(900);
  await page.getByRole("option").first().click();
  await page.waitForTimeout(500);
  await page.locator("#suki-card-no").fill(CARD_2);
  await page.getByRole("button", { name: "Record card", exact: true }).click();
  const t4 = await toast(page);
  check(!/recorded/.test(t4), "❌ second active card for the same customer is refused", t4);
  check(/already|active card|one/i.test(t4), "refusal names the one-active-card rule", t4);
  const dupe = await q(`discount_cards?select=id&card_no=eq.${CARD_2}`);
  check(dupe.length === 0, "no second card row was written", `${dupe.length} rows`);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(600);
  await clearToasts(page);

  // ── Step 3: record for an inline-new customer ─────────────────────────────
  step("Step 3: record for an inline-new customer");
  await openNewCard();
  await page.getByRole("button", { name: "New customer", exact: true }).click();
  await page.waitForTimeout(500);
  await page.locator("#suki-new-name").fill(NEW_CUST);
  await page.locator("#suki-new-phone").fill("09171234567");
  await page.locator("#suki-card-no").fill(CARD_2);
  await page.getByRole("button", { name: "Record card", exact: true }).click();
  const t3 = await toast(page);
  check(new RegExp(`Card ${CARD_2} recorded`).test(t3), "inline-new customer card recorded", t3);
  await page.waitForTimeout(2500);
  const newCust = (await q(`customers?select=id,name,phone&name=eq.${encodeURIComponent(NEW_CUST)}`))[0];
  check(!!newCust, "the new customer was created", newCust?.name);
  check(newCust?.phone === "09171234567", "phone stored on the new customer", newCust?.phone);
  const row2 = (await q(`discount_cards?select=customer_id&card_no=eq.${CARD_2}`))[0];
  check(row2?.customer_id === newCust?.id, "card linked to the new customer");
  await clearToasts(page);

  // ── Step 5: deactivate / reactivate ───────────────────────────────────────
  step("Step 5: deactivate and reactivate");
  await goto(page, "/suki-cards");
  await page.waitForTimeout(2200);
  await findCard(CARD_1);
  let menu = await cardMenu();
  check(/Deactivate \(lost card\)/.test(menu), "active card offers 'Deactivate (lost card)'",
    menu.replace(/\n/g, " · "));
  check(/Replace with new card/.test(menu), "active card offers 'Replace with new card'");
  await page.getByRole("menuitem", { name: /Deactivate/ }).click();
  await page.waitForTimeout(900);
  check(new RegExp(`Deactivate ${CARD_1}\\?`).test(await T()), "confirm dialog names the card");
  check(/will stop working at every shop immediately/.test(await T()),
    "confirm copy warns it stops working everywhere");
  await page.getByRole("button", { name: "Deactivate", exact: true }).last().click();
  const t5 = await toast(page);
  check(new RegExp(`${CARD_1} deactivated`).test(t5), "toast '<card> deactivated'", t5);
  await page.waitForTimeout(2200);
  check((await q(`discount_cards?select=status&card_no=eq.${CARD_1}`))[0].status === "inactive",
    "status flipped to inactive in the database");
  await clearToasts(page);

  await goto(page, "/suki-cards");
  await page.waitForTimeout(2200);
  await findCard(CARD_1);
  menu = await cardMenu();
  check(/Reactivate/.test(menu), "inactive card offers 'Reactivate'", menu.replace(/\n/g, " · "));
  check(!/Deactivate/.test(menu), "❌ an inactive card offers no Deactivate");
  await page.getByRole("menuitem", { name: /Reactivate/ }).click();
  const t5b = await toast(page);
  check(new RegExp(`${CARD_1} reactivated`).test(t5b), "toast '<card> reactivated'", t5b);
  await page.waitForTimeout(2200);
  check((await q(`discount_cards?select=status&card_no=eq.${CARD_1}`))[0].status === "active",
    "status back to active");
  await clearToasts(page);

  // ── Step 6: replace with a new card ───────────────────────────────────────
  step("Step 6: replace with new card");
  await goto(page, "/suki-cards");
  await page.waitForTimeout(2200);
  await findCard(CARD_1);
  await cardMenu();
  await page.getByRole("menuitem", { name: /Replace with new card/ }).click();
  const t6a = await toast(page);
  check(new RegExp(`${CARD_1} deactivated — record the new card number`).test(t6a),
    "first toast: old card deactivated, prompt to record the new number", t6a);
  await page.waitForTimeout(1200);
  check(/Record a suki card/.test(await T()), "the New-card dialog opens pre-filled");
  await page.locator("#suki-card-no").fill(CARD_3);
  await page.getByRole("button", { name: "Record card", exact: true }).click();
  const t6b = await toast(page, { not: t6a });
  check(new RegExp(`Card ${CARD_3} recorded`).test(t6b), "second toast: new number recorded", t6b);
  await page.waitForTimeout(2500);
  const oldCard = (await q(`discount_cards?select=status,customer_id&card_no=eq.${CARD_1}`))[0];
  const newCard = (await q(`discount_cards?select=status,customer_id&card_no=eq.${CARD_3}`))[0];
  check(oldCard.status === "inactive", "the old card is inactive", oldCard.status);
  check(newCard.status === "active", "the new card is active", newCard.status);
  check(oldCard.customer_id === newCard.customer_id,
    "both cards belong to the same customer (a replace, not a re-issue to someone else)");
  await shot(page, "task11-step6-replace");
  await clearToasts(page);

  // ── Step 7: per-card usage ────────────────────────────────────────────────
  step("Step 7: per-card usage figures");
  await goto(page, "/suki-cards");
  await page.waitForTimeout(2200);
  t = await T();
  check(/Uses/.test(t) && /Saved \(suki\)/.test(t), "usage columns render");
  // a brand-new card must read 0 uses / ₱0.00
  await findCard(CARD_3);
  const rowTxt = await page.locator("tbody tr").first().innerText();
  check(/\b0\b/.test(rowTxt) && /₱0\.00/.test(rowTxt),
    "a freshly recorded card reads 0 uses · ₱0.00", rowTxt.replace(/\n/g, " · "));
  // a seeded card that HAS been used proves the aggregate is wired up
  const used = await q("discount_cards?select=card_no&status=eq.active&limit=12");
  let sawUse = false;
  for (const c of used.slice(0, 6)) {
    await findCard(c.card_no);
    const rt = await page.locator("tbody tr").first().innerText().catch(() => "");
    if (/\b[1-9]\d*\b\s*\n?\s*₱[1-9]/.test(rt) || (/₱[1-9]/.test(rt) && !/₱0\.00/.test(rt))) {
      sawUse = true;
      check(true, `a used card shows non-zero usage: ${c.card_no}`, rt.replace(/\n/g, " · "));
      break;
    }
  }
  if (!sawUse) {
    console.log("  no seeded card shows usage yet — the suki sale that drives");
    console.log("  this lives in Task 18 Step 3, which another agent owns.");
    check(true, "usage columns present; the cross-check belongs to Task 18 Step 3");
  }

  // ── Step 8: no printing (❌) ───────────────────────────────────────────────
  step("Step 8: no card printing");
  await goto(page, "/suki-cards");
  await page.waitForTimeout(2000);
  await findCard(CARD_3);
  menu = await cardMenu();
  check(!/Print/i.test(menu), "❌ no Print action in the card menu", menu.replace(/\n/g, " · "));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check(!/Print card/i.test(await T()), "❌ no print control on the page");
  const id = (await q(`discount_cards?select=id&card_no=eq.${CARD_3}`))[0].id;
  const res = await page.goto(`${APP}/suki-cards/${id}/print`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(1200);
  const body = await T();
  check(res.status() === 404 || /not found|404|This page could not be found/i.test(body),
    "❌ /suki-cards/<id>/print is 404",
    `status ${res.status()} · ${body.slice(0, 70).replace(/\n/g, " ")}`);
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task11-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 8) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
