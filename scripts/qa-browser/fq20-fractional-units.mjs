// FQ20 — a METRE product is splittable at the counter, exactly like a kilo.
//
// 0130 flipped m/ft to allows_fractional (roll joined briefly, reverted by
// 0131 — a roll sells whole). No code decides this: the form
// asks the units table. This proves the whole chain end to end, because an
// RPC-level suite cannot see the form or the server action — test-fractional-qty
// was once 41/41 green while the counter still refused 0.5.
//
// Provisions its own m product at Ternate. Remove with
// `node scripts/qa-browser/fq-cleanup.mjs --yes`.
import { createClient } from "@supabase/supabase-js";
import {
  launch, session, goto, shot, check, step, summary, dbAuth, CREDS,
} from "./qa-lib.mjs";
import { readEnvFile } from "../_env-guard.mjs";

const env = readEnvFile();
const TERNATE = "a46c9c78-a995-46b3-954f-7836ab161254";
const NAME = `ZZ-QA Rope ${Date.now().toString(36).slice(-4).toUpperCase()}`;
const AVAILABLE = 8;
const PRICE_PESOS = 40; // 1.5 m -> P60.00

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

try {
  step("Provision 8 m of a METRE product at Ternate");
  const owner = await clientFor("owner");
  const sup = (await q("suppliers?deleted_at=is.null&select=id&limit=1"))[0];
  const { error: rErr } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: sup.id,
    p_note: `ZZ-QA metre ${NAME}`,
    p_parts: [{
      qty: AVAILABLE, unit_cost_centavos: 1000,
      new_part: { name: NAME, unit: "m", price_centavos: PRICE_PESOS * 100, reorder_level: 0 },
    }],
    p_engines: [], p_payment_status: "paid", p_amount_paid: null,
    p_override: true, p_override_reason: "ZZ-QA test run",
  });
  check(!rErr, "received 8 m into master — the RPC accepts a metre product", rErr?.message);
  if (rErr) throw new Error("setup failed");

  const part = (await q(`parts?name=eq.${encodeURIComponent(NAME)}&select=id`))[0];
  const { data: delId, error: dErr } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: TERNATE, p_note: "ZZ-QA metre",
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
  check(!cErr, "confirmed 8 m", cErr?.message);

  step("The counter offers a TYPED quantity box for a metre product");
  const shop = await session(browser, "shop", { clearLocalStorage: true, stubPrint: true });
  await goto(shop.page, "/shop/record-sale");
  await shop.page.waitForTimeout(2500);
  await shop.page.getByPlaceholder(/search/i).first().fill("ZZ-QA Rope");
  await shop.page.waitForTimeout(1200);
  await shop.page.getByRole("button", { name: new RegExp(NAME, "i") }).first().click();
  await shop.page.waitForTimeout(900);

  const box = shop.page.getByLabel(/quantity in m/i).first();
  check(
    (await box.count()) > 0,
    "a metre line has a typed quantity box (a `pc` line has none)"
  );

  step("Sell 1.5 m");
  await box.fill("");
  await box.type("1.5", { delay: 80 });
  await box.blur();
  await shop.page.waitForTimeout(800);
  check((await box.inputValue()) === "1.5", "1.5 is accepted", await box.inputValue());

  await shop.page.getByRole("button", { name: /save sale/i }).first().click();
  await shop.page.waitForTimeout(3500);

  const sold = await q(
    `sale_lines?part_id=eq.${part.id}&select=qty,line_total_centavos,sales!inner(deleted_at)`
  );
  check(sold.length === 1, `one sale line recorded (${sold.length})`);
  if (sold.length === 1) {
    check(Number(sold[0].qty) === 1.5, `stored quantity is 1.5`, String(sold[0].qty));
    check(
      Number(sold[0].line_total_centavos) === Math.round(PRICE_PESOS * 100 * 1.5),
      `money is round(P${PRICE_PESOS} x 1.5) = P60.00`,
      String(sold[0].line_total_centavos)
    );
  }
  await shot(shop.page, "fq20-metre-sold");

  console.log(`\nFIXTURE: ${NAME} — remove with fq-cleanup.mjs --yes`);
  console.log("CONSOLE ERRORS:", (shop.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ20 THREW:", e.message);
  check(false, `run failed: ${e.message}`);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
