/**
 * IN-FLIGHT STATE SEED — populates every "waiting" / non-terminal state the
 * load seed leaves empty, so each page can be QA'd with realistic data.
 *
 * seed-load-test.mjs leaves the business in a SETTLED terminal state: every
 * delivery Confirmed, every supplier receiving Paid, zero pending approvals,
 * no transfers / returns / claims in flight. This script layers the missing
 * intermediate states ON TOP of that data:
 *
 *   Approvals & sales   pending batches (sales+losses+expenses), questioned,
 *                       rejected, unsent "recorded", approved-TODAY sales
 *   Stock in motion     in-transit deliveries, discrepancies awaiting resolve,
 *                       shop→shop transfer requests, shop→master return requests
 *   Money owed          unpaid / partial / OVERDUE supplier receivings (payables)
 *   Service & alerts    warranty claims awaiting approval, open stock-requests,
 *                       master + per-shop low-stock (reorder thresholds)
 *
 * INVARIANT-SAFE like the load seed: the only fixtures that move stock
 * (in-transit, discrepancy, approved-today, payable receivings) write the
 * matching stock_movements AND fold the delta into stock_levels from the same
 * in-memory tally, so `Σ movements = shelf` (test-movements.mjs) still holds.
 * States that DON'T move stock (pending/requested/open) are pure inserts — by
 * design "shops record, never move stock" until the owner approves.
 *
 * Reusable: dates land in the last few days (+ today), tagged "QA-STATE" in a
 * text column wherever one exists. Refuses to double-run (guard below). A full
 * db-fresh-start wipes it along with everything else.
 *
 *   Run AFTER seed-load-test.mjs:  node scripts/seed-states.mjs
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

const FORCE = process.argv.includes("--force");
const MARK = "QA-STATE";
const uid = () => randomUUID();
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pad = (n, w) => String(n).padStart(w, "0");

// recent PH dates: today back a week
const iso = (d) => d.toISOString().slice(0, 10);
const TODAY = iso(new Date());
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const at = (date, h, m = rnd(0, 59)) => `${date}T${pad(h, 2)}:${pad(m, 2)}:${pad(rnd(0, 59), 2)}+08:00`;

let inserted = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
      await sleep(attempt * 3000);
    }
    inserted += chunk.length;
  }
}

// ── load survivors ──────────────────────────────────────────────────────────
async function fetchAll(build) {
  const out = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await build().range(off, off + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) return out;
  }
}

console.log("Loading current data…");

// guard: refuse to stack a second run
{
  const { count } = await admin
    .from("deliveries").select("id", { count: "exact", head: true })
    .like("note", `%${MARK}%`);
  if (count > 0 && !FORCE) {
    console.error(`Found ${count} existing ${MARK} fixtures — already seeded.`);
    console.error("Re-run db-fresh-start + seed-load-test for a clean base, or pass --force to stack.");
    process.exit(2);
  }
}

const { data: ownerProf } = await admin.from("profiles").select("id").eq("role", "owner").limit(1).single();
const OWNER = ownerProf.id;

const shops = await fetchAll(() => admin.from("shops").select("id, name").is("deleted_at", null));
const emps = await fetchAll(() => admin.from("profiles").select("id, shop_id").eq("role", "employee").eq("active", true));
const userOf = new Map(emps.map((e) => [e.shop_id, e.id]));
for (const s of shops) if (!userOf.has(s.id)) { console.error(`Shop ${s.name} has no employee login`); process.exit(2); }

const parts = await fetchAll(() => admin.from("parts").select("id, name, cost_centavos, price_centavos, reorder_level").is("deleted_at", null).is("merged_into", null));
const partById = new Map(parts.map((p) => [p.id, p]));
const suppliers = await fetchAll(() => admin.from("suppliers").select("id, name").is("deleted_at", null));
const customers = await fetchAll(() => admin.from("customers").select("id, name").limit(400));
let ecats = await fetchAll(() => admin.from("expense_categories").select("id").eq("status", "active").is("deleted_at", null));
if (!ecats.length) ecats = await fetchAll(() => admin.from("expense_categories").select("id").is("deleted_at", null));
const ECATS = ecats.map((c) => c.id);

// current shelf truth → working maps (mutated as we allocate)
const levels = await fetchAll(() => admin.from("stock_levels").select("part_id, shop_id, qty"));
const masterQty = new Map();          // part_id -> qty
const shelfQty = new Map();           // `${shop}|${part}` -> qty
for (const l of levels) {
  if (l.shop_id === null) masterQty.set(l.part_id, l.qty);
  else shelfQty.set(`${l.shop_id}|${l.part_id}`, l.qty);
}
const origMaster = new Map(masterQty);
const origShelf = new Map(shelfQty);

// held lists (recomputed lazily from the working maps)
const masterHeld = () => [...masterQty.entries()].filter(([, q]) => q > 0).sort((a, b) => b[1] - a[1]);
const shopHeld = (shopId) =>
  [...shelfQty.entries()].filter(([k, q]) => q > 0 && k.startsWith(`${shopId}|`)).map(([k, q]) => [k.split("|")[1], q]);

console.log(`  ${shops.length} shops, ${parts.length} parts, ${suppliers.length} suppliers, ${levels.length} stock rows`);

// accumulators
const R = {
  batches: [], sales: [], sale_lines: [], sale_line_costs: [], losses: [],
  expenses: [], deliveries: [], delivery_lines: [], returns: [], return_lines: [],
  warranty_claims: [], delivery_requests: [], delivery_request_lines: [],
  receivings: [], receiving_lines: [], movements: [], shop_reorder_levels: [],
};
const counts = {};
const tally = (k, n = 1) => (counts[k] = (counts[k] ?? 0) + n);

// ── 1. Approvals & sales ─────────────────────────────────────────────────────
// pending batches: a shop submits a day's report → sales+losses+expenses go
// pending under one batch. NO stock moves (deducts only on approval).
function buildLineSet(shopId, maxLines) {
  const held = shopHeld(shopId);
  const set = [];
  for (let i = 0; i < rnd(1, maxLines) && held.length; i++) {
    const [pid, avail] = pick(held);
    const p = partById.get(pid);
    if (!p) continue;
    set.push({ p, q: Math.min(avail, rnd(1, 3)) });
  }
  return set;
}
function pushSale(shopId, day, status, batchId, extra = {}) {
  const saleId = uid();
  const created = at(day, rnd(8, 17));
  const lines = buildLineSet(shopId, 4);
  if (!lines.length) return null;
  let total = 0;
  for (const { p, q } of lines) {
    const unit = p.price_centavos;
    R.sale_lines.push({
      id: uid(), sale_id: saleId, part_id: p.id, qty: q,
      unit_price_centavos: unit, line_total_centavos: unit * q, description: p.name,
      agreed_price_centavos: unit, list_reference_centavos: unit, discount_centavos: 0, created_at: created,
    });
    total += unit * q;
  }
  const partial = extra.partial && customers.length;
  const cust = partial ? pick(customers) : null;
  const paid = partial ? Math.round(total * 0.5) : total;
  R.sales.push({
    id: saleId, shop_id: shopId, recorded_by: userOf.get(shopId),
    customer_id: cust?.id ?? null, status, business_date: day,
    total_centavos: total, payment_type: partial ? "partial" : "full",
    payment_method: pick(["cash", "cash", "gcash", "bank"]),
    amount_paid_centavos: paid, balance_due_centavos: total - paid,
    receipt_no: `OR-QA${pad(++orNo, 5)}`, receipt_generated_at: created,
    batch_id: batchId, created_at: created,
    owner_note: extra.owner_note ?? null,
    reviewed_by: extra.reviewed_by ?? null, reviewed_at: extra.reviewed_at ?? null,
  });
  return saleId;
}
function pushLoss(shopId, day, status, batchId, extra = {}) {
  const held = shopHeld(shopId);
  if (!held.length) return;
  const [pid] = pick(held);
  const p = partById.get(pid);
  R.losses.push({
    id: uid(), shop_id: shopId, part_id: pid, qty: 1,
    reason: pick(["nasira", "nawala", "expired"]), status,
    recorded_by: userOf.get(shopId), business_date: day,
    value_centavos: status === "approved" ? p.cost_centavos : null,
    batch_id: batchId, description: p.name, note: MARK, created_at: at(day, 17),
    owner_note: extra.owner_note ?? null,
    reviewed_by: extra.reviewed_by ?? null, reviewed_at: extra.reviewed_at ?? null,
  });
}
function pushExpense(shopId, day, status, batchId, extra = {}) {
  R.expenses.push({
    id: uid(), scope: "shop", shop_id: shopId, category_id: pick(ECATS),
    amount: rnd(50, 1500) * 100, expense_date: day,
    description: `${pick(["Gasolina", "Meals", "Tricycle fare", "Load"])} [${MARK}]`,
    status, source: "shop", recorded_by: userOf.get(shopId), batch_id: batchId,
    approved_by: extra.approved_by ?? null, approved_at: extra.approved_at ?? null,
    review_note: extra.review_note ?? null, created_at: at(day, 12),
  });
}

let orNo = 0;
// pending: 8 batches/shop across the last 4 days
for (const shop of shops) {
  for (let b = 0; b < 8; b++) {
    const day = daysAgo(rnd(0, 4));
    const batchId = uid();
    R.batches.push({ id: batchId, shop_id: shop.id, submitted_by: userOf.get(shop.id), submitted_at: at(day, 18) });
    let any = false;
    for (let s = 0; s < rnd(3, 7); s++) if (pushSale(shop.id, day, "pending", batchId)) { tally("pending_sales"); any = true; }
    if (Math.random() < 0.5) { pushLoss(shop.id, day, "pending", batchId); tally("pending_losses"); any = true; }
    for (let e = 0; e < rnd(1, 2); e++) { pushExpense(shop.id, day, "pending", batchId); tally("pending_expenses"); any = true; }
    if (!any) R.batches.pop();
  }
}
// questioned + rejected (already reviewed, under their own batch)
for (const shop of shops) {
  const day = daysAgo(rnd(1, 5));
  const batchId = uid();
  R.batches.push({ id: batchId, shop_id: shop.id, submitted_by: userOf.get(shop.id), submitted_at: at(day, 18) });
  const rev = { reviewed_by: OWNER, reviewed_at: at(day, 20) };
  for (let s = 0; s < 3; s++) if (pushSale(shop.id, day, "questioned", batchId, { ...rev, owner_note: "Please clarify the price — customer name?" })) tally("questioned_sales");
  for (let s = 0; s < 3; s++) if (pushSale(shop.id, day, "rejected", batchId, { ...rev, owner_note: "Duplicate entry." })) tally("rejected_sales");
  pushLoss(shop.id, day, "questioned", batchId, { ...rev, owner_note: "Reason unclear." }); tally("questioned_losses");
}
// unsent "recorded" report (shop-only, no batch)
for (const shop of shops) {
  for (let s = 0; s < 5; s++) if (pushSale(shop.id, daysAgo(rnd(0, 2)), "recorded", null)) tally("recorded_sales");
  pushExpense(shop.id, daysAgo(1), "recorded", null); tally("recorded_expenses");
}

// approved-TODAY sales (light dashboard "approved sales today" + deduct shelf)
for (const shop of shops) {
  for (let s = 0; s < 10; s++) {
    const lines = buildLineSet(shop.id, 3);
    if (!lines.length) continue;
    const saleId = uid();
    const created = at(TODAY, rnd(8, 16));
    const reviewed = at(TODAY, rnd(16, 18));
    const batchId = uid();
    R.batches.push({ id: batchId, shop_id: shop.id, submitted_by: userOf.get(shop.id), submitted_at: reviewed });
    let total = 0;
    for (const { p, q } of lines) {
      const unit = p.price_centavos;
      const lineId = uid();
      R.sale_lines.push({ id: lineId, sale_id: saleId, part_id: p.id, qty: q, unit_price_centavos: unit, line_total_centavos: unit * q, description: p.name, agreed_price_centavos: unit, list_reference_centavos: unit, discount_centavos: 0, created_at: created });
      R.sale_line_costs.push({ sale_id: saleId, sale_line_id: lineId, unit_cost_centavos: p.cost_centavos, line_cost_centavos: p.cost_centavos * q, created_at: reviewed });
      R.movements.push({ id: uid(), movement_type: "sale", part_id: p.id, qty_change: -q, shop_id: shop.id, actor: OWNER, sale_id: saleId, created_at: reviewed });
      shelfQty.set(`${shop.id}|${p.id}`, shelfQty.get(`${shop.id}|${p.id}`) - q);
      total += unit * q;
    }
    R.sales.push({
      id: saleId, shop_id: shop.id, recorded_by: userOf.get(shop.id), customer_id: null,
      status: "approved", business_date: TODAY, total_centavos: total, payment_type: "full",
      payment_method: pick(["cash", "cash", "gcash"]), amount_paid_centavos: total, balance_due_centavos: 0,
      settled_at: reviewed, receipt_no: `OR-QA${pad(++orNo, 5)}`, receipt_generated_at: created,
      reviewed_by: OWNER, reviewed_at: reviewed, batch_id: batchId, created_at: created,
    });
    tally("approved_today");
  }
}

// ── 2. Stock in motion ───────────────────────────────────────────────────────
// in-transit (master→shop, not yet confirmed): debit master into transit
for (let i = 0; i < 20; i++) {
  const shop = pick(shops);
  const src = masterHeld().slice(0, 60);
  if (!src.length) break;
  const day = daysAgo(rnd(0, 3));
  const del = { id: uid(), shop_id: shop.id, from_shop_id: null, delivered_at: at(day, 9), created_by: OWNER, status: "in_transit", note: `${MARK} restock` };
  let lines = 0;
  for (let l = 0; l < rnd(3, 8); l++) {
    const [pid, avail] = pick(src);
    if (avail <= 0) continue;
    const qty = Math.min(avail, rnd(1, 4));
    R.delivery_lines.push({ id: uid(), delivery_id: del.id, part_id: pid, qty, qty_received: null, created_at: del.delivered_at });
    R.movements.push({ id: uid(), movement_type: "delivery", part_id: pid, qty_change: -qty, shop_id: null, actor: OWNER, delivery_id: del.id, created_at: del.delivered_at });
    masterQty.set(pid, masterQty.get(pid) - qty);
    lines++;
  }
  if (lines) { R.deliveries.push(del); tally("in_transit"); }
}
// discrepancy (confirmed with a shortfall): master out, shop gets only the good
for (let i = 0; i < 15; i++) {
  const shop = pick(shops);
  const src = masterHeld().slice(0, 60);
  if (!src.length) break;
  const day = daysAgo(rnd(1, 6));
  const del = { id: uid(), shop_id: shop.id, from_shop_id: null, delivered_at: at(day, 9), created_by: OWNER, status: "discrepancy", confirmed_at: at(day, 15), confirmed_by: userOf.get(shop.id), note: `${MARK} short delivery` };
  let lines = 0;
  for (let l = 0; l < rnd(2, 5); l++) {
    const [pid, avail] = pick(src);
    if (avail < 2) continue;
    const qty = Math.min(avail, rnd(2, 5));
    const recv = qty - rnd(1, Math.max(1, qty - 1)); // short by 1..qty-1
    R.delivery_lines.push({ id: uid(), delivery_id: del.id, part_id: pid, qty, qty_received: recv, shop_note: "short on arrival", created_at: del.delivered_at });
    R.movements.push({ id: uid(), movement_type: "delivery", part_id: pid, qty_change: -qty, shop_id: null, actor: OWNER, delivery_id: del.id, created_at: del.delivered_at });
    if (recv > 0) R.movements.push({ id: uid(), movement_type: "delivery", part_id: pid, qty_change: recv, shop_id: shop.id, actor: userOf.get(shop.id), delivery_id: del.id, created_at: del.confirmed_at });
    masterQty.set(pid, masterQty.get(pid) - qty);
    shelfQty.set(`${shop.id}|${pid}`, (shelfQty.get(`${shop.id}|${pid}`) ?? 0) + recv);
    lines++;
  }
  if (lines) { R.deliveries.push(del); tally("discrepancies"); }
}
// shop→shop transfer requests (no stock moves — requested)
const TSTAT = [...Array(18).fill("requested"), ...Array(4).fill("rejected"), ...Array(3).fill("cancelled")];
for (const status of TSTAT) {
  if (shops.length < 2) break;
  const src = pick(shops);
  const dest = pick(shops.filter((s) => s.id !== src.id));
  const held = shopHeld(src.id);
  if (!held.length) continue;
  const day = daysAgo(rnd(0, 5));
  const del = { id: uid(), shop_id: dest.id, from_shop_id: src.id, delivered_at: at(day, 10), created_by: userOf.get(src.id), requested_by: userOf.get(src.id), status, note: `${MARK} transfer to ${dest.name}` };
  if (status === "rejected") { del.approved_by = OWNER; del.approved_at = at(day, 12); del.review_note = "Keep the stock — you'll need it."; }
  for (let l = 0; l < rnd(1, 3); l++) {
    const [pid, avail] = pick(held);
    R.delivery_lines.push({ id: uid(), delivery_id: del.id, part_id: pid, qty: Math.min(avail, rnd(1, 2)), qty_received: null, created_at: del.delivered_at });
  }
  R.deliveries.push(del); tally(`transfer_${status}`);
}
// shop→master return requests (no stock moves — requested)
const RSTAT = [...Array(15).fill("requested"), ...Array(3).fill("rejected"), ...Array(2).fill("cancelled")];
for (const status of RSTAT) {
  const shop = pick(shops);
  const held = shopHeld(shop.id);
  if (!held.length) continue;
  const day = daysAgo(rnd(0, 5));
  const ret = { id: uid(), shop_id: shop.id, returned_at: at(day, 11), reason: `${MARK} overstock`, status, requested_by: userOf.get(shop.id), created_by: userOf.get(shop.id) };
  if (status === "rejected") { ret.approved_by = OWNER; ret.approved_at = at(day, 13); ret.review_note = "Sell it there instead."; }
  for (let l = 0; l < rnd(1, 3); l++) {
    const [pid, avail] = pick(held);
    const qty = Math.min(avail, rnd(1, 3));
    R.return_lines.push({ id: uid(), return_id: ret.id, part_id: pid, qty, qty_damaged: Math.random() < 0.3 ? 1 : 0, created_at: ret.returned_at });
  }
  R.returns.push(ret); tally(`return_${status}`);
}

// ── 3. Service & alerts ──────────────────────────────────────────────────────
// warranty claims awaiting approval (on existing sold-engine warranties)
const warr = await fetchAll(() => admin.from("warranties").select("id, engine_id, customer_id, sale_id, sales!inner(shop_id)").is("deleted_at", null).limit(80));
for (const w of warr.slice(0, 30)) {
  const shopId = w.sales?.shop_id;
  if (!shopId || !userOf.has(shopId)) continue;
  R.warranty_claims.push({
    id: uid(), warranty_id: w.id, claim_date: daysAgo(rnd(0, 6)),
    issue: `${MARK} — ${pick(["hard starting", "overheating", "stalling at idle", "water in fuel", "no spark"])}`,
    status: "requested", resolution: "repair", shop_id: shopId, requested_by: userOf.get(shopId),
    created_at: at(daysAgo(rnd(0, 6)), 14),
  });
  tally("warranty_claims");
}
// open stock-requests (shop asks Admin for a delivery)
for (const shop of shops) {
  for (let r = 0; r < 6; r++) {
    const reqId = uid();
    const day = daysAgo(rnd(0, 5));
    R.delivery_requests.push({ id: reqId, shop_id: shop.id, status: "open", note: `${MARK} running low`, requested_by: userOf.get(shop.id), created_at: at(day, 9) });
    for (let l = 0; l < rnd(2, 5); l++) {
      const p = pick(parts);
      R.delivery_request_lines.push({ id: uid(), delivery_request_id: reqId, part_id: p.id, qty_requested: rnd(3, 20), created_at: at(day, 9) });
    }
    tally("stock_requests");
  }
}
// low stock: master reorder bump (owner-facing) + per-shop overrides
const bumpParts = [...parts].sort(() => Math.random() - 0.5).slice(0, 40);
const masterReorderUpdates = bumpParts.map((p) => ({ id: p.id, level: (masterQty.get(p.id) ?? 0) + rnd(5, 25) }));
for (const shop of shops) {
  const held = shopHeld(shop.id).slice(0, 12);
  for (const [pid, qty] of held) {
    R.shop_reorder_levels.push({ id: uid(), shop_id: shop.id, part_id: pid, reorder_level: qty + rnd(3, 15) });
    tally("shop_low_stock");
  }
}
tally("master_low_stock", masterReorderUpdates.length);

// ── 4. Money owed — unpaid / partial / overdue supplier receivings ───────────
for (let i = 0; i < 15; i++) {
  const sup = pick(suppliers);
  const overdue = i < 8;
  const partial = i % 3 === 0;
  const day = overdue ? daysAgo(rnd(35, 90)) : daysAgo(rnd(0, 20));
  const due = overdue ? daysAgo(rnd(1, 30)) : iso(new Date(Date.now() + rnd(5, 25) * 864e5));
  const rcvId = uid();
  let total = 0;
  const nlines = rnd(2, 6);
  for (let l = 0; l < nlines; l++) {
    const p = pick(parts);
    const qty = rnd(5, 40);
    R.receiving_lines.push({ id: uid(), receiving_id: rcvId, part_id: p.id, qty, unit_cost_centavos: p.cost_centavos, created_at: at(day, 8) });
    R.movements.push({ id: uid(), movement_type: "received", part_id: p.id, qty_change: qty, shop_id: null, actor: OWNER, receiving_id: rcvId, created_at: at(day, 8) });
    masterQty.set(p.id, (masterQty.get(p.id) ?? 0) + qty);
    total += qty * p.cost_centavos;
  }
  const paid = partial ? Math.round(total * 0.4) : 0;
  R.receivings.push({
    id: rcvId, supplier_id: sup.id, received_at: at(day, 8), created_by: OWNER,
    note: `${MARK} credit purchase`, total_amount: total, amount_paid: paid,
    payment_status: partial ? "partial" : "unpaid", due_date: due,
    payment_method: partial ? "cash" : null,
  });
  tally(overdue ? "payable_overdue" : "payable_current");
  if (partial) tally("payable_partial");
}

// ── insert everything in FK order ────────────────────────────────────────────
console.log("Inserting fixtures…");
await ins("submission_batches", R.batches);
await ins("receivings", R.receivings);
await ins("receiving_lines", R.receiving_lines);
await ins("deliveries", R.deliveries);
await ins("delivery_lines", R.delivery_lines);
await ins("returns", R.returns);
await ins("return_lines", R.return_lines);
await ins("sales", R.sales);
await ins("sale_lines", R.sale_lines);
await ins("sale_line_costs", R.sale_line_costs);
await ins("losses", R.losses);
await ins("expenses", R.expenses);
await ins("warranty_claims", R.warranty_claims);
await ins("delivery_requests", R.delivery_requests);
await ins("delivery_request_lines", R.delivery_request_lines);
await ins("shop_reorder_levels", R.shop_reorder_levels);
await ins("stock_movements", R.movements);

// stock_levels: upsert only the keys whose working qty changed
const levelUpserts = [];
let negative = false;
for (const [pid, q] of masterQty) {
  if (q === origMaster.get(pid)) continue;
  if (q < 0) { negative = true; console.error(`NEG master ${pid}: ${q}`); }
  levelUpserts.push({ part_id: pid, shop_id: null, qty: q });
}
for (const [key, q] of shelfQty) {
  if (q === (origShelf.get(key) ?? 0)) continue;
  if (q < 0) { negative = true; console.error(`NEG shelf ${key}: ${q}`); }
  const [shopId, pid] = key.split("|");
  levelUpserts.push({ part_id: pid, shop_id: shopId, qty: q });
}
if (negative) { console.error("Negative stock — aborting before stock_levels write."); process.exit(1); }
for (let i = 0; i < levelUpserts.length; i += 500) {
  const { error } = await admin.from("stock_levels").upsert(levelUpserts.slice(i, i + 500), { onConflict: "part_id,shop_id" });
  if (error) throw new Error(`stock_levels: ${error.message}`);
}

// master reorder-level bumps (low-stock signal, no stock moved)
for (const u of masterReorderUpdates) {
  await admin.from("parts").update({ reorder_level: u.level }).eq("id", u.id);
}

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\nDONE — ${inserted.toLocaleString()} rows inserted, ${levelUpserts.length} stock levels adjusted.`);
console.log("  Approvals & sales:");
console.log(`    pending    ${counts.pending_sales ?? 0} sales · ${counts.pending_losses ?? 0} losses · ${counts.pending_expenses ?? 0} expenses`);
console.log(`    questioned ${counts.questioned_sales ?? 0} sales · ${counts.questioned_losses ?? 0} losses   rejected ${counts.rejected_sales ?? 0}`);
console.log(`    recorded   ${counts.recorded_sales ?? 0} (unsent)   approved-today ${counts.approved_today ?? 0}`);
console.log("  Stock in motion:");
console.log(`    in-transit ${counts.in_transit ?? 0} · discrepancies ${counts.discrepancies ?? 0}`);
console.log(`    transfers  requested ${counts.transfer_requested ?? 0} · rejected ${counts.transfer_rejected ?? 0} · cancelled ${counts.transfer_cancelled ?? 0}`);
console.log(`    returns    requested ${counts.return_requested ?? 0} · rejected ${counts.return_rejected ?? 0} · cancelled ${counts.return_cancelled ?? 0}`);
console.log("  Service & alerts:");
console.log(`    warranty claims ${counts.warranty_claims ?? 0} · stock requests ${counts.stock_requests ?? 0}`);
console.log(`    low stock: master ${counts.master_low_stock ?? 0} · shop ${counts.shop_low_stock ?? 0}`);
console.log("  Money owed:");
console.log(`    payables overdue ${counts.payable_overdue ?? 0} · current ${counts.payable_current ?? 0} (${counts.payable_partial ?? 0} partial)`);
console.log(`\n  Certify the ledger still reconciles:  node scripts/test-movements.mjs`);
