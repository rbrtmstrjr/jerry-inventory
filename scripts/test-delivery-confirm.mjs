/**
 * Delivery confirmation verification — in-transit stock, shop confirmation,
 * discrepancy handling, owner-only resolution, and the RECONCILIATION
 * INVARIANT (master + in-transit + shops = total owned) after every step.
 *
 * Self-contained: temp shops + employees via the service role, real RLS, then
 * hard-cleans everything it made.
 *
 * Run: node scripts/test-delivery-confirm.mjs
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
    .from("shops").insert({ name: `TRANSIT-TEST ${label} ${RUN}` }).select().single();
  const email = `transit-${label.toLowerCase()}-${RUN.toLowerCase()}@test.local`;
  const password = `Transit!${RUN}`;
  const { data: u, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw new Error(error.message);
  await admin.from("profiles").insert({
    id: u.user.id, full_name: `TRANSIT-TEST ${label}`, role: "employee", shop_id: shop.id,
  });
  return { shop, userId: u.user.id, client: await signIn(email, password) };
}

const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");

console.log("Setup: temp shops + 10 units of a part in master");
const A = await makeShop("ShopA");
const B = await makeShop("ShopB");

const { data: cat } = await owner.from("product_categories").select("id").limit(1).single();
const { data: part } = await owner.from("parts").insert({
  name: `TRANSIT-TEST Widget ${RUN}`, category_id: cat.id,
  cost_centavos: 1000, price_centavos: 2000,
}).select().single();
const { data: em } = await owner.from("engine_models").insert({
  brand: `TRANSIT-TEST${RUN}`, model: "T1", horsepower: 9.9,
}).select().single();

const SERIAL = `TRANSIT-TEST-${RUN}`;
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `TRANSIT-TEST setup ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: 1000 }],
  p_engines: [{
    serial_number: SERIAL, engine_model_id: em.id, condition: "brand_new",
    cost_centavos: 100000, price_centavos: 200000, warranty_months: null,
  }],
});
const { data: eng } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();

/** master + every shop + in-transit, for our test part */
async function buckets() {
  const { data: levels } = await owner
    .from("stock_levels").select("qty, shop_id").eq("part_id", part.id);
  const master = (levels ?? []).filter((r) => r.shop_id === null).reduce((s, r) => s + r.qty, 0);
  const shops = (levels ?? []).filter((r) => r.shop_id !== null).reduce((s, r) => s + r.qty, 0);
  const { data: t } = await owner
    .from("stock_in_transit").select("qty").eq("part_id", part.id);
  const transit = (t ?? []).reduce((s, r) => s + r.qty, 0);
  return { master, shops, transit, total: master + shops + transit };
}

{
  const b = await buckets();
  check("start: master 10, transit 0, shops 0 (total 10)",
    b.master === 10 && b.transit === 0 && b.shops === 0, JSON.stringify(b));
}

// ── Send: leaves master, enters transit, does NOT land ─────────────────────
console.log("\nSend 10 → stock leaves master into transit (does NOT land):");
const { data: delId, error: dErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: A.shop.id, p_note: `TRANSIT-TEST dlv ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10 }], p_engine_ids: [],
});
check("delivery sent", !dErr, dErr?.message);
{
  const b = await buckets();
  check("master 10 → 0", b.master === 0, JSON.stringify(b));
  check("in-transit = 10", b.transit === 10, JSON.stringify(b));
  check("shop stock still 0 (no auto-land)", b.shops === 0, JSON.stringify(b));
  check("RECONCILES: total still 10", b.total === 10, JSON.stringify(b));
}
{
  const { data: d } = await owner.from("deliveries").select("status").eq("id", delId).single();
  check("delivery status = in_transit", d?.status === "in_transit");
  const { data: n } = await A.client
    .from("notifications").select("id").eq("type", "delivery_incoming").eq("ref_id", delId);
  check("shop was notified stock is coming", (n ?? []).length === 1);
}

// ── Shop confirms 8 of 10 ──────────────────────────────────────────────────
console.log("\nShop confirms 8 of 10 → 8 land, 2 stay in transit:");
const { data: line } = await A.client
  .from("shop_incoming_delivery_lines").select("*").eq("delivery_id", delId).single();
{
  const keys = Object.keys(line ?? {});
  check("shop's line view exposes NO cost", !keys.some((k) => k.includes("cost")));
  check("shop sees qty sent = 10", line?.qty_sent === 10);
}
{
  const { data, error } = await A.client.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: [{ line_id: line.id, qty_received: 8, shop_note: "2 boxes missing" }],
    p_note: null,
  });
  check("confirm accepted", !error, error?.message);
  check("returns landed 8 / short 2", data?.landed === 8 && data?.short === 2, JSON.stringify(data));
}
{
  const b = await buckets();
  check("shop stock = 8", b.shops === 8, JSON.stringify(b));
  check("in-transit = 2 (the shortfall)", b.transit === 2, JSON.stringify(b));
  check("master still 0", b.master === 0, JSON.stringify(b));
  check("RECONCILES: total still 10", b.total === 10, JSON.stringify(b));
}
{
  const { data: d } = await owner.from("deliveries").select("status, confirmed_by").eq("id", delId).single();
  check("delivery flagged discrepancy", d?.status === "discrepancy");
  check("confirmed_by recorded", !!d?.confirmed_by);
  const { data: n } = await owner
    .from("notifications").select("title").eq("type", "delivery_discrepancy").eq("ref_id", delId);
  check("owner notified of the discrepancy", (n ?? []).length === 1);
}

// ── The shop has NO power beyond counting ──────────────────────────────────
console.log("\nShop cannot reject / return / write off / re-confirm:");
{
  const { error } = await A.client.rpc("fn_confirm_delivery", {
    p_delivery_id: delId, p_lines: [{ line_id: line.id, qty_received: 2, shop_note: null }],
  });
  check("cannot confirm twice (one-shot)", !!error && /already confirmed/i.test(error.message), error?.message);
}
{
  const { error } = await A.client.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 2, p_resolution: "written_off", p_reason: "x",
  });
  check("shop CANNOT write off the shortfall", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { error } = await A.client.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 2, p_resolution: "returned_to_master", p_reason: "x",
  });
  check("shop CANNOT return the shortfall", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { error } = await A.client.rpc("fn_return_stock", {
    p_shop_id: A.shop.id, p_reason: "x",
    p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("shop CANNOT return stock at all", !!error && /owner/i.test(error.message), error?.message);
}

// ── Cross-shop + over-receive guards ───────────────────────────────────────
console.log("\nGuards:");
const { data: del2 } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: A.shop.id, p_note: `TRANSIT-TEST dlv2 ${RUN}`,
  p_parts: [], p_engine_ids: [eng.id],
});
const { data: line2 } = await A.client
  .from("shop_incoming_delivery_lines").select("*").eq("delivery_id", del2).single();
{
  const { error } = await B.client.rpc("fn_confirm_delivery", {
    p_delivery_id: del2, p_lines: [{ line_id: line2.id, qty_received: 1, shop_note: null }],
  });
  check("another shop cannot confirm it", !!error && /not addressed to your shop/i.test(error.message), error?.message);
}
{
  const { error } = await A.client.rpc("fn_confirm_delivery", {
    p_delivery_id: del2, p_lines: [{ line_id: line2.id, qty_received: 5, shop_note: null }],
  });
  check("cannot receive MORE than was sent", !!error && /more than was sent/i.test(error.message), error?.message);
}

// ── Engines confirm per serial ─────────────────────────────────────────────
console.log("\nEngine in transit → confirmed per serial:");
{
  const { data: e } = await owner.from("engines").select("status").eq("id", eng.id).single();
  check("engine status = in_transit while sent", e?.status === "in_transit");
  const { data: se } = await A.client.from("shop_engines").select("engine_id").eq("engine_id", eng.id);
  check("in-transit engine is NOT in shop stock yet", (se ?? []).length === 0);
}
{
  const { error } = await A.client.rpc("fn_confirm_delivery", {
    p_delivery_id: del2, p_lines: [{ line_id: line2.id, qty_received: 1, shop_note: null }],
  });
  check("engine confirmed", !error, error?.message);
  const { data: e } = await owner.from("engines").select("status, shop_id").eq("id", eng.id).single();
  check("engine now delivered at the shop", e?.status === "delivered" && e?.shop_id === A.shop.id);
  const { data: se } = await A.client
    .from("shop_engines").select("serial_number").eq("engine_id", eng.id).single();
  check("engine lands with its serial intact", se?.serial_number === SERIAL);
  const { data: d } = await owner.from("deliveries").select("status").eq("id", del2).single();
  check("full confirmation → status confirmed", d?.status === "confirmed");
}

// ── Owner resolves the shortfall ───────────────────────────────────────────
console.log("\nOwner resolves the 2 outstanding (1 returned, 1 written off):");
{
  const { error } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 1, p_resolution: "returned_to_master",
    p_reason: "TRANSIT-TEST found in the truck",
  });
  check("returned_to_master accepted", !error, error?.message);
  const b = await buckets();
  check("master 0 → 1, transit 2 → 1", b.master === 1 && b.transit === 1, JSON.stringify(b));
  check("RECONCILES: total still 10", b.total === 10, JSON.stringify(b));
}
{
  const { error } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 1, p_resolution: "written_off",
    p_reason: "TRANSIT-TEST nawala sa biyahe",
  });
  check("written_off accepted", !error, error?.message);
  const b = await buckets();
  check("transit cleared to 0", b.transit === 0, JSON.stringify(b));
  check("total drops 10 → 9 — exactly the written-off unit", b.total === 9, JSON.stringify(b));
}
{
  const { data: d } = await owner.from("deliveries").select("status, resolved_by").eq("id", delId).single();
  check("delivery status = resolved", d?.status === "resolved" && !!d?.resolved_by);
  const { error } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 1, p_resolution: "written_off", p_reason: "x",
  });
  check("nothing left to resolve", !!error && /outstanding/i.test(error.message), error?.message);
}

// ── Reporting split ────────────────────────────────────────────────────────
console.log("\nReports can tell transit losses apart from shop losses/returns:");
{
  const { data } = await owner
    .from("stock_movements").select("movement_type, qty_change")
    .eq("part_id", part.id).eq("delivery_id", delId);
  const types = (data ?? []).map((m) => m.movement_type);
  check("transit_writeoff recorded (not 'loss')", types.includes("transit_writeoff"));
  check("transit_return recorded (not 'return')", types.includes("transit_return"));
  check("no shop 'loss' rows were created", !types.includes("loss"));
  const wo = (data ?? []).find((m) => m.movement_type === "transit_writeoff");
  check("write-off is signed −1", wo?.qty_change === -1, `(got ${wo?.qty_change})`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
console.log("\nCleanup:");
{
  const shops = [A.shop.id, B.shop.id];
  await admin.from("notifications").delete().in("shop_id", shops);
  await admin.from("delivery_discrepancies").delete().in("delivery_line_id",
    ((await admin.from("delivery_lines").select("id").in("delivery_id", [delId, del2])).data ?? [])
      .map((l) => l.id));
  await admin.from("stock_movements").delete().eq("part_id", part.id);
  await admin.from("stock_movements").delete().eq("engine_id", eng.id);
  await admin.from("stock_movements").delete().in("shop_id", shops);
  await admin.from("deliveries").delete().in("shop_id", shops);
  await admin.from("receivings").delete().like("note", `%${RUN}%`);
  await admin.from("stock_levels").delete().eq("part_id", part.id);
  await admin.from("engines").delete().eq("id", eng.id);
  await admin.from("parts").delete().eq("id", part.id);
  await admin.from("engine_models").delete().eq("id", em.id);
  await admin.auth.admin.deleteUser(A.userId);
  await admin.auth.admin.deleteUser(B.userId);
  const { error } = await admin.from("shops").delete().in("id", shops);
  check("temp fixtures removed", !error, error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
