/**
 * Reviewed History verification — the unified reviewed_items list: all three
 * item types present with correct type/status, filters combine (shop + type +
 * status + date + search), server-side pagination, owner-only RLS, and
 * read-only (no path mutates).
 *
 * Self-contained: two temp shops + employees via the service role, real RLS,
 * then hard-cleans everything it made.
 *
 * Run: node scripts/test-reviewed-history.mjs
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
    .from("shops").insert({ name: `HIST-TEST ${label} ${RUN}` }).select().single();
  const email = `hist-${label.toLowerCase()}-${RUN.toLowerCase()}@test.local`;
  const password = `Hist!${RUN}`;
  const { data: u, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw new Error(error.message);
  await admin.from("profiles").insert({
    id: u.user.id, full_name: `HIST-TEST ${label}`, role: "employee", shop_id: shop.id,
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

console.log("Setup: two temp shops, engine + parts, then produce one of each reviewed type");
const A = await makeShop("ShopA");
const B = await makeShop("ShopB");

const { data: cat } = await owner.from("product_categories").select("id").limit(1).single();
const { data: part } = await owner.from("parts").insert({
  name: `HIST-TEST Filter ${RUN}`, category_id: cat.id,
  cost_centavos: 5000, price_centavos: 9000,
}).select().single();
const { data: model } = await owner.from("engine_models").select("id").eq("model", "15MH").single();

const SERIAL = `HIST-TEST-${RUN}`;
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `HIST-TEST setup ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 20, unit_cost_centavos: 5000 }],
  p_engines: [{
    serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new",
    cost_centavos: 2000000, price_centavos: 0, warranty_months: null,
    margin_floor_pct: 50, margin_mid_pct: 75, margin_asking_pct: 100,
  }],
});
const { data: eng } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();

const { data: dlvA } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: A.shop.id, p_note: `HIST-TEST dlv ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10 }], p_engine_ids: [eng.id],
});
await confirmAll(A.client, dlvA);
const { data: dlvB } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: B.shop.id, p_note: `HIST-TEST dlvB ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 5 }], p_engine_ids: [],
});
await confirmAll(B.client, dlvB);

// Shop A: an engine sale (partial → creates an utang) + a loss
const { data: saleId } = await A.client.rpc("fn_record_sale", {
  p_customer_id: null,
  p_customer: { name: `HIST-TEST Ka Berting ${RUN}`, phone: "0917-222-3333" },
  p_part_lines: [],
  p_engine_lines: [{ engine_id: eng.id, agreed_price_centavos: 3700000 }],
  p_payment_type: "partial",
  p_amount_paid_centavos: 1000000,
});
const { data: lossId } = await A.client.rpc("fn_record_loss", {
  p_part_id: part.id, p_engine_id: null, p_qty: 2,
  p_reason: "nasira", p_note: `HIST-TEST nabasag ${RUN}`,
});
// Shop B: a sale we will REJECT
const { data: rejectedSaleId } = await B.client.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: null,
  p_part_lines: [{ part_id: part.id, qty: 1 }], p_engine_lines: [],
});

{
  const { data: subA } = await A.client.rpc("fn_submit_shop_batch");
  const { error } = await owner.rpc("fn_approve_batch", { p_batch_id: subA.batch_id, p_note: null });
  check("Shop A batch approved (sale + loss)", !error, error?.message);
  const { data: subB } = await B.client.rpc("fn_submit_shop_batch");
  check("Shop B batch submitted", !!subB?.batch_id);
  const { error: rErr } = await owner.rpc("fn_review_submission", {
    p_kind: "sale", p_id: rejectedSaleId, p_action: "reject", p_note: `HIST-TEST mali ang bilang ${RUN}`,
  });
  check("Shop B sale rejected", !rErr, rErr?.message);
}
// Shop A: an utang payment (posts immediately)
const { data: payId, error: payErr } = await A.client.rpc("fn_record_utang_payment", {
  p_sale_id: saleId, p_amount_centavos: 700000,
});
check("utang payment recorded", !payErr, payErr?.message);

const mine = (rows) =>
  (rows ?? []).filter((r) => r.shop_id === A.shop.id || r.shop_id === B.shop.id);

// ── All three types present, correctly typed ──────────────────────────────
console.log("\nAll three item types appear with the right type + status:");
{
  const { data } = await owner.from("reviewed_items").select("*").in("shop_id", [A.shop.id, B.shop.id]);
  const rows = mine(data);
  const sale = rows.find((r) => r.id === saleId);
  const loss = rows.find((r) => r.id === lossId);
  const pay = rows.find((r) => r.id === payId);
  const rej = rows.find((r) => r.id === rejectedSaleId);

  check("approved sale listed as type=sale", sale?.item_type === "sale" && sale?.status === "approved");
  check("approved loss listed as type=loss", loss?.item_type === "loss" && loss?.status === "approved");
  check("payment listed as type=utang_payment",
    pay?.item_type === "utang_payment" && pay?.status === "approved");
  check("rejected sale listed as rejected", rej?.item_type === "sale" && rej?.status === "rejected");
  check("pending/recorded items are NOT in reviewed history",
    !rows.some((r) => r.status === "pending" || r.status === "recorded"));

  check("sale summary carries the engine serial", (sale?.summary ?? "").includes(SERIAL));
  check("sale amount = agreed price ₱37,000", sale?.amount_centavos === 3700000, `(got ${sale?.amount_centavos})`);
  check("loss summary carries the reason", (loss?.summary ?? "").includes("nasira"));
  check("payment amount = ₱7,000", pay?.amount_centavos === 700000);
  check("customer surfaced on the sale row", (sale?.customer_name ?? "").includes("Ka Berting"));
}

// ── Filters ───────────────────────────────────────────────────────────────
console.log("\nFilters (shop / type / status / date / search) combine:");
{
  const { data } = await owner.from("reviewed_items").select("*").eq("shop_id", A.shop.id);
  const rows = mine(data);
  check("shop filter scopes to one shop",
    rows.length > 0 && rows.every((r) => r.shop_id === A.shop.id));
  check("shop filter excludes the other shop's rejected sale",
    !rows.some((r) => r.id === rejectedSaleId));
}
{
  const { data } = await owner.from("reviewed_items").select("*")
    .in("shop_id", [A.shop.id, B.shop.id]).eq("item_type", "loss");
  check("type filter returns only losses",
    (data ?? []).length === 1 && data[0].id === lossId);
}
{
  const { data } = await owner.from("reviewed_items").select("*")
    .in("shop_id", [A.shop.id, B.shop.id]).eq("status", "rejected");
  check("status filter returns only rejected",
    (data ?? []).length === 1 && data[0].id === rejectedSaleId);
}
{
  // shop + type + status together
  const { data } = await owner.from("reviewed_items").select("*")
    .eq("shop_id", A.shop.id).eq("item_type", "sale").eq("status", "approved");
  check("shop + type + status combine", (data ?? []).length === 1 && data[0].id === saleId);
}
{
  const { data } = await owner.from("reviewed_items").select("*")
    .in("shop_id", [A.shop.id, B.shop.id])
    .ilike("search_text", `%${SERIAL.toLowerCase()}%`);
  check("search finds the sale by engine serial",
    (data ?? []).length === 1 && data[0].id === saleId);
}
{
  const { data } = await owner.from("reviewed_items").select("*")
    .in("shop_id", [A.shop.id, B.shop.id])
    .ilike("search_text", "%ka berting%");
  check("search finds items by customer name", (data ?? []).length >= 1);
}
{
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10); // PH date
  const { data: inRange } = await owner.from("reviewed_items").select("id")
    .in("shop_id", [A.shop.id, B.shop.id]).gte("event_date", today).lte("event_date", today);
  check("date range (today, PH) returns our items", (inRange ?? []).length >= 4,
    `(got ${(inRange ?? []).length})`);
  const { data: outRange } = await owner.from("reviewed_items").select("id")
    .in("shop_id", [A.shop.id, B.shop.id]).lte("event_date", "2020-01-01");
  check("date range excludes outside the window", (outRange ?? []).length === 0);
}

// ── Server-side pagination ────────────────────────────────────────────────
console.log("\nServer-side pagination (never fetch unbounded):");
{
  const { data: p1, count } = await owner
    .from("reviewed_items")
    .select("*", { count: "exact" })
    .in("shop_id", [A.shop.id, B.shop.id])
    .order("event_at", { ascending: false })
    .range(0, 1);
  check("page 1 returns exactly the page size", (p1 ?? []).length === 2);
  check("exact total count returned alongside", (count ?? 0) >= 4, `(got ${count})`);
  const { data: p2 } = await owner
    .from("reviewed_items").select("*")
    .in("shop_id", [A.shop.id, B.shop.id])
    .order("event_at", { ascending: false })
    .range(2, 3);
  check("page 2 returns different rows",
    (p2 ?? []).length > 0 && !(p1 ?? []).some((a) => (p2 ?? []).some((b) => b.id === a.id)));
}
{
  const { data } = await owner.from("reviewed_items").select("event_at")
    .in("shop_id", [A.shop.id, B.shop.id]).order("event_at", { ascending: false });
  const times = (data ?? []).map((r) => r.event_at);
  check("default sort is newest first",
    times.every((t, i) => i === 0 || times[i - 1] >= t));
}

// ── Owner-only ────────────────────────────────────────────────────────────
console.log("\nOwner-only:");
{
  const { data } = await A.client.from("reviewed_items").select("id");
  check("a shop sees NOTHING in reviewed history", (data ?? []).length === 0);
}

// ── Read-only ─────────────────────────────────────────────────────────────
console.log("\nRead-only (history can never mutate):");
{
  const { error } = await owner.from("reviewed_items").insert({ id: saleId });
  check("cannot insert into the view", !!error);
}
{
  const { error } = await owner.from("reviewed_items").delete().eq("id", saleId);
  check("cannot delete through the view", !!error);
}
{
  const { data: s } = await owner.from("sales").select("status").eq("id", saleId).single();
  check("source sale untouched by browsing history", s?.status === "approved");
}

// ── Cleanup ───────────────────────────────────────────────────────────────
console.log("\nCleanup:");
{
  const shops = [A.shop.id, B.shop.id];
  await admin.from("notifications").delete().in("shop_id", shops);
  await admin.from("warranties").delete().eq("engine_id", eng.id);
  await admin.from("stock_movements").delete().eq("engine_id", eng.id);
  await admin.from("stock_movements").delete().eq("part_id", part.id);
  await admin.from("stock_movements").delete().in("shop_id", shops);
  await admin.from("sales").delete().in("shop_id", shops);   // cascades sale_lines + utang_payments
  await admin.from("losses").delete().in("shop_id", shops);
  await admin.from("submission_batches").delete().in("shop_id", shops);
  await admin.from("deliveries").delete().in("shop_id", shops);
  await admin.from("receivings").delete().like("note", `%${RUN}%`);
  await admin.from("stock_levels").delete().eq("part_id", part.id);
  await admin.from("engines").delete().eq("id", eng.id);
  await admin.from("parts").delete().eq("id", part.id);
  await admin.from("customers").delete().like("name", `%${RUN}%`);
  await admin.auth.admin.deleteUser(A.userId);
  await admin.auth.admin.deleteUser(B.userId);
  const { error } = await admin.from("shops").delete().in("id", shops);
  check("temp fixtures removed", !error, error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
