/**
 * ADD ON-HAND STOCK — non-destructive top-up on an existing seed:
 *   A) NEW_PRODUCTS new parts into MASTER inventory (products only), and
 *   B) ENGINES_PER_SHOP delivered (on-hand, unsold) engines at EVERY shop.
 *
 * Invariant-safe:
 *   • New products: received into master → a master stock_levels row (shop_id
 *     NULL) whose qty EQUALS the received movement, so Σ movements = stock_levels
 *     at master still holds.
 *   • Engines: received to master then delivered to the shop (confirmed) — the
 *     same receive→deliver trail the load seed writes for an unsold engine.
 *     Engines are NOT in stock_levels, so the part reconciliation is untouched;
 *     each engine's chain of custody (received → delivered) stays coherent.
 *
 * Distinct id ranges: parts SKU-N####/GT8…, engine serials XS-…, notes tagged
 * "STOCK-BOOST". Run any time after seed-load-test:
 *   NEW_PRODUCTS=500 ENGINES_PER_SHOP=500 node scripts/seed-more-stock.mjs
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { samplePng } from "./_sample-image.mjs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const NEW_PRODUCTS = Number(process.env.NEW_PRODUCTS ?? 500);
const ENGINES_PER_SHOP = Number(process.env.ENGINES_PER_SHOP ?? 500);
const IMG = "seed-sample/product.png";
const uid = () => randomUUID();
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pad = (n, w) => String(n).padStart(w, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

let inserted = 0;
async function ins(table, rows) {
  if (!rows.length) return;
  const size = table === "stock_movements" ? 400 : 1000;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    for (let attempt = 1; ; attempt++) {
      const { error } = await admin.from(table).insert(chunk);
      if (!error) break;
      if (attempt > 1 && error.code === "23505") break;
      if (attempt >= 5) throw new Error(`${table}: ${error.message}`);
      console.log(`  retry ${attempt} on ${table} (${error.message.slice(0, 60)})`);
      await sleep(attempt * 4000);
    }
    inserted += chunk.length;
  }
}
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 60000).toFixed(1)}m`;

// ── reference data ──────────────────────────────────────────────────────────
const { data: ownerProf } = await admin.from("profiles").select("id").eq("role", "owner").limit(1).single();
const OWNER = ownerProf.id;
const { data: shopProfs } = await admin.from("profiles").select("id, shop_id").eq("role", "employee").not("shop_id", "is", null);
const shops = (shopProfs ?? []).map((p) => ({ id: p.shop_id, user: p.id }));
const { data: cats } = await admin.from("product_categories").select("id").is("deleted_at", null);
const { data: models } = await admin.from("engine_models").select("id").is("deleted_at", null);
const { data: suppliers } = await admin.from("suppliers").select("id").is("deleted_at", null);
if (!shops.length || !cats?.length || !models?.length || !suppliers?.length) {
  console.error("Needs existing shops + categories + engine models + suppliers — run seed-load-test first.");
  process.exit(1);
}

// make sure the shared sample image exists (idempotent)
await admin.storage.from("product-images").upload(IMG, samplePng(400), { contentType: "image/png", upsert: true });

// ── A) new products into MASTER stock ───────────────────────────────────────
console.log(`Adding ${NEW_PRODUCTS} products to master + ${ENGINES_PER_SHOP} engines/shop…`);
{
  const NOUNS = ["Camshaft", "Crankshaft", "Cylinder Head", "Flywheel", "Manifold", "Reed Valve",
    "Trim Motor", "Tilt Pin", "Shift Rod", "Prop Nut", "Fuel Pump", "Voltage Regulator",
    "Stator", "Rectifier", "Thermostat", "Water Tube", "Drive Shaft", "Gear Case", "Clamp Bracket", "Tiller Handle"];
  const parts = [];
  const rl = [], rmov = [], levels = [];
  const rcv = { id: uid(), supplier_id: pick(suppliers).id, received_at: nowIso(), created_by: OWNER,
    note: "STOCK-BOOST master products", total_amount: 0, amount_paid: 0, payment_status: "paid" };
  let total = 0;
  for (let i = 0; i < NEW_PRODUCTS; i++) {
    const cost = rnd(80, 12000) * 100;
    const pid = uid();
    const qty = rnd(50, 200);
    parts.push({ id: pid, name: `${pick(NOUNS)} ${pad(i, 3)}-N${rnd(1, 9)}X`, category_id: pick(cats).id,
      sku: `SKU-N${pad(i, 4)}`, barcode: `GT8${pad(i, 7)}`, unit: "pc",
      cost_centavos: cost, price_centavos: Math.round(cost * (1.3 + Math.random() * 0.5)),
      reorder_level: rnd(5, 20), image_path: IMG, created_at: nowIso() });
    rl.push({ id: uid(), receiving_id: rcv.id, part_id: pid, qty, unit_cost_centavos: cost, created_at: nowIso() });
    rmov.push({ id: uid(), movement_type: "received", part_id: pid, qty_change: qty, shop_id: null, actor: OWNER, receiving_id: rcv.id, created_at: nowIso() });
    levels.push({ part_id: pid, shop_id: null, qty }); // master stock == received (invariant)
    total += qty * cost;
  }
  rcv.total_amount = total; rcv.amount_paid = total;
  await ins("parts", parts);
  await ins("receivings", [rcv]);
  await ins("receiving_lines", rl);
  await ins("stock_movements", rmov);
  await ins("stock_levels", levels);
  console.log(`  ${NEW_PRODUCTS} master products added — ${elapsed()}`);
}

// ── B) delivered engines at every shop ──────────────────────────────────────
let serial = 0;
for (const shop of shops) {
  const engines = [], rl = [], dl = [], mov = [];
  const recvAt = nowIso(), confAt = nowIso();
  const rcv = { id: uid(), supplier_id: pick(suppliers).id, received_at: recvAt, created_by: OWNER,
    note: "STOCK-BOOST engines", total_amount: 0, amount_paid: 0, payment_status: "paid" };
  const del = { id: uid(), shop_id: shop.id, delivered_at: recvAt, created_by: OWNER,
    status: "confirmed", confirmed_at: confAt, confirmed_by: shop.user, note: "STOCK-BOOST engines" };
  let total = 0;
  for (let e = 0; e < ENGINES_PER_SHOP; e++) {
    const cost = rnd(40000, 120000) * 100;
    const id = uid();
    engines.push({ id, serial_number: `XS-${pad(++serial, 6)}`, engine_model_id: pick(models).id,
      condition: "brand_new", cost_centavos: cost, price_centavos: Math.round(cost * (1.25 + Math.random() * 0.3)),
      status: "delivered", shop_id: shop.id, image_path: IMG, created_at: nowIso() });
    rl.push({ id: uid(), receiving_id: rcv.id, engine_id: id, qty: 1, unit_cost_centavos: cost, created_at: recvAt });
    mov.push({ id: uid(), movement_type: "received", engine_id: id, qty_change: 1, shop_id: null, actor: OWNER, receiving_id: rcv.id, created_at: recvAt });
    dl.push({ id: uid(), delivery_id: del.id, engine_id: id, qty: 1, qty_received: 1, created_at: recvAt });
    mov.push({ id: uid(), movement_type: "delivery", engine_id: id, qty_change: -1, shop_id: null, actor: OWNER, delivery_id: del.id, created_at: recvAt });
    mov.push({ id: uid(), movement_type: "delivery", engine_id: id, qty_change: 1, shop_id: shop.id, actor: shop.user, delivery_id: del.id, created_at: confAt });
    total += cost;
  }
  rcv.total_amount = total; rcv.amount_paid = total;
  await ins("receivings", [rcv]);
  await ins("deliveries", [del]);
  await ins("engines", engines);
  await ins("receiving_lines", rl);
  await ins("delivery_lines", dl);
  await ins("stock_movements", mov);
  console.log(`  shop ${shop.id.slice(0, 8)}: +${ENGINES_PER_SHOP} engines · ${inserted.toLocaleString()} rows · ${elapsed()}`);
}

console.log(`\nDone — ${NEW_PRODUCTS} master products + ${ENGINES_PER_SHOP * shops.length} engines, ${inserted.toLocaleString()} rows, ${elapsed()}.`);
console.log("Certify: node scripts/test-movements.mjs");
