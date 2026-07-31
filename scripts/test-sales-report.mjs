/**
 * fn_sales_report (0111) must be BYTE-IDENTICAL to the JS row-walk the Reports
 * Sales tab currently does. This computes both over the SAME live data across
 * several ranges and compares every money number. If they ever diverge, that is
 * the bug — the SQL aggregate is not allowed to change a single peso.
 *
 * Run: node scripts/test-sales-report.mjs   (needs the owner login + 0111 applied)
 */
import { owner, check, section, summary } from "./_harness.mjs";

const c = owner;

// keyset-paginate a query (mirrors lib/pnl.ts fetchAll)
async function fetchAll(build, key = "id") {
  const out = [];
  let last = null;
  for (;;) {
    let q = build().order(key, { ascending: true }).limit(1000);
    if (last !== null) q = q.gt(key, last);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    out.push(...data);
    if (data.length < 1000) break;
    last = data[data.length - 1][key];
  }
  return out;
}

// The JS aggregation, lifted from app/(owner)/reports/sales-tab.tsx — keyed by
// shop_id (the page keys by shop name, 1:1 with id, so the numbers are equal).
async function jsAggregate(from, to) {
  const sales = await fetchAll(() =>
    c.from("sales")
      .select("id, shop_id, business_date, total_centavos, sale_lines(description, qty, line_total_centavos, part_id, engine_id)")
      .eq("status", "approved").gte("business_date", from).lte("business_date", to).is("deleted_at", null)
  );
  const losses = await fetchAll(() =>
    c.from("losses")
      .select("id, reason, qty, value_centavos")
      .eq("status", "approved").gte("business_date", from).lte("business_date", to).is("deleted_at", null)
  );
  const transit = await fetchAll(() =>
    c.from("stock_movements")
      .select("id, qty_change, part_id, engine_id, parts(cost_centavos), engines(cost_centavos)")
      .eq("movement_type", "transit_writeoff").gte("created_at", from).lte("created_at", `${to}T23:59:59.999Z`)
  );

  const totals = {
    revenue: sales.reduce((s, r) => s + r.total_centavos, 0),
    sales_count: sales.length,
    loss_value: losses.reduce((s, l) => s + (l.value_centavos ?? 0), 0),
    loss_count: losses.length,
    transit_value: transit.reduce((s, m) => s + Math.abs(m.qty_change) * (m.parts?.cost_centavos ?? m.engines?.cost_centavos ?? 0), 0),
    transit_qty: transit.reduce((s, m) => s + Math.abs(m.qty_change), 0),
    engines_sold: sales.reduce((s, r) => s + (r.sale_lines ?? []).filter((l) => l.engine_id).length, 0),
  };
  const byShop = {};
  for (const s of sales) {
    const e = (byShop[s.shop_id] ??= { revenue: 0, count: 0 });
    e.revenue += s.total_centavos; e.count += 1;
  }
  const byReason = {};
  for (const l of losses) {
    const e = (byReason[l.reason] ??= { value: 0, qty: 0 });
    e.value += l.value_centavos ?? 0; e.qty += l.qty;
  }
  const topMap = {};
  for (const s of sales) for (const l of s.sale_lines ?? []) {
    if (!l.part_id) continue;
    const k = l.description ?? "Item";
    const e = (topMap[k] ??= { qty: 0, revenue: 0 });
    e.qty += l.qty; e.revenue += l.line_total_centavos;
  }
  const trend = {};
  for (const s of sales) {
    const k = `${s.business_date}|${s.shop_id}`;
    trend[k] = (trend[k] ?? 0) + s.total_centavos;
  }
  return { totals, byShop, byReason, topMap, trend };
}

function rpcToMaps(r) {
  const byShop = {};
  for (const x of r.by_shop) byShop[x.shop_id] = { revenue: x.revenue, count: x.count };
  const byReason = {};
  for (const x of r.by_reason) byReason[x.reason] = { value: x.value, qty: x.qty };
  const trend = {};
  for (const x of r.trend) trend[`${x.date}|${x.shop_id}`] = x.revenue;
  return { byShop, byReason, trend };
}

const RANGES = [
  ["7d", "2026-07-24", "2026-07-31"],
  ["30d", "2026-07-01", "2026-07-31"],
  ["90d", "2026-05-02", "2026-07-31"],
];

for (const [label, from, to] of RANGES) {
  section(`Range ${label} (${from} → ${to})`);
  const js = await jsAggregate(from, to);
  const { data: r, error } = await c.rpc("fn_sales_report", { p_from: from, p_to: to });
  if (error) { check(`${label}: rpc ok`, false, error.message); continue; }

  // totals — every field byte-identical
  for (const k of Object.keys(js.totals)) {
    check(`${label} totals.${k}`, r.totals[k] === js.totals[k], `js ${js.totals[k]} vs sql ${r.totals[k]}`);
  }
  const maps = rpcToMaps(r);
  // by_shop
  const shopIds = new Set([...Object.keys(js.byShop), ...Object.keys(maps.byShop)]);
  let shopOk = true;
  for (const id of shopIds) {
    const a = js.byShop[id] ?? { revenue: 0, count: 0 };
    const b = maps.byShop[id] ?? { revenue: 0, count: 0 };
    if (a.revenue !== b.revenue || a.count !== b.count) { shopOk = false; console.log(`   by_shop ${id}: js ${JSON.stringify(a)} vs sql ${JSON.stringify(b)}`); }
  }
  check(`${label} by_shop identical`, shopOk);
  // by_reason
  const reasons = new Set([...Object.keys(js.byReason), ...Object.keys(maps.byReason)]);
  let reasonOk = true;
  for (const rk of reasons) {
    const a = js.byReason[rk] ?? { value: 0, qty: 0 };
    const b = maps.byReason[rk] ?? { value: 0, qty: 0 };
    if (a.value !== b.value || a.qty !== b.qty) { reasonOk = false; console.log(`   by_reason ${rk}: js ${JSON.stringify(a)} vs sql ${JSON.stringify(b)}`); }
  }
  check(`${label} by_reason identical`, reasonOk);
  // trend (day×shop revenue)
  const tk = new Set([...Object.keys(js.trend), ...Object.keys(maps.trend)]);
  let trendOk = true;
  for (const k of tk) if ((js.trend[k] ?? 0) !== (maps.trend[k] ?? 0)) { trendOk = false; console.log(`   trend ${k}: js ${js.trend[k]} vs sql ${maps.trend[k]}`); }
  check(`${label} trend identical`, trendOk);
  // top_parts — each returned part's numbers must match the JS full map, and
  // they must be the true top-10 by qty (ties may order differently).
  let topOk = true;
  for (const p of r.top_parts) {
    const a = js.topMap[p.name];
    if (!a || a.qty !== p.qty || a.revenue !== p.revenue) { topOk = false; console.log(`   top_parts ${p.name}: js ${JSON.stringify(a)} vs sql ${JSON.stringify({qty:p.qty,revenue:p.revenue})}`); }
  }
  const sortedQtys = Object.values(js.topMap).map((v) => v.qty).sort((x, y) => y - x);
  const cutoff = sortedQtys[9] ?? 0; // 10th-highest qty
  const minReturned = Math.min(...r.top_parts.map((p) => p.qty));
  check(`${label} top_parts values match JS`, topOk);
  check(`${label} top_parts are the top by qty`, r.top_parts.length === 0 || minReturned >= cutoff, `minReturned ${minReturned} cutoff ${cutoff}`);
}

summary();
