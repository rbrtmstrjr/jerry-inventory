/**
 * ON-HAND ENGINES — give every shop sellable engines on the shelf.
 *
 * The load seed sold nearly all engines it created, leaving shops with ~0
 * on-hand engines — so shop engine-sale / warranty flows can't be QA'd. This
 * lands a small brand-new engine stock per shop through a confirmed delivery,
 * mirroring the load seed's engine ledger (receive → deliver → confirm) so the
 * chain of custody stays consistent. Engines aren't in stock_levels, so the
 * parts reconciliation invariant is untouched; test-movements stays 51/0.
 *
 * High serials (LT9-9xxxxx) can't collide with the load seed's LT3- range.
 *   Run after seed-load-test:  node scripts/seed-shop-engines.mjs
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const FORCE = process.argv.includes("--force");
const PER_SHOP = Number(process.env.PER_SHOP ?? 5);
const uid = () => randomUUID();
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pad = (n, w) => String(n).padStart(w, "0");
const at = (d, h) => `${d}T${pad(h, 2)}:${pad(rnd(0, 59), 2)}:00+08:00`;
const today = new Date().toISOString().slice(0, 10);
const day = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

const { data: ownerP } = await admin.from("profiles").select("id").eq("role", "owner").limit(1).single();
const OWNER = ownerP.id;
const { data: shops } = await admin.from("shops").select("id, name").is("deleted_at", null).order("name");
const { data: emps } = await admin.from("profiles").select("id, shop_id").eq("role", "employee").eq("active", true);
const userOf = new Map(emps.map((e) => [e.shop_id, e.id]));
const { data: models } = await admin.from("engine_models").select("id, brand, model").is("deleted_at", null);
const { data: sup } = await admin.from("suppliers").select("id").is("deleted_at", null).limit(1).single();

{
  const { count } = await admin.from("engines").select("id", { count: "exact", head: true }).like("serial_number", "LT9-9%");
  if (count > 0 && !FORCE) { console.error(`${count} QA engines already exist — pass --force to add more.`); process.exit(2); }
}

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rows = { receivings: [], receiving_lines: [], engines: [], deliveries: [], delivery_lines: [], movements: [] };
let serial = 900000, total = 0;

// one receiving header carries all the engine costs (paid)
const rcvId = uid();
const rcvAt = at(day(6), 8);

for (const shop of shops) {
  const del = { id: uid(), shop_id: shop.id, from_shop_id: null, delivered_at: at(day(5), 9), created_by: OWNER, status: "confirmed", confirmed_at: at(day(5), 14), confirmed_by: userOf.get(shop.id), note: "[QA] engine restock" };
  rows.deliveries.push(del);
  for (let i = 0; i < PER_SHOP; i++) {
    const m = pick(models);
    const cost = rnd(40000, 120000) * 100;
    const eng = { id: uid(), serial_number: `LT9-${pad(++serial, 6)}`, engine_model_id: m.id, condition: "brand_new", cost_centavos: cost, price_centavos: Math.round(cost * (1.25 + Math.random() * 0.3)), status: "delivered", shop_id: shop.id, created_at: rcvAt };
    rows.engines.push(eng);
    rows.receiving_lines.push({ id: uid(), receiving_id: rcvId, engine_id: eng.id, qty: 1, unit_cost_centavos: cost, created_at: rcvAt });
    rows.movements.push({ id: uid(), movement_type: "received", engine_id: eng.id, qty_change: 1, shop_id: null, actor: OWNER, receiving_id: rcvId, created_at: rcvAt });
    rows.movements.push({ id: uid(), movement_type: "delivery", engine_id: eng.id, qty_change: -1, shop_id: null, actor: OWNER, delivery_id: del.id, created_at: del.delivered_at });
    rows.movements.push({ id: uid(), movement_type: "delivery", engine_id: eng.id, qty_change: 1, shop_id: shop.id, actor: userOf.get(shop.id), delivery_id: del.id, created_at: del.confirmed_at });
    rows.delivery_lines.push({ id: uid(), delivery_id: del.id, engine_id: eng.id, qty: 1, qty_received: 1, created_at: del.delivered_at });
    total += cost;
  }
}
rows.receivings.push({ id: rcvId, supplier_id: sup.id, received_at: rcvAt, created_by: OWNER, note: "[QA] engine restock", total_amount: total, amount_paid: total, payment_status: "paid" });

async function ins(t, r) { if (r.length) { const { error } = await admin.from(t).insert(r); if (error) throw new Error(`${t}: ${error.message}`); } }
await ins("receivings", rows.receivings);
await ins("engines", rows.engines);
await ins("receiving_lines", rows.receiving_lines);
await ins("deliveries", rows.deliveries);
await ins("delivery_lines", rows.delivery_lines);
await ins("stock_movements", rows.movements);

console.log(`DONE — ${rows.engines.length} on-hand engines added (${PER_SHOP}/shop across ${shops.length} shops).`);
console.log(`  Certify: node scripts/test-movements.mjs (engines don't touch the parts invariant — stays 51/0).`);
