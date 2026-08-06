// FQ17 — the cart's typed quantity box must never SHOW more than is available.
//
// The state was already clamped; the BOX was not. Typing 3.5 against 1.1
// available, on a line ALREADY sitting at 1.1, left `line.qty` unchanged — so
// the resync effect never fired and the box kept reading 3.5 while the summary
// underneath said "x 1.1 kg". Two different numbers on one row, and the box is
// the one the cashier believes.
//
// Provisions its own kg product at Ternate (the only live kg item sits at
// Bacoor, whose login this harness does not hold). Remove with
// `node scripts/qa-browser/fq-cleanup.mjs --yes`.
import { createClient } from "@supabase/supabase-js";
import {
  launch, session, goto, shot, check, step, summary, dbAuth, CREDS,
} from "./qa-lib.mjs";
import { readEnvFile } from "../_env-guard.mjs";

const env = readEnvFile();
const TERNATE = "a46c9c78-a995-46b3-954f-7836ab161254";
const NAME = `ZZ-QA Tingi ${Date.now().toString(36).slice(-4).toUpperCase()}`;
const AVAILABLE = 1.1; // deliberately awkward: the bug needed a non-integer

/** A signed-in PostgREST client (writes go through the real RPCs). */
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

const { browser } = await launch({ headless: true });
const q = await dbAuth("owner");

try {
  step(`Provision ${AVAILABLE} kg of a kg product at Ternate`);
  const owner = await clientFor("owner");
  const sup = (await q("suppliers?deleted_at=is.null&select=id&limit=1"))[0];

  const { error: rErr } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: sup.id,
    p_note: `ZZ-QA cart clamp ${NAME}`,
    p_parts: [{
      qty: AVAILABLE, unit_cost_centavos: 5000,
      new_part: { name: NAME, unit: "kg", price_centavos: 10000, reorder_level: 0 },
    }],
    p_engines: [], p_payment_status: "paid", p_amount_paid: null,
    p_override: true, p_override_reason: "ZZ-QA test run",
  });
  check(!rErr, "received the fixture into master", rErr?.message);
  if (rErr) throw new Error("setup failed");

  const part = (await q(`parts?name=eq.${encodeURIComponent(NAME)}&select=id`))[0];
  const { data: delId, error: dErr } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: TERNATE, p_note: `ZZ-QA cart clamp`,
    p_parts: [{ part_id: part.id, qty: AVAILABLE }], p_engine_ids: [],
  });
  check(!dErr, "delivered it to Ternate", dErr?.message);

  const shopClient = await clientFor("shop");
  const lines = await q(`delivery_lines?delivery_id=eq.${delId}&select=id,qty`);
  const { error: cErr } = await shopClient.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: lines.map((l) => ({ line_id: l.id, qty_received: l.qty, shop_note: null })),
    p_note: null,
  });
  check(!cErr, `Ternate confirmed ${AVAILABLE} kg`, cErr?.message);

  // ── the actual test ──────────────────────────────────────────────────────
  const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
  await goto(shop.page, "/shop/record-sale");
  await shop.page.waitForTimeout(2500);
  await shop.page.getByPlaceholder(/search/i).first().fill("ZZ-QA Tingi");
  await shop.page.waitForTimeout(1200);

  const tile = shop.page.getByRole("button", { name: new RegExp(NAME, "i") }).first();
  console.log(`  tile: ${(await tile.innerText()).replace(/\s+/g, " ")}`);
  await tile.click();
  await shop.page.waitForTimeout(900);

  const box = shop.page.getByLabel(/quantity in kg/i).first();
  check((await box.count()) > 0, "the kg line has a typed quantity box");

  step(`Typing over ${AVAILABLE} is corrected IN THE BOX`);
  await box.fill("");
  await box.type("3.5", { delay: 70 });
  await box.blur();
  await shop.page.waitForTimeout(900);
  const shown = await box.inputValue();
  console.log(`  typed 3.5 (available ${AVAILABLE}) -> box shows "${shown}"`);
  check(Number(shown) <= AVAILABLE, `the box is capped, not left at 3.5`, shown);
  check(Number(shown) === AVAILABLE, `it snaps to the maximum sellable`, shown);

  const row = await shop.page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find(
      (d) => /×/.test(d.innerText || "") && /Cost/.test(d.innerText || "")
    );
    return (el?.innerText || "").replace(/\s+/g, " ").slice(0, 120);
  });
  console.log(`  row: ${row}`);
  check(!row.includes("3.5"), "the box and the summary agree — one number per row", row);
  await shot(shop.page, "fq17-01-capped");

  step("A second decimal cannot even be typed");
  await box.fill("");
  await box.type("0.25", { delay: 70 });
  const twoDp = await box.inputValue();
  console.log(`  typed 0.25 -> "${twoDp}"`);
  check(twoDp === "0.2", "masked to one decimal while typing", twoDp);

  step("A value under the limit is left alone");
  await box.fill("");
  await box.type("0.6", { delay: 70 });
  await box.blur();
  await shop.page.waitForTimeout(700);
  check((await box.inputValue()) === "0.6", "0.6 is accepted unchanged", await box.inputValue());

  console.log(`\nFIXTURE: ${NAME} — remove with fq-cleanup.mjs --yes`);
  console.log("CONSOLE ERRORS:", (shop.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ17 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
