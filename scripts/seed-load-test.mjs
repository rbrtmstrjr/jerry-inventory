/**
 * 3-YEAR LOAD-TEST SEED — realistic day-by-day data for performance testing
 * and free-tier size calibration. BUSY profile: 5 shops, ~20 sales/shop/day.
 *
 * Invariant-safe BY CONSTRUCTION: every stock_movements row and the final
 * stock_levels are derived from the same in-memory tallies, so the ledger
 * reconciliation (Σ movements = shelf, test-movements.mjs) holds exactly.
 * Monthly flow mirrors the real pipeline: receive → deliver (confirmed) →
 * sell/lose (approved) → utang payments; COGS frozen in sale_line_costs;
 * engine sales get warranties; ~5% of sales use a suki card (0072).
 *
 * Deliberately simplified (documented, honest):
 *   • no images (image_path null — placeholders render)
 *   • sequences untouched: literal ids use high ranges (OR-9…, GT9…, SC9…,
 *     serials LT3-…) so future RPC-minted values can never collide
 *
 * Run AFTER db-fresh-start (needs a clean slate):
 *   node scripts/db-fresh-start.mjs --yes && node scripts/seed-load-test.mjs
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

// ── profile ─────────────────────────────────────────────────────────────────
const YEARS = Number(process.env.SEED_YEARS ?? 3);
const SHOP_DEFS = [
  { name: "Ternate", color: "teal" },
  { name: "Naic", color: "amber" },
  { name: "Rosario", color: "sky" },
  { name: "Tanza", color: "violet" },
  { name: "Maragondon", color: "emerald" },
];
const PARTS_N = 400;
const SALES_PER_DAY = () => 16 + Math.floor(Math.random() * 9); // 16–24
const UTANG_RATE = 0.15;
const CARD_RATE = 0.05;

const uid = () => randomUUID();
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const rnd = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const pad = (n, w) => String(n).padStart(w, "0");

// dates: last 3 years of business days (Mon–Sat), PH time
const days = [];
{
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(end.getFullYear() - YEARS);
  for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0) days.push(d.toISOString().slice(0, 10));
  }
}
const at = (date, h, m = rnd(0, 59)) => `${date}T${pad(h, 2)}:${pad(m, 2)}:${pad(rnd(0, 59), 2)}+08:00`;
const monthOf = (d) => d.slice(0, 7);
const months = [...new Set(days.map(monthOf))];
const daysByMonth = new Map(months.map((m) => [m, days.filter((d) => monthOf(d) === m)]));

// chunked insert with retry — the free-tier pool times out under sustained
// writes (stock_movements chunks fire the alert trigger per row → long
// statements). Smaller chunks for that table + backoff on transient errors.
let inserted = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ins(table, rows) {
  const size = table === "stock_movements" ? 400 : 1000;
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    for (let attempt = 1; ; attempt++) {
      const { error } = await admin.from(table).insert(chunk);
      if (!error) break;
      // a retried chunk that already committed surfaces as duplicate keys
      if (attempt > 1 && error.code === "23505") break;
      if (attempt >= 5) throw new Error(`${table}: ${error.message}`);
      const wait = attempt * 4000;
      console.log(`  retry ${attempt} on ${table} (${error.message.slice(0, 60)}) — waiting ${wait / 1000}s`);
      await sleep(wait);
    }
    inserted += chunk.length;
  }
}

const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 60000).toFixed(1)}m`;

console.log(`Seeding ${YEARS}y × ${SHOP_DEFS.length} shops across ${days.length} business days…`);

// ── 0. sanity: require clean slate + fetch survivors ────────────────────────
{
  const { count } = await admin.from("sales").select("id", { count: "exact", head: true });
  if (count > 0) {
    console.error("DB not clean — run db-fresh-start --yes first.");
    process.exit(2);
  }
}
const { data: ownerProf } = await admin
  .from("profiles").select("id").eq("role", "owner").limit(1).single();
const OWNER = ownerProf.id;
const { data: cats } = await admin.from("product_categories").select("id").is("deleted_at", null);
const CATS = cats.map((c) => c.id);
let { data: ecats } = await admin.from("expense_categories").select("id").is("deleted_at", null);
if (!ecats?.length) {
  const { data } = await admin.from("expense_categories")
    .insert({ name: "Operations" }).select("id");
  ecats = data;
}
const ECATS = ecats.map((c) => c.id);

// ── 1. shops + logins ───────────────────────────────────────────────────────
const shops = [];
for (const [i, s] of SHOP_DEFS.entries()) {
  const shopId = uid();
  await ins("shops", [{
    id: shopId, name: `Gerwin-${s.name}`, location: `${s.name}, Cavite`,
    active: true, color_key: s.color, created_at: at(days[0], 8),
  }]);
  const email = `shop${i + 1}@gerwin-test.ph`;
  const { data: u, error } = await admin.auth.admin.createUser({
    email, password: "gerwin123", email_confirm: true,
  });
  if (error) throw new Error(`login ${email}: ${error.message}`);
  await ins("profiles", [{
    id: u.user.id, full_name: `${s.name} Shop`, role: "employee",
    shop_id: shopId, active: true,
  }]);
  shops.push({ id: shopId, user: u.user.id, name: s.name });
}
console.log(`  shops + logins ready (shop1..${SHOP_DEFS.length}@gerwin-test.ph / gerwin123) — ${elapsed()}`);

// ── 2. suppliers, customers, catalog ────────────────────────────────────────
const suppliers = Array.from({ length: 5 }, (_, i) => ({
  id: uid(), name: ["Honda Philippines", "Motorcentral", "SeaPro Parts", "Cavite Marine Supply", "Lubetech Distributors"][i],
  contact: `09${rnd(100000000, 999999999)}`, credit_limit: 50000000, payment_terms_days: 30,
}));
await ins("suppliers", suppliers);

const FIRST = ["Juan", "Maria", "Jose", "Ana", "Pedro", "Rosa", "Carlos", "Elena", "Ramon", "Luz", "Nena", "Boyet", "Aling", "Mang", "Cesar", "Divina"];
const LAST = ["Dela Cruz", "Santos", "Reyes", "Bautista", "Garcia", "Mendoza", "Aquino", "Villanueva", "Ramos", "Castillo", "Navarro", "Salazar"];
const customers = Array.from({ length: 2000 }, (_, i) => ({
  id: uid(), name: `${pick(FIRST)} ${pick(LAST)} ${i}`,
  phone: `09${rnd(100000000, 999999999)}`, created_at: at(days[0], 9),
}));
await ins("customers", customers);

const NOUNS = ["Carburetor", "Impeller", "Propeller", "Sparkplug", "Fuel Line", "Gasket Set", "Piston Kit", "Starter Rope", "Water Pump", "Oil Seal", "Bearing", "Throttle Cable", "Fuel Filter", "Anode", "Recoil Starter", "Ignition Coil"];
const parts = Array.from({ length: PARTS_N }, (_, i) => {
  const cost = rnd(50, 8000) * 100;
  return {
    id: uid(), name: `${pick(NOUNS)} ${pad(i, 3)}-Z${rnd(1, 9)}C`, category_id: pick(CATS),
    sku: `SKU-${pad(i, 4)}`, barcode: i < 100 ? `GT9${pad(i, 7)}` : null, unit: "pc",
    cost_centavos: cost, price_centavos: Math.round(cost * (1.3 + Math.random() * 0.5)),
    reorder_level: 0, created_at: at(days[0], 8),
  };
});
await ins("parts", parts);

const models = Array.from({ length: 30 }, (_, i) => ({
  id: uid(), brand: pick(["Yamaha", "Honda", "Suzuki", "Tohatsu", "Mercury"]),
  model: `M${pad(i, 2)}-${rnd(10, 40)}`, horsepower: pick([5, 8, 15, 25, 40]),
  default_warranty_months: 12, reorder_level: 0, created_at: at(days[0], 8),
}));
await ins("engine_models", models);
console.log(`  catalog: ${PARTS_N} parts, 30 engine models — ${elapsed()}`);

// ── 3. the 3-year monthly pipeline ──────────────────────────────────────────
// tallies: shelf truth, built alongside every movement row
const master = new Map(); // part_id -> qty
const shelf = new Map();  // `${shop}|${part}` -> qty
const bump = (m, k, d) => m.set(k, (m.get(k) ?? 0) + d);

let orNo = 900000, serialNo = 0, cardNo = 0;
const cards = []; // {id, customer_id} — issued in month 2
let enginesSoldTotal = 0, salesTotal = 0;

for (const [mi, month] of months.entries()) {
  const mdays = daysByMonth.get(month);
  const d0 = mdays[0];
  const rows = {
    receivings: [], receiving_lines: [], deliveries: [], delivery_lines: [],
    engines: [], batches: [], sales: [], sale_lines: [], sale_line_costs: [],
    movements: [], losses: [], utang: [], expenses: [], warranties: [],
  };

  // plan: which parts each shop sells this month (subset), qty per sale line 1–4
  const monthPlan = new Map(); // shop -> Map(part -> qty needed)
  for (const shop of shops) {
    const need = new Map();
    for (const day of mdays) {
      for (let s = 0; s < SALES_PER_DAY(); s++) {
        const nLines = rnd(1, 3);
        const saleParts = [];
        for (let l = 0; l < nLines; l++) {
          const p = parts[rnd(0, PARTS_N - 1)];
          const q = rnd(1, 4);
          saleParts.push({ p, q });
          bump(need, p.id, q);
        }
        (shop.plan ??= []).push({ day, lines: saleParts });
      }
    }
    monthPlan.set(shop.id, need);
  }

  // 3a. per-shop delivery quantities FIRST (ceil per shop), then receive the
  // exact sum + buffer — receiving must cover the post-rounding deliveries,
  // or master goes negative (5 shops × ceil() can exceed ceil(Σ)).
  const deliverQty = new Map(); // shop -> Map(part -> qty to deliver)
  for (const [shopId, need] of monthPlan) {
    const dq = new Map();
    for (const [pid, q] of need) dq.set(pid, Math.ceil(q * 1.05));
    deliverQty.set(shopId, dq);
  }
  const rcv = { id: uid(), supplier_id: pick(suppliers).id, received_at: at(d0, 7), created_by: OWNER,
    note: `Monthly stock ${month}`, total_amount: 0, amount_paid: 0, payment_status: "paid" };
  const totalNeed = new Map();
  for (const dq of deliverQty.values()) for (const [pid, q] of dq) bump(totalNeed, pid, q);
  let rcvTotal = 0;
  for (const [pid, q] of totalNeed) {
    const p = parts.find((x) => x.id === pid);
    const qty = q + rnd(1, 3); // small master buffer on top of exact need
    rows.receiving_lines.push({ id: uid(), receiving_id: rcv.id, part_id: pid, qty, unit_cost_centavos: p.cost_centavos, created_at: rcv.received_at });
    rows.movements.push({ id: uid(), movement_type: "received", part_id: pid, qty_change: qty, shop_id: null, actor: OWNER, receiving_id: rcv.id, created_at: rcv.received_at });
    bump(master, pid, qty);
    rcvTotal += qty * p.cost_centavos;
  }
  rcv.total_amount = rcvTotal; rcv.amount_paid = rcvTotal;
  rows.receivings.push(rcv);

  // engines: ~10/shop/month received then sold over the month
  const monthEngines = [];
  for (const shop of shops) {
    for (let e = 0; e < 10; e++) {
      const m = pick(models);
      const cost = rnd(40000, 120000) * 100;
      const eng = {
        id: uid(), serial_number: `LT3-${pad(++serialNo, 6)}`, engine_model_id: m.id,
        condition: "brand_new", cost_centavos: cost,
        price_centavos: Math.round(cost * (1.25 + Math.random() * 0.3)),
        created_at: at(d0, 7), shopObj: shop,
      };
      monthEngines.push(eng);
      rows.receiving_lines.push({ id: uid(), receiving_id: rcv.id, engine_id: eng.id, qty: 1, unit_cost_centavos: cost, created_at: rcv.received_at });
      rows.movements.push({ id: uid(), movement_type: "received", engine_id: eng.id, qty_change: 1, shop_id: null, actor: OWNER, receiving_id: rcv.id, created_at: rcv.received_at });
    }
  }

  // 3b. one confirmed delivery per shop (their need + 5%)
  for (const shop of shops) {
    const del = { id: uid(), shop_id: shop.id, delivered_at: at(d0, 9), created_by: OWNER,
      status: "confirmed", confirmed_at: at(d0, 15), confirmed_by: shop.user, note: `Monthly delivery ${month}` };
    rows.deliveries.push(del);
    for (const [pid, qty] of deliverQty.get(shop.id)) {
      rows.delivery_lines.push({ id: uid(), delivery_id: del.id, part_id: pid, qty, qty_received: qty, created_at: del.delivered_at });
      rows.movements.push({ id: uid(), movement_type: "delivery", part_id: pid, qty_change: -qty, shop_id: null, actor: OWNER, delivery_id: del.id, created_at: del.delivered_at });
      rows.movements.push({ id: uid(), movement_type: "delivery", part_id: pid, qty_change: qty, shop_id: shop.id, actor: shop.user, delivery_id: del.id, created_at: del.confirmed_at });
      bump(master, pid, -qty);
      bump(shelf, `${shop.id}|${pid}`, qty);
    }
    // engines for this shop ride the same delivery
    for (const eng of monthEngines.filter((e) => e.shopObj === shop)) {
      rows.delivery_lines.push({ id: uid(), delivery_id: del.id, engine_id: eng.id, qty: 1, qty_received: 1, created_at: del.delivered_at });
      rows.movements.push({ id: uid(), movement_type: "delivery", engine_id: eng.id, qty_change: -1, shop_id: null, actor: OWNER, delivery_id: del.id, created_at: del.delivered_at });
      rows.movements.push({ id: uid(), movement_type: "delivery", engine_id: eng.id, qty_change: 1, shop_id: shop.id, actor: shop.user, delivery_id: del.id, created_at: del.confirmed_at });
    }
  }

  // suki cards issued in month 2
  if (mi === 1) {
    for (let c = 0; c < 300; c++) {
      const cust = customers[rnd(0, 500)];
      if (cards.some((x) => x.customer_id === cust.id)) continue;
      cards.push({ id: uid(), card_no: `SC9${pad(++cardNo, 7)}`, customer_id: cust.id,
        status: "active", issued_by: OWNER, issued_at: at(d0, 10) });
    }
    await ins("discount_cards", cards);
  }

  // 3c. daily sales / losses / batches
  for (const shop of shops) {
    const engQueue = monthEngines.filter((e) => e.shopObj === shop);
    const byDay = new Map();
    for (const s of shop.plan) (byDay.get(s.day) ?? byDay.set(s.day, []).get(s.day)).push(s);
    shop.plan = [];

    for (const day of mdays) {
      const daySales = byDay.get(day) ?? [];
      const batch = { id: uid(), shop_id: shop.id, submitted_by: shop.user, submitted_at: at(day, 18) };
      rows.batches.push(batch);

      for (const s of daySales) {
        const saleId = uid();
        const created = at(day, rnd(8, 17));
        const reviewed = at(day, rnd(19, 21));
        let total = 0, cardDisc = 0;
        const isCard = cards.length > 0 && Math.random() < CARD_RATE;
        const card = isCard ? pick(cards) : null;

        for (const { p, q } of s.lines) {
          const catalog = p.price_centavos;
          let unit = Math.random() < 0.25 ? Math.max(p.cost_centavos + 100, Math.round(catalog * 0.95)) : catalog;
          if (card) {
            const cp = Math.max(Math.round(catalog * 0.95), p.cost_centavos + 1);
            cardDisc += Math.max(0, catalog - cp) * q;
            unit = Math.min(unit, cp);
          }
          rows.sale_lines.push({ id: uid(), sale_id: saleId, part_id: p.id, qty: q,
            unit_price_centavos: unit, line_total_centavos: unit * q, description: p.name,
            agreed_price_centavos: unit, list_reference_centavos: catalog,
            discount_centavos: Math.max(0, catalog - unit), created_at: created });
          rows.sale_line_costs.push({ sale_id: saleId, sale_line_id: rows.sale_lines.at(-1).id,
            unit_cost_centavos: p.cost_centavos, line_cost_centavos: p.cost_centavos * q, created_at: reviewed });
          rows.movements.push({ id: uid(), movement_type: "sale", part_id: p.id, qty_change: -q,
            shop_id: shop.id, actor: OWNER, sale_id: saleId, created_at: reviewed });
          bump(shelf, `${shop.id}|${p.id}`, -q);
          total += unit * q;
        }

        // ~2 engines/week/shop: attach to a sale early in the day list
        let engineSold = null;
        if (engQueue.length && Math.random() < 0.12) {
          engineSold = engQueue.shift();
          const unit = Math.max(engineSold.cost_centavos + 100, Math.round(engineSold.price_centavos * (0.93 + Math.random() * 0.07)));
          const lineId = uid();
          rows.sale_lines.push({ id: lineId, sale_id: saleId, engine_id: engineSold.id, qty: 1,
            unit_price_centavos: unit, line_total_centavos: unit,
            description: `Engine SN ${engineSold.serial_number}`,
            agreed_price_centavos: unit, list_reference_centavos: engineSold.price_centavos,
            discount_centavos: Math.max(0, engineSold.price_centavos - unit), created_at: created });
          rows.sale_line_costs.push({ sale_id: saleId, sale_line_id: lineId,
            unit_cost_centavos: engineSold.cost_centavos, line_cost_centavos: engineSold.cost_centavos, created_at: reviewed });
          rows.movements.push({ id: uid(), movement_type: "sale", engine_id: engineSold.id, qty_change: -1,
            shop_id: shop.id, actor: OWNER, sale_id: saleId, created_at: reviewed });
          total += unit;
          enginesSoldTotal++;
        }

        const needsCustomer = engineSold || Math.random() < UTANG_RATE;
        const cust = card ? customers.find((c) => c.id === card.customer_id)
          : needsCustomer ? pick(customers) : null;
        const isUtang = !!cust && !engineSold && Math.random() < UTANG_RATE * 2 || (engineSold && Math.random() < 0.4);
        const paidAtSale = isUtang ? Math.round(total * (0.4 + Math.random() * 0.4)) : total;
        const balance = total - paidAtSale;

        rows.sales.push({ id: saleId, shop_id: shop.id, recorded_by: shop.user,
          customer_id: cust?.id ?? null, status: "approved", business_date: day,
          total_centavos: total, payment_type: isUtang ? "partial" : "full",
          payment_method: pick(["cash", "cash", "cash", "gcash", "bank"]),
          amount_paid_centavos: paidAtSale, balance_due_centavos: balance,
          settled_at: balance === 0 ? reviewed : null,
          receipt_no: `OR-${pad(++orNo, 6)}`, receipt_generated_at: created,
          reviewed_by: OWNER, reviewed_at: reviewed, batch_id: batch.id,
          discount_card_id: card?.id ?? null, card_discount_centavos: cardDisc,
          created_at: created });
        salesTotal++;

        if (engineSold) {
          engineSold.final = { status: "sold", shop_id: shop.id, customer_id: cust.id, sold_at: reviewed };
          const exp = new Date(day); exp.setMonth(exp.getMonth() + 12);
          rows.warranties.push({ id: uid(), engine_id: engineSold.id, sale_id: saleId,
            customer_id: cust.id, months: 12, sold_on: day,
            expires_on: exp.toISOString().slice(0, 10), created_at: reviewed });
        }
        // utang payments over following days (70% get payments, 60% settle)
        if (isUtang && Math.random() < 0.7) {
          const settle = Math.random() < 0.6;
          const payTotal = settle ? balance : Math.round(balance * (0.3 + Math.random() * 0.4));
          const payDay = mdays[Math.min(mdays.indexOf(day) + rnd(2, 10), mdays.length - 1)];
          rows.utang.push({ id: uid(), sale_id: saleId, customer_id: cust.id, shop_id: shop.id,
            amount_centavos: payTotal, status: "approved", recorded_by: shop.user,
            business_date: payDay,
            payer_name: cust.name, method: "cash", created_at: at(payDay, rnd(9, 17)) });
          if (settle) rows.sales.at(-1).settled_at = at(payDay, 18);
        }
      }

      // losses ~1.5/shop/week, from on-hand stock
      if (Math.random() < 0.25) {
        const held = [...shelf.entries()].filter(([k, v]) => k.startsWith(shop.id) && v > 0);
        if (held.length) {
          const [key] = pick(held);
          const pid = key.split("|")[1];
          const p = parts.find((x) => x.id === pid);
          const q = 1;
          const lid = uid();
          const when = at(day, rnd(19, 21));
          rows.losses.push({ id: lid, shop_id: shop.id, part_id: pid, qty: q,
            reason: pick(["nasira", "nawala", "expired"]), status: "approved",
            recorded_by: shop.user, reviewed_by: OWNER, reviewed_at: when,
            business_date: day,
            value_centavos: p.cost_centavos * q, batch_id: batch.id, description: p.name, created_at: at(day, 17) });
          rows.movements.push({ id: uid(), movement_type: "loss", part_id: pid, qty_change: -q,
            shop_id: shop.id, actor: OWNER, loss_id: lid, created_at: when });
          bump(shelf, key, -q);
        }
      }
      // shop expenses ~2/day approved
      for (let e = 0; e < 2; e++) {
        rows.expenses.push({ id: uid(), scope: "shop", shop_id: shop.id,
          category_id: pick(ECATS), amount: rnd(50, 1500) * 100, expense_date: day,
          description: pick(["Gasolina", "Meals", "Tricycle fare", "Store supplies", "Load"]),
          status: "approved", source: "shop", recorded_by: shop.user,
          approved_by: OWNER, approved_at: at(day, 20), created_at: at(day, 12) });
      }
    }
    // engines unsold this month stay delivered on the shop shelf
    for (const eng of engQueue) eng.final = { status: "delivered", shop_id: shop.id };
  }
  // company expenses ~15/month
  for (let e = 0; e < 15; e++) {
    rows.expenses.push({ id: uid(), scope: "company", shop_id: null,
      category_id: pick(ECATS), amount: rnd(500, 20000) * 100, expense_date: pick(mdays),
      description: pick(["Rent - main", "Meralco", "Internet", "Truck fuel", "Permits"]),
      status: "approved", source: "owner", recorded_by: OWNER, created_at: at(pick(mdays), 10) });
  }

  // engines rows carry their FINAL state
  for (const eng of monthEngines) {
    const f = eng.final ?? { status: "delivered", shop_id: eng.shopObj.id };
    rows.engines.push({ id: eng.id, serial_number: eng.serial_number, engine_model_id: eng.engine_model_id,
      condition: eng.condition, cost_centavos: eng.cost_centavos, price_centavos: eng.price_centavos,
      status: f.status, shop_id: f.shop_id, customer_id: f.customer_id ?? null,
      sold_at: f.sold_at ?? null, created_at: eng.created_at });
  }

  // insert in FK order
  await ins("receivings", rows.receivings);
  await ins("engines", rows.engines);
  await ins("receiving_lines", rows.receiving_lines);
  await ins("deliveries", rows.deliveries);
  await ins("delivery_lines", rows.delivery_lines);
  await ins("submission_batches", rows.batches);
  await ins("sales", rows.sales);
  await ins("sale_lines", rows.sale_lines);
  await ins("sale_line_costs", rows.sale_line_costs);
  await ins("losses", rows.losses);
  await ins("stock_movements", rows.movements);
  await ins("utang_payments", rows.utang);
  await ins("expenses", rows.expenses);
  await ins("warranties", rows.warranties);

  const pct = Math.round(((mi + 1) / months.length) * 100);
  const eta = ((Date.now() - t0) / (mi + 1)) * (months.length - mi - 1) / 60000;
  console.log(`  ${month}: done (${pct}%) — ${inserted.toLocaleString()} rows, ${elapsed()} elapsed, ~${eta.toFixed(0)}m left`);
}

// ── 4. shelf truth: stock_levels from the SAME tallies as the ledger ────────
const levels = [];
for (const [pid, qty] of master) if (qty !== 0) levels.push({ part_id: pid, shop_id: null, qty });
for (const [key, qty] of shelf) {
  if (qty === 0) continue;
  const [shopId, pid] = key.split("|");
  levels.push({ part_id: pid, shop_id: shopId, qty });
}
if (levels.some((l) => l.qty < 0)) {
  console.error("NEGATIVE tally — generator bug, aborting before stock_levels.");
  process.exit(1);
}
await ins("stock_levels", levels);

console.log(`\nDONE in ${elapsed()} — ${inserted.toLocaleString()} rows.`);
console.log(`  sales: ${salesTotal.toLocaleString()} · engines sold: ${enginesSoldTotal} · stock_levels: ${levels.length}`);
console.log(`  Shop logins: shop1..5@gerwin-test.ph / gerwin123`);
console.log(`  Certify with: node scripts/test-movements.mjs (ledger = shelf, database-wide)`);
