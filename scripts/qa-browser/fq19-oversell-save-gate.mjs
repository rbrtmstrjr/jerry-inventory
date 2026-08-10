// FQ19 — the cart quantity box must be HARD-CAPPED at what is available, on
// every keystroke.
//
// The bug (production, 2026-08-10): the box accepted any number and only
// corrected it on blur, so it displayed 6568 kg against 2.1 available with a
// P656,800 total. Worse, pressing Save blurred the box first, so the clamp and
// the save landed in one gesture: the cashier got a toast that read like a
// refusal AND a sale recorded at 2.1 they never typed. The save-time
// `l.qty > l.available` check could not catch it — setQty had already made the
// number legal.
//
// Now capped in onChange, matching the owner delivery form and the shop transfer
// form. Verified against the DATABASE, not the screen: what is stored must be
// exactly what the capped box showed.
//
// Provisions its own kg product at Ternate. Remove with
// `node scripts/qa-browser/fq-cleanup.mjs --yes`.
import { createClient } from "@supabase/supabase-js";
import {
  launch, session, goto, shot, check, step, summary, dbAuth, CREDS,
} from "./qa-lib.mjs";
import { readEnvFile } from "../_env-guard.mjs";

const env = readEnvFile();
const TERNATE = "a46c9c78-a995-46b3-954f-7836ab161254";
const NAME = `ZZ-QA Gate ${Date.now().toString(36).slice(-4).toUpperCase()}`;
const AVAILABLE = 2.1;
const PRICE_PESOS = 100;

async function clientFor(role) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({
    email: CREDS[role].email, password: CREDS[role].pass,
  });
  if (error) throw new Error(`${role}: ${error.message}`);
  return c;
}

const q = await dbAuth("owner");
const { browser } = await launch({ headless: true });

/** how many sale_lines exist for this fixture part, and at what quantities */
async function soldLines(partId) {
  return q(
    `sale_lines?part_id=eq.${partId}&select=qty,line_total_centavos,sales!inner(deleted_at)`
  );
}

/**
 * The cart row's own text — "P100.00 x 2.1 kg = P210.00".
 *
 * Take the SHORTEST matching innerText: `querySelectorAll("div").find(...)`
 * returns the OUTERMOST match, i.e. the page shell, whose text contains every
 * candidate string — so a positive assertion against it passes for the wrong
 * reason and a negative one passes vacuously.
 */
const rowText = (page) =>
  page.evaluate(() => {
    const hits = [...document.querySelectorAll("div")]
      .map((d) => (d.innerText || "").replace(/\s+/g, " "))
      .filter((t) => t.includes("×") && /kg\s*=/.test(t))
      .sort((a, b) => a.length - b.length);
    return hits[0] ?? "(no row matched)";
  });

const toasts = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-sonner-toast]")]
      .map((t) => (t.innerText || "").replace(/\s+/g, " "))
      .join(" | ")
  );

try {
  step(`Provision ${AVAILABLE} kg at Ternate`);
  const owner = await clientFor("owner");
  const sup = (await q("suppliers?deleted_at=is.null&select=id&limit=1"))[0];
  const { error: rErr } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: sup.id,
    p_note: `ZZ-QA save gate ${NAME}`,
    p_parts: [{
      qty: AVAILABLE, unit_cost_centavos: 5000,
      new_part: { name: NAME, unit: "kg", price_centavos: PRICE_PESOS * 100, reorder_level: 0 },
    }],
    p_engines: [], p_payment_status: "paid", p_amount_paid: null,
    p_override: true, p_override_reason: "ZZ-QA test run",
  });
  check(!rErr, "received the fixture", rErr?.message);
  if (rErr) throw new Error("setup failed");

  const part = (await q(`parts?name=eq.${encodeURIComponent(NAME)}&select=id`))[0];
  const { data: delId, error: dErr } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: TERNATE, p_note: "ZZ-QA save gate",
    p_parts: [{ part_id: part.id, qty: AVAILABLE }], p_engine_ids: [],
  });
  check(!dErr, "delivered to Ternate", dErr?.message);

  const shopClient = await clientFor("shop");
  const lines = await q(`delivery_lines?delivery_id=eq.${delId}&select=id,qty`);
  const { error: cErr } = await shopClient.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: lines.map((l) => ({ line_id: l.id, qty_received: l.qty, shop_note: null })),
    p_note: null,
  });
  check(!cErr, `confirmed ${AVAILABLE} kg`, cErr?.message);
  check((await soldLines(part.id)).length === 0, "no sale lines exist for the fixture yet");

  // ── the actual test ──────────────────────────────────────────────────────
  const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
  await goto(shop.page, "/shop/record-sale");
  await shop.page.waitForTimeout(2500);
  await shop.page.getByPlaceholder(/search/i).first().fill("ZZ-QA Gate");
  await shop.page.waitForTimeout(1200);
  await shop.page.getByRole("button", { name: new RegExp(NAME, "i") }).first().click();
  await shop.page.waitForTimeout(900);

  const box = shop.page.getByLabel(/quantity in kg/i).first();
  const saveBtn = shop.page.getByRole("button", { name: /save sale/i }).first();

  step("The box CANNOT display more than is available, while typing");
  await box.fill("");
  await box.type("13465", { delay: 60 });
  const whileTyping = await box.inputValue();
  console.log(`  typed "13465" -> box holds "${whileTyping}"`);
  check(
    Number(whileTyping) === AVAILABLE,
    `hard-capped at ${AVAILABLE} on every keystroke, no blur needed`,
    whileTyping
  );
  const typingRow = await rowText(shop.page);
  console.log(`  row while typing: ${typingRow}`);
  check(
    !/656,800|1,346,500/.test(typingRow),
    "the total never shows a six-figure amount the shop cannot sell",
    typingRow
  );
  check(
    /=\s*₱?210\.00/.test(typingRow.replace(/\s/g, " ")),
    `total stays ${PRICE_PESOS} x ${AVAILABLE} = P210.00`,
    typingRow
  );

  step("A decimal is still typable — the cap must not erase the point");
  await box.fill("");
  await box.type("1.5", { delay: 80 });
  check((await box.inputValue()) === "1.5", "1.5 types through under the cap", await box.inputValue());
  await box.fill("");
  await box.type("13465", { delay: 60 });

  await shot(shop.page, "fq19-01-capped-while-typing");

  step("Save records EXACTLY what the capped box shows");
  // With the cap applied on every keystroke there is no clamp left for the save
  // to race, so the sale goes through on the FIRST press — the earlier
  // "press twice" behaviour existed only because the clamp fired on blur.
  // `qtyCorrected` stays in the code as a second line of defence for any path
  // that sets a quantity WITHOUT going through this box; it is deliberately
  // unreachable by typing now.
  await saveBtn.click();
  await shop.page.waitForTimeout(3500);
  console.log(`  toasts: ${await toasts(shop.page)}`);
  const afterSecond = await soldLines(part.id);
  check(afterSecond.length === 1, `exactly one sale line recorded (${afterSecond.length})`);
  if (afterSecond.length === 1) {
    check(
      Number(afterSecond[0].qty) === AVAILABLE,
      `stored quantity is ${AVAILABLE} — never 13465`,
      String(afterSecond[0].qty)
    );
    check(
      Number(afterSecond[0].line_total_centavos) === Math.round(PRICE_PESOS * 100 * AVAILABLE),
      `money matches: ${PRICE_PESOS} x ${AVAILABLE} = P210.00`,
      String(afterSecond[0].line_total_centavos)
    );
  }
  await shot(shop.page, "fq19-02-saved");

  step("The picker reflects the sale immediately");
  // fresh line: the whole 2.1 is now committed, so re-add and use a sub-amount
  await goto(shop.page, "/shop/record-sale");
  await shop.page.waitForTimeout(2500);
  const before = (await soldLines(part.id)).length;
  await shop.page.getByPlaceholder(/search/i).first().fill("ZZ-QA Gate");
  await shop.page.waitForTimeout(1200);
  const tile = shop.page.getByRole("button", { name: new RegExp(NAME, "i") }).first();
  const tileText = (await tile.innerText()).replace(/\s+/g, " ");
  console.log(`  tile now reads: ${tileText}`);
  check(
    /0 kg left/i.test(tileText) && /awaiting/i.test(tileText),
    "a fully-committed product stays visible at 0 left, flagged as awaiting Admin",
    tileText
  );
  check(
    (await soldLines(part.id)).length === before,
    "and no extra sale appeared while checking"
  );

  console.log(`\nFIXTURE: ${NAME} — remove with fq-cleanup.mjs --yes`);
  console.log("CONSOLE ERRORS:", (shop.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ19 THREW:", e.message);
  check(false, `run failed: ${e.message}`);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
