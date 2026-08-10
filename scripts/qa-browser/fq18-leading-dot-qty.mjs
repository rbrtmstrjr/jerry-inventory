// FQ18 — ".1" must mean 0.1, the amount must track typing, and a refusal must
// be LOUD.
//
// The bug (production, 2026-08-10): `sanitizeQtyInput` deliberately preserves
// ".1" and "2." so a half-typed weight is not fought mid-keystroke, but
// `parseQty` validated for canonical form only and returned null for both.
// Record Sale's refusal branch then restored the PREVIOUS quantity silently —
// so a cashier typing ".1" saw the amount stay put, saved the sale, and 1 kg
// was deducted instead of 0.1.
//
// Provisions its own kg product at Ternate (the live kg item sits at Bacoor,
// whose login this harness does not hold). Remove with
// `node scripts/qa-browser/fq-cleanup.mjs --yes`.
import { createClient } from "@supabase/supabase-js";
import {
  launch, session, goto, shot, check, step, summary, dbAuth, CREDS,
} from "./qa-lib.mjs";
import { readEnvFile } from "../_env-guard.mjs";

const env = readEnvFile();
const TERNATE = "a46c9c78-a995-46b3-954f-7836ab161254";
const NAME = `ZZ-QA Dot ${Date.now().toString(36).slice(-4).toUpperCase()}`;
const AVAILABLE = 3; // room to type 1.5 and 2. without hitting the clamp
const PRICE_PESOS = 100; // 0.1 kg -> P10.00, 1.5 kg -> P150.00

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

/**
 * The cart row's own text — "P100.00 x 0.1 kg = P10.00".
 *
 * `querySelectorAll("div").find(...)` returns the OUTERMOST match, i.e. the page
 * shell, whose innerText contains every candidate string — so a positive
 * assertion against it passes for the wrong reason and a negative one passes
 * vacuously. Take the SHORTEST matching innerText: the tightest container is the
 * row itself.
 */
const rowText = (page) =>
  page.evaluate(() => {
    const hits = [...document.querySelectorAll("div")]
      .map((d) => (d.innerText || "").replace(/\s+/g, " "))
      .filter((t) => t.includes("×") && /kg\s*=/.test(t))
      .sort((a, b) => a.length - b.length);
    return hits[0] ?? "(no row matched)";
  });

const { browser } = await launch({ headless: true });
const q = await dbAuth("owner");

try {
  step(`Provision ${AVAILABLE} kg of a kg product at Ternate`);
  const owner = await clientFor("owner");
  const sup = (await q("suppliers?deleted_at=is.null&select=id&limit=1"))[0];
  const { error: rErr } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: sup.id,
    p_note: `ZZ-QA leading dot ${NAME}`,
    p_parts: [{
      qty: AVAILABLE, unit_cost_centavos: 5000,
      new_part: { name: NAME, unit: "kg", price_centavos: PRICE_PESOS * 100, reorder_level: 0 },
    }],
    p_engines: [], p_payment_status: "paid", p_amount_paid: null,
    p_override: true, p_override_reason: "ZZ-QA test run",
  });
  check(!rErr, "received the fixture into master", rErr?.message);
  if (rErr) throw new Error("setup failed");

  const part = (await q(`parts?name=eq.${encodeURIComponent(NAME)}&select=id`))[0];
  const { data: delId, error: dErr } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: TERNATE, p_note: "ZZ-QA leading dot",
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
  await shop.page.getByPlaceholder(/search/i).first().fill("ZZ-QA Dot");
  await shop.page.waitForTimeout(1200);
  await shop.page.getByRole("button", { name: new RegExp(NAME, "i") }).first().click();
  await shop.page.waitForTimeout(900);

  const box = shop.page.getByLabel(/quantity in kg/i).first();
  check((await box.count()) > 0, "the kg line has a typed quantity box");

  step("THE BUG: typing '.1' must become 0.1, not revert to 1");
  await box.fill("");
  await box.type(".1", { delay: 80 });
  const typedRaw = await box.inputValue();
  check(typedRaw === ".1", `the box lets '.1' be typed (shows "${typedRaw}")`);

  // live amount, BEFORE blur — this is the "amount didn't count" symptom
  const liveRow = await rowText(shop.page);
  console.log(`  live row while typing: ${liveRow}`);
  check(
    /×\s*0\.1\s*kg/.test(liveRow),
    "the amount tracks the keystrokes — row already reads x 0.1 kg",
    liveRow
  );
  check(
    /=\s*₱?10\.00/.test(liveRow.replace(/\s/g, " ")),
    `total is ${PRICE_PESOS} x 0.1 = P10.00 while still typing`,
    liveRow
  );

  await box.blur();
  await shop.page.waitForTimeout(800);
  const afterBlur = await box.inputValue();
  check(Number(afterBlur) === 0.1, `on blur the box normalises to 0.1 (got "${afterBlur}")`);
  const committedRow = await rowText(shop.page);
  check(
    !/×\s*1\s*kg/.test(committedRow),
    "it did NOT silently revert to 1 kg — the original bug",
    committedRow
  );
  await shot(shop.page, "fq18-01-leading-dot");

  step("A trailing dot is normalised too: '2.' -> 2");
  await box.fill("");
  await box.type("2.", { delay: 80 });
  await box.blur();
  await shop.page.waitForTimeout(800);
  check(Number(await box.inputValue()) === 2, `'2.' committed as 2`, await box.inputValue());

  step("Tenths rule survives: a second decimal still cannot be typed");
  await box.fill("");
  await box.type(".25", { delay: 80 });
  const masked = await box.inputValue();
  check(masked === ".2", `'.25' masked to '.2' as typed (got "${masked}")`);

  step("A genuinely refused entry is LOUD, not silent");
  await box.fill("");           // empty is the one thing left that can refuse
  await box.blur();
  await shop.page.waitForTimeout(900);
  const toastText = await shop.page.evaluate(() =>
    [...document.querySelectorAll("[data-sonner-toast]")]
      .map((t) => (t.innerText || "").replace(/\s+/g, " "))
      .join(" | ")
  );
  console.log(`  toast: ${toastText || "(none)"}`);
  check(
    /quantity/i.test(toastText),
    "clearing the box explains itself instead of silently reverting",
    toastText
  );
  const restored = await box.inputValue();
  check(Number(restored) === 2, `the previous quantity is kept (${restored})`, restored);
  await shot(shop.page, "fq18-02-refusal-toast");

  step("Over-available is capped ON THE KEYSTROKE, not on blur");
  // This step used to assert the inline "(max 3)" hint, which was correct while
  // the clamp happened on blur. The box is now hard-capped in onChange (the
  // owner delivery / shop transfer pattern), so an over-limit value cannot be
  // displayed at all and the hint has nothing to warn about. The hint stays in
  // the code for the one path that can still exceed: a restored draft whose
  // saved quantity is now above what is on hand.
  await box.fill("");
  await box.type("9.5", { delay: 80 });
  const overRow = await rowText(shop.page);
  console.log(`  over row: ${overRow}`);
  check(
    Number(await box.inputValue()) === AVAILABLE,
    `typing 9.5 against ${AVAILABLE} caps the box immediately`,
    await box.inputValue()
  );
  check(
    !/9\.5|950\.00/.test(overRow),
    "the row never shows the un-sellable quantity or its total",
    overRow
  );
  await box.blur();
  await shop.page.waitForTimeout(800);
  check(
    Number(await box.inputValue()) === AVAILABLE,
    "and it stays capped after blur",
    await box.inputValue()
  );

  console.log(`\nFIXTURE: ${NAME} — remove with fq-cleanup.mjs --yes`);
  console.log("CONSOLE ERRORS:", (shop.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ18 THREW:", e.message);
  check(false, `run failed: ${e.message}`);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
