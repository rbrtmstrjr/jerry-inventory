import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import { fetchAll } from "@/lib/pnl";
import { clampReportRange } from "@/lib/report-range";
import { getBusinessIdentity } from "@/lib/business-identity";
import { ReportsView, type ReportData } from "./reports-view";

/* eslint-disable @typescript-eslint/no-explicit-any */

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Every date in [from, to], capped at 400 — matches the old JS trend loop.
function dayRange(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    days.push(d);
    if (days.length > 400) break;
  }
  return days;
}

interface ReportContext {
  from: string;
  to: string;
  clamped: boolean;
  shopFilter: string | null;
  shops: { id: string; name: string; color_key: string | null }[];
  shopNames: string[];
  pendingCount: number;
  lowStock: ReportData["lowStock"];
}

/** Streams inside <Suspense>. Fast path is the fn_sales_report aggregate, with
 *  a row-walk fallback if 0111 isn't applied; CSV detail is fetched on demand. */
export async function SalesTab({
  params,
}: {
  params: { from?: string; to?: string; shop?: string };
}) {
  const today = ph_today();
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const rawTo = isDate(params.to) ? params.to! : today;
  const rawFrom = isDate(params.from) ? params.from! : addDays(rawTo, -6);
  const { from, to, clamped } = clampReportRange(rawFrom, rawTo);
  const shopFilter = params.shop && params.shop !== "all" ? params.shop : null;

  const supabase = await createClient();

  const [rpcRes, shopsRes, pendingS, pendingL, allStock] = await Promise.all([
    supabase.rpc("fn_sales_report", { p_from: from, p_to: to, p_shop_id: shopFilter }),
    supabase.from("shops").select("id, name, color_key").is("deleted_at", null).order("name"),
    supabase
      .from("sales")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "questioned"])
      .is("deleted_at", null),
    supabase
      .from("losses")
      .select("id", { count: "exact", head: true })
      .in("status", ["pending", "questioned"])
      .is("deleted_at", null),
    // range-independent (current snapshot) — out of scope for the aggregate RPC
    fetchAll(() =>
      supabase
        .from("stock_levels")
        .select("id, qty, shop_id, shops(name), parts!inner(name, reorder_level, deleted_at)")
        .not("shop_id", "is", null)
    ),
  ]);

  const shops = shopsRes.data ?? [];
  const shopNames = shops.map((s) => s.name);
  const pendingCount = (pendingS.count ?? 0) + (pendingL.count ?? 0);

  const lowStock = (allStock as any[])
    .filter(
      (r: any) =>
        !r.parts.deleted_at && r.parts.reorder_level > 0 && r.qty <= r.parts.reorder_level
    )
    .map((r: any) => ({
      part: r.parts.name as string,
      shop: (r.shops?.name ?? "?") as string,
      qty: r.qty as number,
      reorder_level: r.parts.reorder_level as number,
    }))
    .sort((a: any, b: any) => a.qty - b.qty);

  const ctx: ReportContext = { from, to, clamped, shopFilter, shops, shopNames, pendingCount, lowStock };

  const data: ReportData =
    !rpcRes.error && rpcRes.data
      ? buildFromRpc(rpcRes.data as any, ctx)
      : await buildFallback(supabase, ctx);

  // Read the business name from Settings like every other printable — a
  // hard-coded one goes stale the moment the business is renamed.
  const business = await getBusinessIdentity(supabase);

  return <ReportsView data={data} businessName={business.business_name} />;
}

// ---- fast path: shape the RPC's jsonb result into ReportData ----
function buildFromRpc(rpc: any, ctx: ReportContext): ReportData {
  const { from, to, clamped, shopFilter, shops, shopNames, pendingCount, lowStock } = ctx;
  const shopNameById = new Map(shops.map((s) => [s.id, s.name]));
  const nameOf = (id: string | null) => (id ? shopNameById.get(id) ?? "?" : "?");

  // trend: rpc rows are (date, shop_id, revenue) — pivot to one row per date
  // with a column per shop NAME, same shape the chart expects.
  const dayMap = new Map<string, Record<string, number>>();
  for (const d of dayRange(from, to)) dayMap.set(d, {});
  for (const t of rpc.trend as any[]) {
    const day = dayMap.get(t.date);
    if (!day) continue;
    const name = nameOf(t.shop_id);
    day[name] = (day[name] ?? 0) + Number(t.revenue);
  }
  const trend = [...dayMap.entries()].map(([date, byShop]) => ({
    date,
    ...Object.fromEntries(shopNames.map((n) => [n, byShop[n] ?? 0])),
  }));

  const byShopMap = new Map<string, { revenue: number; count: number }>();
  for (const r of rpc.by_shop as any[]) {
    byShopMap.set(nameOf(r.shop_id), { revenue: Number(r.revenue), count: Number(r.count) });
  }
  const byShop = shopNames.map((name) => ({
    shop: name,
    ...(byShopMap.get(name) ?? { revenue: 0, count: 0 }),
  }));

  const byReason = (rpc.by_reason as any[]).map((r) => ({
    reason: r.reason as string,
    value: Number(r.value),
    qty: Number(r.qty),
  }));

  const topParts = (rpc.top_parts as any[]).map((p) => ({
    name: p.name as string,
    qty: Number(p.qty),
    revenue: Number(p.revenue),
  }));

  const enginesSold = (rpc.engines_sold_list as any[]).map((e) => ({
    description: e.description as string,
    shop: nameOf(e.shop_id),
    date: e.date as string,
    price_centavos: Number(e.price_centavos),
  }));

  const t = rpc.totals;
  return {
    from,
    to,
    rangeClamped: clamped,
    shopFilter: shopFilter ?? "all",
    shops,
    totals: {
      revenue: Number(t.revenue),
      salesCount: Number(t.sales_count),
      lossValue: Number(t.loss_value),
      lossCount: Number(t.loss_count),
      transitLossValue: Number(t.transit_value),
      transitLossQty: Number(t.transit_qty),
      enginesSold: Number(t.engines_sold),
      pendingCount,
    },
    trend,
    shopNames,
    byShop,
    byReason,
    topParts,
    enginesSold,
    lowStock,
  };
}

// ---- fallback path: the original JS row-walk, minus CSV/transit-row detail
// (CSV moved on-demand; transitLosses row list was never rendered by the view) ----
async function buildFallback(supabase: any, ctx: ReportContext): Promise<ReportData> {
  const { from, to, clamped, shopFilter, shops, shopNames, pendingCount, lowStock } = ctx;

  const buildSales = () => {
    let q = supabase
      .from("sales")
      .select(
        `id, shop_id, business_date, total_centavos, shops(name),
         sale_lines(description, qty, line_total_centavos, part_id, engine_id)`
      )
      .eq("status", "approved")
      .gte("business_date", from)
      .lte("business_date", to)
      .is("deleted_at", null);
    if (shopFilter) q = q.eq("shop_id", shopFilter);
    return q;
  };

  const buildLosses = () => {
    let q = supabase
      .from("losses")
      .select("id, shop_id, business_date, reason, qty, value_centavos, description, shops(name)")
      .eq("status", "approved")
      .gte("business_date", from)
      .lte("business_date", to)
      .is("deleted_at", null);
    if (shopFilter) q = q.eq("shop_id", shopFilter);
    return q;
  };

  const buildTransit = () =>
    supabase
      .from("stock_movements")
      .select("id, qty_change, created_at, part_id, engine_id, parts(cost_centavos), engines(cost_centavos)")
      .eq("movement_type", "transit_writeoff")
      .gte("created_at", from)
      .lte("created_at", `${to}T23:59:59.999Z`);

  const [allSales, allLosses, allTransit] = await Promise.all([
    fetchAll(buildSales),
    fetchAll(buildLosses),
    fetchAll(buildTransit),
  ]);

  const sales = allSales as any[];
  const losses = allLosses as any[];
  const transit = allTransit as any[];

  const transitLossValue = transit.reduce(
    (s, m) => s + Math.abs(m.qty_change) * (m.parts?.cost_centavos ?? m.engines?.cost_centavos ?? 0),
    0
  );
  const transitLossQty = transit.reduce((s, m) => s + Math.abs(m.qty_change), 0);

  const dayMap = new Map<string, Record<string, number>>();
  for (const d of dayRange(from, to)) dayMap.set(d, {});
  for (const s of sales) {
    const day = dayMap.get(s.business_date);
    if (!day) continue;
    const name = s.shops?.name ?? "?";
    day[name] = (day[name] ?? 0) + s.total_centavos;
  }
  const trend = [...dayMap.entries()].map(([date, byShop]) => ({
    date,
    ...Object.fromEntries(shopNames.map((n) => [n, byShop[n] ?? 0])),
  }));

  const byShopMap = new Map<string, { revenue: number; count: number }>();
  for (const s of sales) {
    const name = s.shops?.name ?? "?";
    const e = byShopMap.get(name) ?? { revenue: 0, count: 0 };
    e.revenue += s.total_centavos;
    e.count += 1;
    byShopMap.set(name, e);
  }
  const byShop = shopNames.map((name) => ({
    shop: name,
    ...(byShopMap.get(name) ?? { revenue: 0, count: 0 }),
  }));

  const byReasonMap = new Map<string, { value: number; qty: number }>();
  for (const l of losses) {
    const e = byReasonMap.get(l.reason) ?? { value: 0, qty: 0 };
    e.value += l.value_centavos ?? 0;
    e.qty += l.qty;
    byReasonMap.set(l.reason, e);
  }
  const byReason = [...byReasonMap.entries()].map(([reason, v]) => ({ reason, ...v }));

  const topMap = new Map<string, { qty: number; revenue: number }>();
  const enginesSold: ReportData["enginesSold"] = [];
  for (const s of sales) {
    for (const l of s.sale_lines ?? []) {
      if (l.part_id) {
        const key = l.description ?? "Item";
        const e = topMap.get(key) ?? { qty: 0, revenue: 0 };
        e.qty += l.qty;
        e.revenue += l.line_total_centavos;
        topMap.set(key, e);
      } else if (l.engine_id) {
        enginesSold.push({
          description: l.description ?? "Engine",
          shop: s.shops?.name ?? "?",
          date: s.business_date,
          price_centavos: l.line_total_centavos,
        });
      }
    }
  }
  const topParts = [...topMap.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  return {
    from,
    to,
    rangeClamped: clamped,
    shopFilter: shopFilter ?? "all",
    shops,
    totals: {
      revenue: sales.reduce((s, r) => s + r.total_centavos, 0),
      salesCount: sales.length,
      lossValue: losses.reduce((s, l) => s + (l.value_centavos ?? 0), 0),
      lossCount: losses.length,
      transitLossValue,
      transitLossQty,
      enginesSold: enginesSold.length,
      pendingCount,
    },
    trend,
    shopNames,
    byShop,
    byReason,
    topParts,
    enginesSold,
    lowStock,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
