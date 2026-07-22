/**
 * Damage & loss on receipt (0058) — delivery confirmation records
 * good/damaged/missing (damaged distinct from missing), the owner resolves
 * damaged/missing with a reason, and returns inspect good vs damaged (good →
 * master, damaged → approved loss at cost). The RECONCILIATION INVARIANT
 * (master + in-transit + shops = total owned) holds after every step.
 *
 * Self-contained: temp shop + employee via the service role, real RLS, hard-clean.
 *
 * Run: node scripts/test-receipt-damage.mjs
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
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
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
const owner = await signIn("robertmaestro09@gmail.com", "rajonrondo09");

const { data: shop } = await admin
  .from("shops").insert({ name: `DMG-TEST ${RUN}` }).select().single();
const email = `dmg-${RUN.toLowerCase()}@test.local`;
const password = `Dmg!${RUN}`;
const { data: u } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
await admin.from("profiles").insert({
  id: u.user.id, full_name: `DMG-TEST`, role: "employee", shop_id: shop.id,
});
const A = await signIn(email, password);

const PART_COST = 1000, ENG_COST = 100000;
const { data: cat } = await owner.from("product_categories").select("id").limit(1).single();
const { data: part } = await admin.from("parts").insert({
  name: `DMG-TEST Widget ${RUN}`, category_id: cat.id,
  cost_centavos: PART_COST, price_centavos: 2000,
}).select().single();
const { data: em } = await admin.from("engine_models").insert({
  brand: `DMG-TEST${RUN}`, model: "D1", horsepower: 9.9,
}).select().single();
const SERIAL = `DMG-TEST-${RUN}`;
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `DMG-TEST setup ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: PART_COST }],
  p_engines: [{
    serial_number: SERIAL, engine_model_id: em.id, condition: "brand_new",
    cost_centavos: ENG_COST, price_centavos: 200000, warranty_months: null,
  }],
});
const { data: eng } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();

async function buckets() {
  const { data: levels } = await owner.from("stock_levels").select("qty, shop_id").eq("part_id", part.id);
  const master = (levels ?? []).filter((r) => r.shop_id === null).reduce((s, r) => s + r.qty, 0);
  const shops = (levels ?? []).filter((r) => r.shop_id !== null).reduce((s, r) => s + r.qty, 0);
  const { data: t } = await owner.from("stock_in_transit").select("qty").eq("part_id", part.id);
  const transit = (t ?? []).reduce((s, r) => s + r.qty, 0);
  return { master, shops, transit, total: master + shops + transit };
}

// ── 1. Delivery: 10 sent → 8 good, 1 damaged, 1 missing ─────────────────────
console.log("Delivery confirm records good / damaged / missing (all distinct):");
const { data: delId } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: shop.id, p_note: `DMG-TEST dlv ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10 }], p_engine_ids: [],
});
const { data: line } = await A
  .from("shop_incoming_delivery_lines").select("*").eq("delivery_id", delId).single();

{
  // a damage photo under a FOREIGN shop prefix is rejected (state unchanged)
  const foreign = `shop-00000000-0000-0000-0000-000000000000/delivery-${line.id}/x.webp`;
  const { error } = await A.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: [{ line_id: line.id, qty_received: 8, qty_damaged: 1, damage_photo_path: foreign }],
  });
  check("damage photo under a foreign shop prefix is rejected",
    !!error && /own shop folder/i.test(error.message), error?.message);
  const { data: d } = await owner.from("deliveries").select("status").eq("id", delId).single();
  check("rejected confirm left the delivery in_transit", d?.status === "in_transit");
}
{
  const own = `shop-${shop.id}/delivery-${line.id}/dmg.webp`;
  const { data, error } = await A.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: [{ line_id: line.id, qty_received: 8, qty_damaged: 1,
                shop_note: "1 cracked casing", damage_photo_path: own }],
  });
  check("confirm accepted", !error, error?.message);
  check("breakdown: 8 good · 1 damaged · 1 missing",
    data?.landed === 8 && data?.damaged === 1 && data?.missing === 1, JSON.stringify(data));
  check("delivery flipped to discrepancy", data?.status === "discrepancy");
}
{
  const { data: l } = await owner.from("delivery_lines").select("*").eq("id", line.id).single();
  check("qty_damaged recorded on the line", l?.qty_damaged === 1, `(got ${l?.qty_damaged})`);
  check("qty_received (good) recorded", l?.qty_received === 8);
  check("damage photo path stored (own prefix)",
    l?.damage_photo_path === `shop-${shop.id}/delivery-${line.id}/dmg.webp`);
  check("outstanding = damaged + missing = 2", l?.qty_outstanding === 2);
  const b = await buckets();
  check("8 good LANDED in shop stock", b.shops === 8, JSON.stringify(b));
  check("damaged does NOT land — 2 stay in transit", b.transit === 2, JSON.stringify(b));
  check("RECONCILES: total still 10", b.total === 10, JSON.stringify(b));
}
{
  // the shop can record damage but cannot write anything off
  const { error } = await A.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 1, p_resolution: "written_off", p_reason: "damaged",
  });
  check("shop CANNOT resolve/write off the damaged unit", !!error && /owner/i.test(error.message), error?.message);
}

// ── 2. Owner resolves damaged vs missing, each with a reason ─────────────────
console.log("\nOwner resolves with reasons (damaged → supplier, missing → lost):");
{
  const { error } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 1, p_resolution: "returned_to_master", p_reason: "damaged",
  });
  check("damaged → returned_to_master (send to supplier)", !error, error?.message);
  const { error: e2 } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 1, p_resolution: "written_off", p_reason: "lost_in_transit",
  });
  check("missing → written_off (lost in transit)", !e2, e2?.message);
}
{
  const { data: disc } = await owner.from("delivery_discrepancies")
    .select("reason, resolution").eq("delivery_line_id", line.id);
  const reasons = (disc ?? []).map((d) => d.reason).sort();
  check("both reasons audited on delivery_discrepancies",
    reasons.includes("damaged") && reasons.includes("lost_in_transit"), reasons.join(","));
  const { data: mv } = await owner.from("stock_movements")
    .select("movement_type, note, qty_change").eq("part_id", part.id).eq("delivery_id", delId);
  const wo = (mv ?? []).find((m) => m.movement_type === "transit_writeoff");
  const ret = (mv ?? []).find((m) => m.movement_type === "transit_return" && m.qty_change > 0);
  check("write-off carries the 'lost_in_transit' reason", /lost_in_transit/.test(wo?.note ?? ""), wo?.note);
  check("transit_return carries the 'damaged' reason", /damaged/.test(ret?.note ?? ""), ret?.note);
  check("no shop 'loss' row created for a transit shortfall",
    !(mv ?? []).some((m) => m.movement_type === "loss"));
  const b = await buckets();
  check("damaged unit recovered to master (1), 1 written off → total 10→9",
    b.master === 1 && b.total === 9 && b.transit === 0, JSON.stringify(b));
}

// ── 3. Return inspection: good → master, damaged → approved loss ─────────────
console.log("\nReturn inspection: 5 good back to master, 2 damaged written off:");
{
  const before = await buckets();  // master 1, shops 8, total 9
  const { error } = await owner.rpc("fn_return_stock", {
    p_shop_id: shop.id, p_reason: `DMG-TEST return ${RUN}`,
    p_parts: [{ part_id: part.id, qty_good: 5, qty_damaged: 2, note: "water-damaged" }],
    p_engine_ids: [],
  });
  check("return accepted", !error, error?.message);
  const b = await buckets();
  check("shop 8 → 1 (7 pulled: 5 good + 2 damaged)", b.shops === 1, JSON.stringify(b));
  check("only GOOD re-entered master (1 → 6)", b.master === 6, JSON.stringify(b));
  check("damaged never reached master — total 9 → 7", b.total === 7, JSON.stringify(b));
  check("(sanity) before total was 9", before.total === 9, JSON.stringify(before));
}
{
  const { data: loss } = await owner.from("losses")
    .select("qty, reason, status, value_centavos, shop_id, part_id")
    .eq("part_id", part.id).eq("shop_id", shop.id).maybeSingle();
  check("damaged became an APPROVED loss at the shop", loss?.status === "approved");
  check("loss qty = 2, reason nasira (damaged)", loss?.qty === 2 && loss?.reason === "nasira");
  check("loss valued at COST (2 × 1000 = 2000)", loss?.value_centavos === 2 * PART_COST,
    `(got ${loss?.value_centavos})`);
  const { data: mv } = await owner.from("stock_movements")
    .select("movement_type, qty_change, shop_id").eq("part_id", part.id).eq("movement_type", "loss");
  check("loss booked at the shop (−2 @shop)",
    (mv ?? []).some((m) => m.qty_change === -2 && m.shop_id === shop.id));
}

// ── 4. Engine returned damaged → soft-deleted + approved loss at cost ────────
console.log("\nEngine returned damaged → written off as an approved loss:");
{
  const { data: dE } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: shop.id, p_note: `DMG-TEST eng ${RUN}`, p_parts: [], p_engine_ids: [eng.id],
  });
  const { data: lE } = await A.from("shop_incoming_delivery_lines").select("id").eq("delivery_id", dE).single();
  await A.rpc("fn_confirm_delivery", { p_delivery_id: dE, p_lines: [{ line_id: lE.id, qty_received: 1 }] });

  const { error } = await owner.rpc("fn_return_stock", {
    p_shop_id: shop.id, p_reason: `DMG-TEST eng return ${RUN}`,
    p_parts: [], p_engine_ids: [{ engine_id: eng.id, condition: "damaged", note: "dropped" }],
  });
  check("engine damaged-return accepted", !error, error?.message);
  const { data: e } = await owner.from("engines").select("deleted_at, status").eq("id", eng.id).single();
  check("engine soft-deleted (written off, not back in master)", !!e?.deleted_at);
  const { data: loss } = await owner.from("losses")
    .select("value_centavos, reason, status").eq("engine_id", eng.id).maybeSingle();
  check("engine loss approved, valued at engine cost", loss?.status === "approved" && loss?.value_centavos === ENG_COST);
  const { data: mv } = await owner.from("stock_movements")
    .select("movement_type, qty_change").eq("engine_id", eng.id).eq("movement_type", "loss");
  check("engine loss movement −1 @shop", (mv ?? []).some((m) => m.qty_change === -1));
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
console.log("\nCleanup:");
{
  const dls = ((await admin.from("delivery_lines").select("id, delivery_id")
    .in("delivery_id", ((await admin.from("deliveries").select("id").eq("shop_id", shop.id)).data ?? []).map((d) => d.id))).data ?? []);
  await admin.from("delivery_discrepancies").delete().in("delivery_line_id", dls.map((l) => l.id));
  await admin.from("notifications").delete().eq("shop_id", shop.id);
  await admin.from("stock_movements").delete().eq("part_id", part.id);
  await admin.from("stock_movements").delete().eq("engine_id", eng.id);
  await admin.from("stock_movements").delete().eq("shop_id", shop.id);
  await admin.from("losses").delete().eq("shop_id", shop.id);
  await admin.from("returns").delete().eq("shop_id", shop.id);
  await admin.from("deliveries").delete().eq("shop_id", shop.id);
  await admin.from("receivings").delete().like("note", `%${RUN}%`);
  await admin.from("stock_levels").delete().eq("part_id", part.id);
  await admin.from("engines").delete().eq("id", eng.id);
  await admin.from("parts").delete().eq("id", part.id);
  await admin.from("engine_models").delete().eq("id", em.id);
  await admin.auth.admin.deleteUser(u.user.id);
  const { error } = await admin.from("shops").delete().eq("id", shop.id);
  check("temp fixtures removed", !error, error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
