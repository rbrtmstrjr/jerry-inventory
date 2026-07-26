/**
 * APPEND MORE VOLUME — adds transaction history ON TOP of the existing data,
 * WITHOUT wiping. Use when the DB already holds a valid seed and you just want
 * it bigger (free-tier size stretch) without paying the wipe + VACUUM cost.
 *
 * Invariant-safe BY NET-ZERO CONSTRUCTION: each shop-day batch RECEIVES qty Q
 * of a part to master, DELIVERS exactly Q to a shop (confirmed), and SELLS
 * exactly Q at that shop — so every location nets to zero and stock_levels is
 * never touched. `Σ movements = stock_levels` (test-movements.mjs) therefore
 * still holds, and the append can be stopped after ANY batch with no cleanup.
 *
 * Adds: receivings/-lines, deliveries/-lines (confirmed), submission_batches,
 * approved sales/-lines/-costs, and the matching stock_movements. Parts only
 * (no engines/warranties), full-payment walk-in sales — pure volume.
 *
 * Distinct id ranges so nothing collides with the load seed: receipts AP…,
 * notes tagged "APPEND". Run any time after seed-load-test:
 *   APPEND_SALES=40000 node scripts/seed-append.mjs
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const TARGET_SALES = Number(process.env.APPEND_SALES ?? 40000);
const uid = () => randomUUID();
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pad = (n, w) => String(n).padStart(w, "0");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// same 3-year business-day span as the load seed, so appended sales land inside
// the existing history (denser reports) rather than off the end.
const days = [];
{
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - 3);
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1))
    if (d.getDay() !== 0) days.push(d.toISOString().slice(0, 10));
}
const at = (date, h, m = rnd(0, 59)) => `${date}T${pad(h, 2)}:${pad(m, 2)}:${pad(rnd(0, 59), 2)}+08:00`;

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
      console.log(`  retry ${attempt} on ${table} (${error.message.slice(0, 60)}) — ${attempt * 4}s`);
      await sleep(attempt * 4000);
    }
    inserted += chunk.length;
  }
}

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 60000).toFixed(1)}m`;

// ── load reference data (must already exist) ────────────────────────────────
const { data: ownerProf } = await admin
  .from("profiles").select("id").eq("role", "owner").limit(1).single();
const OWNER = ownerProf.id;

const { data: shopProfs } = await admin
  .from("profiles").select("id, shop_id").eq("role", "employee").not("shop_id", "is", null);
const shops = (shopProfs ?? []).map((p) => ({ id: p.shop_id, user: p.id }));

const { data: parts } = await admin
  .from("parts").select("id, name, unit, cost_centavos, price_centavos").is("deleted_at", null);
const { data: suppliers } = await admin.from("suppliers").select("id").is("deleted_at", null);

if (!shops.length || !parts?.length || !suppliers?.length) {
  console.error("Append needs existing shops + parts + suppliers — run seed-load-test first.");
  process.exit(1);
}
console.log(`Appending ~${TARGET_SALES.toLocaleString()} sales across ${shops.length} shops (net-zero cycles)…`);

// starting receipt sequence in a distinct AP range (collision-proof vs OR-…)
let apNo = 0;
let salesMade = 0;

// FK-ordered flush of an accumulated buffer
function fresh() {
  return {
    receivings: [], receiving_lines: [], deliveries: [], delivery_lines: [],
    batches: [], sales: [], sale_lines: [], sale_line_costs: [], movements: [],
  };
}
async function flush(rows) {
  await ins("receivings", rows.receivings);
  await ins("deliveries", rows.deliveries);
  await ins("submission_batches", rows.batches);
  await ins("receiving_lines", rows.receiving_lines);
  await ins("delivery_lines", rows.delivery_lines);
  await ins("sales", rows.sales);
  await ins("sale_lines", rows.sale_lines);
  await ins("sale_line_costs", rows.sale_line_costs);
  await ins("stock_movements", rows.movements);
}

let rows = fresh();
let sinceFlush = 0;

while (salesMade < TARGET_SALES) {
  const shop = pick(shops);
  const day = pick(days);
  const recvAt = at(day, 7), confAt = at(day, 8);

  // 1) plan this shop-day's sales, tallying qty sold per part
  const nSales = rnd(6, 12);
  const soldByPart = new Map();
  const plannedSales = [];
  for (let s = 0; s < nSales; s++) {
    const lines = [];
    for (let l = 0, n = rnd(1, 3); l < n; l++) {
      const p = pick(parts);
      const q = rnd(1, 4);
      lines.push({ p, q });
      soldByPart.set(p.id, (soldByPart.get(p.id) ?? 0) + q);
    }
    plannedSales.push(lines);
  }

  // 2) receive exactly the sold total to master + confirmed delivery to the shop
  const rcv = { id: uid(), supplier_id: pick(suppliers).id, received_at: recvAt, created_by: OWNER,
    note: `APPEND restock ${day}`, total_amount: 0, amount_paid: 0, payment_status: "paid" };
  const del = { id: uid(), shop_id: shop.id, delivered_at: recvAt, created_by: OWNER,
    status: "confirmed", confirmed_at: confAt, confirmed_by: shop.user, note: `APPEND delivery ${day}` };
  let rcvTotal = 0;
  for (const [pid, q] of soldByPart) {
    const p = parts.find((x) => x.id === pid);
    rows.receiving_lines.push({ id: uid(), receiving_id: rcv.id, part_id: pid, qty: q, unit_cost_centavos: p.cost_centavos, created_at: recvAt });
    rows.movements.push({ id: uid(), movement_type: "received", part_id: pid, qty_change: q, shop_id: null, actor: OWNER, receiving_id: rcv.id, created_at: recvAt });
    rows.delivery_lines.push({ id: uid(), delivery_id: del.id, part_id: pid, qty: q, qty_received: q, created_at: recvAt });
    rows.movements.push({ id: uid(), movement_type: "delivery", part_id: pid, qty_change: -q, shop_id: null, actor: OWNER, delivery_id: del.id, created_at: recvAt });
    rows.movements.push({ id: uid(), movement_type: "delivery", part_id: pid, qty_change: q, shop_id: shop.id, actor: shop.user, delivery_id: del.id, created_at: confAt });
    rcvTotal += q * p.cost_centavos;
  }
  rcv.total_amount = rcvTotal; rcv.amount_paid = rcvTotal;
  rows.receivings.push(rcv);
  rows.deliveries.push(del);

  // 3) the sales — consuming exactly what was delivered (net zero on the shelf)
  const batch = { id: uid(), shop_id: shop.id, submitted_by: shop.user, submitted_at: at(day, 18) };
  rows.batches.push(batch);
  for (const lines of plannedSales) {
    const saleId = uid();
    const created = at(day, rnd(9, 17)), reviewed = at(day, rnd(19, 21));
    let total = 0;
    for (const { p, q } of lines) {
      const unit = p.price_centavos; // catalog price (> cost)
      rows.sale_lines.push({ id: uid(), sale_id: saleId, part_id: p.id, qty: q,
        unit_price_centavos: unit, line_total_centavos: unit * q, description: p.name,
        agreed_price_centavos: unit, list_reference_centavos: unit, discount_centavos: 0, created_at: created });
      rows.sale_line_costs.push({ sale_id: saleId, sale_line_id: rows.sale_lines.at(-1).id,
        unit_cost_centavos: p.cost_centavos, line_cost_centavos: p.cost_centavos * q, created_at: reviewed });
      rows.movements.push({ id: uid(), movement_type: "sale", part_id: p.id, qty_change: -q,
        shop_id: shop.id, actor: OWNER, sale_id: saleId, created_at: reviewed });
      total += unit * q;
    }
    rows.sales.push({ id: saleId, shop_id: shop.id, recorded_by: shop.user, customer_id: null,
      status: "approved", business_date: day, total_centavos: total, payment_type: "full",
      payment_method: pick(["cash", "cash", "gcash", "bank"]), amount_paid_centavos: total,
      balance_due_centavos: 0, settled_at: reviewed, receipt_no: `AP${pad(++apNo, 7)}`,
      receipt_generated_at: created, reviewed_by: OWNER, reviewed_at: reviewed, batch_id: batch.id,
      card_discount_centavos: 0, created_at: created });
    salesMade++;
    sinceFlush++;
  }

  if (sinceFlush >= 2500) {
    await flush(rows);
    console.log(`  ${salesMade.toLocaleString()}/${TARGET_SALES.toLocaleString()} sales · ${inserted.toLocaleString()} rows · ${elapsed()}`);
    rows = fresh();
    sinceFlush = 0;
  }
}

await flush(rows);
console.log(`\nDone — appended ${salesMade.toLocaleString()} sales, ${inserted.toLocaleString()} rows total, ${elapsed()}.`);
console.log(`Ledger still reconciles by net-zero construction; certify: node scripts/test-movements.mjs`);
