import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import { ReportsView, type ReportData } from "./reports-view";

export const metadata: Metadata = { title: "Reports" };

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shop?: string }>;
}) {
  const params = await searchParams;
  const today = ph_today();
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  // default: last 7 days (daily is the default view; any range allowed)
  const to = isDate(params.to) ? params.to! : today;
  const from = isDate(params.from) ? params.from! : addDays(to, -6);
  const shopFilter = params.shop && params.shop !== "all" ? params.shop : null;

  const supabase = await createClient();

  let salesQuery = supabase
    .from("sales")
    .select(
      `id, shop_id, business_date, total_centavos, shops(name),
       sale_lines(description, qty, line_total_centavos, part_id, engine_id)`
    )
    .eq("status", "approved")
    .gte("business_date", from)
    .lte("business_date", to)
    .is("deleted_at", null);
  if (shopFilter) salesQuery = salesQuery.eq("shop_id", shopFilter);

  let lossesQuery = supabase
    .from("losses")
    .select("id, shop_id, business_date, reason, qty, value_centavos, description, shops(name)")
    .eq("status", "approved")
    .gte("business_date", from)
    .lte("business_date", to)
    .is("deleted_at", null);
  if (shopFilter) lossesQuery = lossesQuery.eq("shop_id", shopFilter);

  const [salesRes, lossesRes, shopsRes, stockRes, pendingS, pendingL] =
    await Promise.all([
      salesQuery,
      lossesQuery,
      supabase.from("shops").select("id, name").is("deleted_at", null).order("name"),
      supabase
        .from("stock_levels")
        .select("qty, shop_id, shops(name), parts!inner(name, reorder_level, deleted_at)")
        .not("shop_id", "is", null),
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
    ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sales = (salesRes.data ?? []) as any[];
  const losses = (lossesRes.data ?? []) as any[];
  const shops = shopsRes.data ?? [];

  // ---- aggregate: trend by day per shop ----
  const shopNames = shops.map((s) => s.name);
  const dayMap = new Map<string, Record<string, number>>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    dayMap.set(d, {});
    if (dayMap.size > 400) break; // hard cap on range length
  }
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

  // ---- by shop ----
  const byShopMap = new Map<string, { revenue: number; count: number }>();
  for (const s of sales) {
    const name = s.shops?.name ?? "?";
    const e = byShopMap.get(name) ?? { revenue: 0, count: 0 };
    e.revenue += s.total_centavos;
    e.count += 1;
    byShopMap.set(name, e);
  }
  const byShop = shopNames
    .map((name) => ({ shop: name, ...(byShopMap.get(name) ?? { revenue: 0, count: 0 }) }));

  // ---- losses by reason ----
  const byReasonMap = new Map<string, { value: number; qty: number }>();
  for (const l of losses) {
    const e = byReasonMap.get(l.reason) ?? { value: 0, qty: 0 };
    e.value += l.value_centavos ?? 0;
    e.qty += l.qty;
    byReasonMap.set(l.reason, e);
  }
  const byReason = [...byReasonMap.entries()].map(([reason, v]) => ({ reason, ...v }));

  // ---- top-selling parts + engines sold ----
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

  // ---- low stock (current, not range-bound) ----
  const lowStock = (stockRes.data ?? [])
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

  // ---- CSV detail rows ----
  const salesCsv = sales.flatMap((s: any) =>
    (s.sale_lines ?? []).map((l: any) => ({
      date: s.business_date,
      shop: s.shops?.name ?? "?",
      item: l.description ?? "Item",
      type: l.engine_id ? "engine" : "part",
      qty: l.qty,
      line_total_centavos: l.line_total_centavos,
    }))
  );
  const lossesCsv = losses.map((l: any) => ({
    date: l.business_date,
    shop: l.shops?.name ?? "?",
    item: l.description ?? "Item",
    reason: l.reason,
    qty: l.qty,
    value_centavos: l.value_centavos ?? 0,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const data: ReportData = {
    from,
    to,
    shopFilter: shopFilter ?? "all",
    shops,
    totals: {
      revenue: sales.reduce((s, r) => s + r.total_centavos, 0),
      salesCount: sales.length,
      lossValue: losses.reduce((s, l) => s + (l.value_centavos ?? 0), 0),
      lossCount: losses.length,
      enginesSold: enginesSold.length,
      pendingCount: (pendingS.count ?? 0) + (pendingL.count ?? 0),
    },
    trend,
    shopNames,
    byShop,
    byReason,
    topParts,
    enginesSold,
    lowStock,
    salesCsv,
    lossesCsv,
  };

  return <ReportsView data={data} />;
}
