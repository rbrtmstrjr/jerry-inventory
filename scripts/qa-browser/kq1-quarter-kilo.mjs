// KQ1 — a kg line takes a quarter kilo (0134: qty went from one decimal to two).
//
// No existing staging kg product currently has AVAILABLE stock at either test
// shop login (the only live one, "Nails 1", is fully committed to approved
// sales at Gerwin-Bacoor, which no qa-lib credential can sign into) — so this
// provisions its own kg product with stock at Ternate, mirroring fq20.
//
// Provisions "ZZ-QA Kilo …" at Ternate. Remove with
// `node scripts/qa-browser/fq-cleanup.mjs --yes` (matches the ZZ-QA prefix).
import { createClient } from "@supabase/supabase-js";
import {
  launch, check, summary, shot, ok, dbAuth, CREDS, APP,
} from "./qa-lib.mjs";
import { readEnvFile } from "../_env-guard.mjs";

// qa-lib.mjs hardcodes APP="http://localhost:3000" and must not be touched
// here — if a stranger already holds 3000, set QA_APP_PORT to the port THIS
// repo's `next dev` actually bound to; BASE/nav/shopLogin below stand in for
// qa-lib's goto/login so every request goes to the right server directly
// (request-interception rewriting broke React hydration mid-navigation).
const BASE = process.env.QA_APP_PORT ? `http://localhost:${process.env.QA_APP_PORT}` : APP;

async function nav(page, path) {
  await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 60000 });
  await page.waitForTimeout(800);
}

async function shopLogin(page) {
  const { email, pass } = CREDS.shop;
  await page.goto(`${BASE}/login`, { waitUntil: "load", timeout: 60000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 });
  await page.waitForLoadState("load");
}

const env = readEnvFile();
const TERNATE = "a46c9c78-a995-46b3-954f-7836ab161254";
const NAME = `ZZ-QA Kilo Nails ${Date.now().toString(36).slice(-4).toUpperCase()}`;
const AVAILABLE = 5; // kg delivered to the shop
const PRICE_PESOS = 80;

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
const { browser, page, errors } = await launch({ headless: true });

try {
  // ── provision a kg product with real shop stock ──────────────────────────
  const owner = await clientFor("owner");
  const sup = (await q("suppliers?deleted_at=is.null&select=id&limit=1"))[0];
  const { error: rErr } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: sup.id,
    p_note: `ZZ-QA kg ${NAME}`,
    p_parts: [{
      qty: AVAILABLE, unit_cost_centavos: 3000,
      new_part: { name: NAME, unit: "kg", price_centavos: PRICE_PESOS * 100, reorder_level: 0 },
    }],
    p_engines: [], p_payment_status: "paid", p_amount_paid: null,
    p_override: true, p_override_reason: "ZZ-QA test run",
  });
  check(!rErr, "received 5 kg into master — the RPC accepts a kg product", rErr?.message);
  if (rErr) throw new Error("setup failed: " + rErr.message);

  const part = (await q(`parts?name=eq.${encodeURIComponent(NAME)}&select=id`))[0];
  check(!!part, "the kg product exists in the catalog");
  if (!part) throw new Error("setup failed: product not found after receiving");

  const { data: delId, error: dErr } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: TERNATE, p_note: "ZZ-QA kg",
    p_parts: [{ part_id: part.id, qty: AVAILABLE }], p_engine_ids: [],
  });
  check(!dErr, "delivered 5 kg to Ternate", dErr?.message);

  const shopClient = await clientFor("shop");
  const lines = await q(`delivery_lines?delivery_id=eq.${delId}&select=id,qty`);
  const { error: cErr } = await shopClient.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: lines.map((l) => ({ line_id: l.id, qty_received: l.qty, shop_note: null })),
    p_note: null,
  });
  check(!cErr, "shop confirmed 5 kg received", cErr?.message);

  // ── the actual UI QA ───────────────────────────────────────────────────
  // headless Chromium resolves print() immediately; stub it so an auto-printed
  // receipt's afterprint fires deterministically and never blocks the run
  await page.addInitScript(() => {
    window.print = () => window.dispatchEvent(new Event("afterprint"));
  });

  await shopLogin(page);
  await nav(page, "/shop/record-sale");
  await page.waitForTimeout(1500);

  await page.getByPlaceholder(/search/i).first().fill(NAME);
  await page.waitForTimeout(1200);

  const option = page.getByRole("button", { name: new RegExp(NAME, "i") }).first();
  const found = await option.isVisible().catch(() => false);
  check(found, `the picker lists "${NAME}"`);
  if (!found) {
    await shot(page, "kq1-no-kg-product");
    throw new Error("provisioned kg product did not appear in the picker — seed/delivery may have failed");
  }
  await option.click();
  await page.waitForTimeout(900);
  ok(`added "${NAME}" — ${AVAILABLE} kg available`);

  const qty = page.getByLabel(/^Quantity in /i).first();
  check(await qty.isVisible().catch(() => false), "the quantity box is editable");

  // 1. the quarter kilo — the entire point of 0134
  await qty.fill("");
  await qty.type("0.25");
  await page.waitForTimeout(700);
  check((await qty.inputValue()) === "0.25",
    `0.25 survives typing (box reads "${await qty.inputValue()}")`);
  await shot(page, "kq1-quarter");

  // 2. a 3rd decimal is masked as you type, never fought with an error
  await qty.fill("");
  await qty.type("0.255");
  await page.waitForTimeout(700);
  check((await qty.inputValue()) === "0.25",
    `a 3rd decimal is masked (box reads "${await qty.inputValue()}")`);

  // 3. the old one-decimal behaviour still works — nothing regressed
  await qty.fill("");
  await qty.type("0.5");
  await qty.blur();
  await page.waitForTimeout(800);
  check((await qty.inputValue()) === "0.5", "0.5 still works — nothing regressed");

  // 4. THE CLAMP: over-available is capped as you type, and it SAYS SO
  await qty.fill("");
  await qty.type(String(AVAILABLE * 1000));
  await page.waitForTimeout(900);
  const clamped = await qty.inputValue();
  // Number("") is 0, which also satisfies `<= AVAILABLE` — assert the exact
  // value, not just that it's under the ceiling, or an emptied box passes too.
  check(clamped !== "" && Number(clamped) === AVAILABLE,
    `over-available is clamped to exactly ${AVAILABLE} (box reads "${clamped}")`);
  const toastSeen = await page.getByText(/left to sell/i).first().isVisible().catch(() => false);
  check(toastSeen, "the clamp SAYS SO — a toast explains the correction (not a silent clamp)");
  await shot(page, "kq1-clamped");

  // 5. back to 0.25 and Save is enabled
  await qty.fill("");
  await qty.type("0.25");
  await page.waitForTimeout(700);
  check((await qty.inputValue()) === "0.25", "0.25 restored before saving");
  const save = page.getByRole("button", { name: /^save/i }).last();
  check(await save.isEnabled().catch(() => false), "Save is enabled at 0.25 kg");
  await shot(page, "kq1-ready-to-save");

  // 6. it actually saves as 0.25, not rounded to a whole kilo
  await save.click();
  await page.waitForTimeout(3000);
  const sold = await q(
    `sale_lines?part_id=eq.${part.id}&select=qty,sale_id,sales!inner(deleted_at)`
  );
  check(sold.length === 1, `one sale line recorded (${sold.length})`);
  if (sold.length === 1) {
    check(Number(sold[0].qty) === 0.25,
      "the saved sale stores 0.25, not rounded", String(sold[0].qty));
    console.log(`\nSALE LINE for dashboard verification: sale_id=${sold[0].sale_id} part_id=${part.id}`);
  }

  console.log(`\nFIXTURE: ${NAME} — remove with fq-cleanup.mjs --yes`);
  console.log("CONSOLE ERRORS:", (errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nKQ1 THREW:", e.message);
  check(false, `run failed: ${e.message}`);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
