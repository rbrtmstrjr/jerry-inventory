/**
 * Stock alerts verification — effective thresholds (override vs default),
 * engine low-stock by MODEL count, master-vs-shop remedies, delivery requests,
 * notification scoping + dedupe, and RLS.
 *
 * Self-contained: builds its own temp supplier / part / engine model / two
 * shops + employees, runs through normal RLS, then hard-cleans everything.
 *
 * Run: node scripts/test-stock-alerts.mjs
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
    .from("shops").insert({ name: `ALERT-TEST ${label} ${RUN}` }).select().single();
  const email = `alert-${label.toLowerCase()}-${RUN.toLowerCase()}@test.local`;
  const password = `Alert!${RUN}`;
  const { data: u, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw new Error(error.message);
  await admin.from("profiles").insert({
    id: u.user.id, full_name: `ALERT-TEST ${label}`, role: "employee", shop_id: shop.id,
  });
  return { shop, userId: u.user.id, client: await signIn(email, password) };
}

const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");

/** Deliveries no longer auto-land (0028/0029) — the shop must confirm arrival. */
async function confirmAll(shopClient, deliveryId) {
  const { data: lines } = await shopClient
    .from("shop_incoming_delivery_lines")
    .select("id, qty_sent")
    .eq("delivery_id", deliveryId);
  const { error } = await shopClient.rpc("fn_confirm_delivery", {
    p_delivery_id: deliveryId,
    p_lines: (lines ?? []).map((l) => ({
      line_id: l.id,
      qty_received: l.qty_sent,
      shop_note: null,
    })),
  });
  if (error) throw new Error(`confirm delivery: ${error.message}`);
}

console.log("Setup: temp supplier, part (reorder 10), engine model (reorder 2), 2 shops");
const A = await makeShop("ShopA");
const B = await makeShop("ShopB");

const { data: sup } = await owner
  .from("suppliers").insert({ name: `ALERT-TEST Supplier ${RUN}`, contact: "0917-000-1111" })
  .select().single();
const { data: cat } = await owner.from("product_categories").select("id").limit(1).single();
const { data: part } = await owner.from("parts").insert({
  name: `ALERT-TEST Filter ${RUN}`, category_id: cat.id,
  cost_centavos: 5000, price_centavos: 9000,
  reorder_level: 10, preferred_supplier_id: sup.id,
}).select().single();
const { data: em } = await owner.from("engine_models").insert({
  brand: `ALERT-TEST${RUN}`, model: "X1", horsepower: 15,
  reorder_level: 2, preferred_supplier_id: sup.id,
}).select().single();

// 5 into master (below the reorder level of 10) + 1 engine (below 2)
const SERIAL = `ALERT-TEST-${RUN}`;
const { error: rcvErr } = await owner.rpc("fn_receive_stock", {
  p_supplier_id: sup.id, p_note: `ALERT-TEST setup ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 5, unit_cost_centavos: 5000 }],
  p_engines: [{
    serial_number: SERIAL, engine_model_id: em.id, condition: "brand_new",
    cost_centavos: 100000, price_centavos: 200000, warranty_months: null,
  }],
});
check("stock received into master", !rcvErr, rcvErr?.message);

// ── Master low stock → buy from a supplier ─────────────────────────────────
console.log("\nMaster low stock (remedy = buy from supplier):");
{
  const { data } = await owner.from("master_low_stock").select("*").eq("product_id", part.id).single();
  check("part listed (5 on hand ≤ 10)", data?.on_hand === 5 && data?.threshold === 10);
  check("shortfall = 5", data?.shortfall === 5, `(got ${data?.shortfall})`);
  check("supplier joined for the purchase list", data?.supplier_name?.includes("ALERT-TEST Supplier"));
}
{
  const { data } = await owner.from("master_low_stock").select("*").eq("product_id", em.id).single();
  check("engine model counted by in-master UNITS (1 ≤ 2)",
    data?.on_hand === 1 && data?.threshold === 2, `(got ${data?.on_hand}/${data?.threshold})`);
}

// ── Deliver to Shop A → shop low stock → remedy = request delivery ─────────
const { data: engRow } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();
const { data: dlvId, error: dlvErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: A.shop.id, p_note: `ALERT-TEST dlv ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 4 }], p_engine_ids: [engRow.id],
});
check("delivered 4 parts + 1 engine to Shop A", !dlvErr, dlvErr?.message);
await confirmAll(A.client, dlvId);

console.log("\nEffective threshold (override wins, else default):");
{
  const { data } = await A.client.from("shop_low_stock_safe").select("*").eq("product_id", part.id).maybeSingle();
  check("Shop A low on the DEFAULT threshold (4 ≤ 10)", data?.on_hand === 4 && data?.threshold === 10);
  check("flagged as not-an-override", data?.threshold_is_override === false);
}
{
  // a branch needs a smaller buffer than master
  await owner.from("shop_reorder_levels").insert({
    shop_id: A.shop.id, part_id: part.id, reorder_level: 2,
  });
  const { data } = await A.client.from("shop_low_stock_safe").select("*").eq("product_id", part.id).maybeSingle();
  check("override wins → 4 > 2, no longer low", !data, "(still listed as low)");
}
{
  await owner.from("shop_reorder_levels").insert({
    shop_id: A.shop.id, engine_model_id: em.id, reorder_level: 3,
  });
  const { data } = await A.client.from("shop_low_stock_safe").select("*").eq("product_id", em.id).maybeSingle();
  check("engine model low at the shop by unit count (1 ≤ 3 override)",
    data?.on_hand === 1 && data?.threshold === 3 && data?.threshold_is_override === true,
    `(got ${JSON.stringify(data)})`);
}
{
  const { data } = await A.client.from("shop_low_stock_safe").select("*").limit(1).maybeSingle();
  const keys = Object.keys(data ?? {});
  check("shop view exposes NO cost columns", !keys.some((k) => k.includes("cost")));
}

// ── RLS ────────────────────────────────────────────────────────────────────
console.log("\nRLS:");
{
  const { data } = await A.client.from("master_low_stock").select("*");
  check("shop cannot read master low stock", (data ?? []).length === 0);
}
{
  const { data } = await B.client.from("shop_low_stock_safe").select("shop_id");
  check("Shop B sees none of Shop A's rows",
    !(data ?? []).some((r) => r.shop_id === A.shop.id));
}

// ── Delivery request (shop → owner) ────────────────────────────────────────
console.log("\nDelivery request (shop asks owner; never touches stock):");
const { data: reqId, error: reqErr } = await A.client.rpc("fn_create_delivery_request", {
  p_lines: [{ part_id: part.id, engine_model_id: null, qty_requested: 6, note: null }],
  p_note: "ALERT-TEST kailangan bago mag-weekend",
});
check("shop created a request", !reqErr, reqErr?.message);
{
  const before = (await owner.from("stock_levels").select("qty").eq("part_id", part.id).eq("shop_id", A.shop.id).single()).data;
  check("request did NOT move stock (still 4)", before?.qty === 4);
}
{
  const { data } = await owner.from("delivery_requests").select("id, status").eq("id", reqId).single();
  check("owner sees it as open", data?.status === "open");
}
{
  const { data } = await B.client.from("delivery_requests").select("id").eq("id", reqId);
  check("other shop cannot see the request", (data ?? []).length === 0);
}
{
  const { error } = await B.client.rpc("fn_dismiss_delivery_request", { p_request_id: reqId, p_reason: "x" });
  check("shop cannot dismiss (owner-only)", !!error && /owner/i.test(error.message));
}

// ── Convert → existing delivery flow, then link ────────────────────────────
console.log("\nConvert to delivery (uses the EXISTING delivery flow):");
{
  const { data: delId, error } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: A.shop.id, p_note: `ALERT-TEST convert ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("owner delivered through fn_deliver_stock", !error, error?.message);
  await confirmAll(A.client, delId); // shop confirms arrival

  const { error: fErr } = await owner.rpc("fn_fulfill_delivery_request", {
    p_request_id: reqId, p_delivery_id: delId,
  });
  check("request linked + fulfilled", !fErr, fErr?.message);

  const { data: r } = await owner
    .from("delivery_requests").select("status, fulfilled_delivery_id, fulfilled_at").eq("id", reqId).single();
  check("status = fulfilled, linked to the delivery",
    r?.status === "fulfilled" && r?.fulfilled_delivery_id === delId && !!r?.fulfilled_at);

  const { data: lvl } = await owner.from("stock_levels").select("qty").eq("part_id", part.id).eq("shop_id", A.shop.id).single();
  check("stock moved via the normal flow (4 → 5)", lvl?.qty === 5, `(got ${lvl?.qty})`);
}
{
  const { error } = await owner.rpc("fn_fulfill_delivery_request", {
    p_request_id: reqId, p_delivery_id: null,
  });
  check("double-fulfil rejected", !!error);
}

// ── Notifications: scoping + dedupe ────────────────────────────────────────
console.log("\nNotifications:");
{
  const { data } = await owner
    .from("notifications").select("*")
    .eq("type", "master_low_stock").eq("ref_id", part.id);
  check("owner got a master_low_stock alert (buy from supplier)", (data ?? []).length >= 1);
  const unread = (data ?? []).filter((n) => !n.read_at);
  check("deduped — only ONE unread alert despite several stock events",
    unread.length === 1, `(got ${unread.length})`);
}
{
  const { data } = await A.client
    .from("notifications").select("*").eq("type", "shop_low_stock").eq("ref_id", part.id);
  check("Shop A got its own shop_low_stock alert", (data ?? []).length >= 1);
  check("shop only ever sees shop-role rows",
    (data ?? []).every((n) => n.recipient_role === "shop" && n.shop_id === A.shop.id));
}
{
  const { data } = await B.client.from("notifications").select("id").eq("ref_id", part.id);
  check("Shop B got nothing about Shop A's stock", (data ?? []).length === 0);
}
{
  const { data } = await owner
    .from("notifications").select("id").eq("type", "delivery_request").eq("ref_id", reqId);
  check("owner was notified of the delivery request", (data ?? []).length === 1);
}
{
  const { data } = await A.client
    .from("notifications").select("id, type").eq("type", "delivery_request_fulfilled").eq("ref_id", reqId);
  check("shop was told its request was fulfilled", (data ?? []).length === 1);
}
{
  // owner alerts are per-shop, not collapsed across shops
  const { data } = await owner
    .from("notifications").select("shop_id").eq("type", "shop_low_stock").eq("ref_id", part.id);
  check("owner's shop_low_stock alert carries the shop context",
    (data ?? []).some((n) => n.shop_id === A.shop.id));
}

console.log("\nSMS channel is registered but disabled (drop-in ready, not built):");
{
  const { data } = await owner.from("notification_channels").select("code, enabled");
  const sms = (data ?? []).find((c) => c.code === "sms");
  const inApp = (data ?? []).find((c) => c.code === "in_app");
  check("in_app enabled, sms present but disabled",
    inApp?.enabled === true && sms?.enabled === false);
  const { data: d } = await owner
    .from("notification_dispatches").select("channel, status").eq("channel", "in_app").limit(1);
  check("in_app dispatch rows are recorded", (d ?? []).length >= 1);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
console.log("\nCleanup:");
{
  const shops = [A.shop.id, B.shop.id];
  await admin.from("notifications").delete().in("ref_id", [part.id, em.id, reqId]);
  await admin.from("delivery_requests").delete().in("shop_id", shops); // cascades lines
  await admin.from("shop_reorder_levels").delete().in("shop_id", shops);
  // movements first (incl. the master-side rows where shop_id IS NULL)
  await admin.from("stock_movements").delete().eq("part_id", part.id);
  await admin.from("stock_movements").delete().eq("engine_id", engRow.id);
  await admin.from("stock_movements").delete().in("shop_id", shops);
  await admin.from("deliveries").delete().in("shop_id", shops);
  await admin.from("receivings").delete().like("note", `%${RUN}%`);
  await admin.from("stock_levels").delete().eq("part_id", part.id);
  await admin.from("engines").delete().eq("id", engRow.id);
  await admin.from("parts").delete().eq("id", part.id);
  await admin.from("engine_models").delete().eq("id", em.id);
  await admin.from("suppliers").delete().eq("id", sup.id);
  await admin.auth.admin.deleteUser(A.userId);
  await admin.auth.admin.deleteUser(B.userId);
  const { error } = await admin.from("shops").delete().in("id", shops);
  check("temp fixtures removed", !error, error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
