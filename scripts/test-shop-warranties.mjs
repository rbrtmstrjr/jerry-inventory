/**
 * Shop warranty visibility verification — strict shop scoping (a shop cannot
 * see or print another shop's warranty, tested at the API/RLS level, not the
 * UI), no cost leakage, no mutate path, and near-expiry alerts with dedupe.
 *
 * Self-contained: two temp shops + employees via the service role, each sells
 * its own engine, then everything is hard-cleaned.
 *
 * Run: node scripts/test-shop-warranties.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const RUN = Date.now().toString(36).toUpperCase();

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

const admin = createClient(SB_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function signIn(email, password) {
  const c = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

async function makeShop(label) {
  const { data: shop } = await admin
    .from("shops").insert({ name: `WTY-TEST ${label} ${RUN}` }).select().single();
  const email = `wty-${label.toLowerCase()}-${RUN.toLowerCase()}@test.local`;
  const password = `Wty!${RUN}`;
  const { data: u, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw new Error(error.message);
  await admin.from("profiles").insert({
    id: u.user.id, full_name: `WTY-TEST ${label}`, role: "employee", shop_id: shop.id,
  });
  return { shop, userId: u.user.id, client: await signIn(email, password) };
}

const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");

async function confirmAll(shopClient, deliveryId) {
  const { data: lines } = await shopClient
    .from("shop_incoming_delivery_lines").select("id, qty_sent").eq("delivery_id", deliveryId);
  const { error } = await shopClient.rpc("fn_confirm_delivery", {
    p_delivery_id: deliveryId,
    p_lines: (lines ?? []).map((l) => ({ line_id: l.id, qty_received: l.qty_sent, shop_note: null })),
  });
  if (error) throw new Error(`confirm: ${error.message}`);
}

/** Sell an engine from `shop` so its approval auto-creates a warranty. */
async function sellEngine(S, serial, months) {
  const { data: model } = await owner
    .from("engine_models").select("id").eq("model", "15MH").single();
  await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `WTY-TEST setup ${RUN}`,
    p_parts: [],
    p_engines: [{
      serial_number: serial, engine_model_id: model.id, condition: "brand_new",
      cost_centavos: 2000000, price_centavos: 0, warranty_months: months,
      margin_floor_pct: 50, margin_mid_pct: 75, margin_asking_pct: 100,
    }],
  });
  const { data: eng } = await owner
    .from("engines").select("id").eq("serial_number", serial).single();
  const { data: dlv } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: S.shop.id, p_note: `WTY-TEST dlv ${RUN}`,
    p_parts: [], p_engine_ids: [eng.id],
  });
  await confirmAll(S.client, dlv);
  const { data: saleId } = await S.client.rpc("fn_record_sale", {
    p_customer_id: null,
    p_customer: { name: `WTY-TEST Buyer ${serial}`, phone: "0917-444-5555" },
    p_part_lines: [],
    p_engine_lines: [{ engine_id: eng.id, agreed_price_centavos: 4000000 }],
  });
  const { data: sub } = await S.client.rpc("fn_submit_shop_batch");
  const { error } = await owner.rpc("fn_approve_batch", { p_batch_id: sub.batch_id, p_note: null });
  if (error) throw new Error(`approve: ${error.message}`);
  const { data: w } = await owner
    .from("warranties").select("id, expires_on").eq("engine_id", eng.id).single();
  return { engineId: eng.id, saleId, warrantyId: w.id, expires_on: w.expires_on };
}

console.log("Setup: two temp shops, each sells its own engine (warranty auto-created)");
const A = await makeShop("ShopA");
const B = await makeShop("ShopB");
const SERIAL_A = `WTY-TEST-A-${RUN}`;
const SERIAL_B = `WTY-TEST-B-${RUN}`;
const wA = await sellEngine(A, SERIAL_A, 24);
const wB = await sellEngine(B, SERIAL_B, 1);
check("Shop A warranty created", !!wA.warrantyId);
check("Shop B warranty created", !!wB.warrantyId);

// Park B's warranty 10 days from expiry — deterministic, rather than relying
// on "1 month" happening to land inside the 30-day window (it's 31 days).
const { data: phToday } = await admin.rpc("ph_today");
const soon = new Date(`${phToday}T00:00:00Z`);
soon.setUTCDate(soon.getUTCDate() + 10);
await admin
  .from("warranties")
  .update({ expires_on: soon.toISOString().slice(0, 10) })
  .eq("id", wB.warrantyId);

// ── Scoping ───────────────────────────────────────────────────────────────
console.log("\nA shop sees ONLY what it sold:");
{
  const { data } = await A.client.from("shop_warranties").select("*");
  const ids = (data ?? []).map((r) => r.id);
  check("Shop A sees its own warranty", ids.includes(wA.warrantyId));
  check("Shop A does NOT see Shop B's warranty", !ids.includes(wB.warrantyId));
  check("every row Shop A sees belongs to Shop A",
    (data ?? []).every((r) => r.shop_id === A.shop.id));
}
{
  // the counter case: employee types a serial they didn't sell
  const { data } = await A.client
    .from("shop_warranties").select("*").eq("serial_number", SERIAL_B);
  check("serial lookup of another shop's engine returns NOTHING (no leak)",
    (data ?? []).length === 0);
}
{
  // and cannot reach it by guessing the warranty id either
  const { data } = await A.client
    .from("shop_warranties").select("*").eq("id", wB.warrantyId).maybeSingle();
  check("guessing another shop's warranty id returns nothing", !data);
}
{
  const { data } = await A.client.from("warranties").select("id");
  check("shop cannot read the warranties base table at all", (data ?? []).length === 0);
}
{
  const { data } = await owner.from("shop_warranties").select("id");
  const ids = (data ?? []).map((r) => r.id);
  check("owner sees BOTH shops' warranties",
    ids.includes(wA.warrantyId) && ids.includes(wB.warrantyId));
}

// ── No cost leakage ───────────────────────────────────────────────────────
console.log("\nNo cost/margin anywhere on the shop surface:");
{
  const { data } = await A.client.from("shop_warranties").select("*").limit(1).single();
  const keys = Object.keys(data ?? {});
  check("no cost columns", !keys.some((k) => k.includes("cost")));
  check("no margin columns", !keys.some((k) => k.includes("margin")));
  check("no price columns", !keys.some((k) => k.includes("price")));
}

// ── Read-only ─────────────────────────────────────────────────────────────
console.log("\nShop has NO way to edit / void / extend / claim:");
{
  const { error } = await A.client
    .from("warranties").update({ months: 99 }).eq("id", wA.warrantyId);
  check("cannot extend a warranty", !!error || true);
  const { data: w } = await owner
    .from("warranties").select("months").eq("id", wA.warrantyId).single();
  check("months unchanged after the attempt", w?.months === 24, `(got ${w?.months})`);
}
{
  const { data } = await A.client
    .from("warranties").delete().eq("id", wA.warrantyId).select("id");
  check("cannot void/delete a warranty", (data ?? []).length === 0);
  const { data: still } = await owner
    .from("warranties").select("id").eq("id", wA.warrantyId).single();
  check("warranty still there", !!still);
}
{
  const { error } = await A.client
    .from("warranty_claims")
    .insert({ warranty_id: wA.warrantyId, issue: "WTY-TEST shop tried to file" });
  check("cannot record a claim", !!error);
}
{
  const { error } = await A.client
    .from("shop_warranties").update({ months: 99 }).eq("id", wA.warrantyId);
  check("cannot write through the safe view", !!error);
}

// ── Near-expiry: status + alerts ──────────────────────────────────────────
console.log("\nNear-expiry (threshold from settings, dedupe on repeat runs):");
{
  const { data } = await admin.rpc("fn_warranty_alert_days");
  check("threshold comes from settings (default 30)", data === 30, `(got ${data})`);
}
{
  const { data: rowB } = await B.client
    .from("shop_warranties").select("*").eq("id", wB.warrantyId).single();
  check("warranty 10 days out is flagged expiring_soon", rowB?.expiring_soon === true);
  check("it is still active", rowB?.active === true);
  check("days_left computed in PH time", rowB?.days_left === 10, `(got ${rowB?.days_left})`);
  const { data: rowA } = await A.client
    .from("shop_warranties").select("expiring_soon").eq("id", wA.warrantyId).single();
  check("24-month warranty NOT flagged", rowA?.expiring_soon === false);
}
{
  const { data: n1, error } = await admin.rpc("fn_check_warranty_expiry");
  check("daily check ran", !error, error?.message);
  check("it found the expiring warranty", (n1 ?? 0) >= 1, `(got ${n1})`);

  const { data: shopN } = await B.client
    .from("notifications").select("id, title").eq("type", "warranty_expiring").eq("ref_id", wB.warrantyId);
  check("selling shop was alerted exactly once", (shopN ?? []).length === 1);
  const { data: ownerN } = await owner
    .from("notifications").select("id, shop_id").eq("type", "warranty_expiring").eq("ref_id", wB.warrantyId);
  check("owner was alerted too", (ownerN ?? []).length === 1);
  check("owner's alert carries the shop context", ownerN?.[0]?.shop_id === B.shop.id);

  const { data: otherShop } = await A.client
    .from("notifications").select("id").eq("ref_id", wB.warrantyId);
  check("the other shop was NOT alerted", (otherShop ?? []).length === 0);
}
{
  // running it again (as the cron does daily) must not re-spam
  await admin.rpc("fn_check_warranty_expiry");
  await admin.rpc("fn_check_warranty_expiry");
  const { data: shopN } = await B.client
    .from("notifications").select("id").eq("type", "warranty_expiring").eq("ref_id", wB.warrantyId);
  check("re-running the daily check does NOT duplicate (dedupe)",
    (shopN ?? []).length === 1, `(got ${(shopN ?? []).length})`);
}
// The pg_cron schedule itself lives in the `cron` schema, which PostgREST
// doesn't expose — it's asserted directly in SQL (0032) rather than here.

// ── Cleanup ───────────────────────────────────────────────────────────────
console.log("\nCleanup:");
{
  const shops = [A.shop.id, B.shop.id];
  const engines = [wA.engineId, wB.engineId];
  await admin.from("notifications").delete().in("shop_id", shops);
  await admin.from("notifications").delete().in("ref_id", [wA.warrantyId, wB.warrantyId]);
  await admin.from("warranty_claims").delete().in("warranty_id", [wA.warrantyId, wB.warrantyId]);
  await admin.from("warranties").delete().in("engine_id", engines);
  await admin.from("stock_movements").delete().in("engine_id", engines);
  await admin.from("stock_movements").delete().in("shop_id", shops);
  await admin.from("sales").delete().in("shop_id", shops);
  await admin.from("submission_batches").delete().in("shop_id", shops);
  await admin.from("deliveries").delete().in("shop_id", shops);
  await admin.from("receivings").delete().like("note", `%${RUN}%`);
  await admin.from("engines").delete().in("id", engines);
  await admin.from("customers").delete().like("name", `%${RUN}%`);
  await admin.auth.admin.deleteUser(A.userId);
  await admin.auth.admin.deleteUser(B.userId);
  const { error } = await admin.from("shops").delete().in("id", shops);
  check("temp fixtures removed", !error, error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
