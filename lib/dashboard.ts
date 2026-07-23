import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";

/**
 * Dashboard + nav-badge data, computed in ONE fast round-trip.
 *
 * The dashboard used to fire ~12 queries and, worse, some fetched THOUSANDS of
 * raw rows only to sum them in JS (receivables, month sales) — which blocked
 * the whole page for seconds on the free tier. These getters read pre-aggregated
 * scalars from SQL RPCs instead (0074): the database does the sum/count and
 * returns a handful of numbers.
 *
 * GRACEFUL FALLBACK: each getter tries its RPC and, if it isn't there yet
 * (migration 0074 not applied), falls back to computing the same numbers from
 * direct queries — paginated, so still correct, just heavier. So the page works
 * before AND after the migration; applying 0074 only makes it faster.
 *
 * `cache()` memoises per request, so the two card groups that both need the
 * summary share a single database hit within one render.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface DashboardSummary {
  pendingCount: number;
  todayRevenue: number;
  todayCount: number;
  masterItemCount: number;
  lowStockCount: number;
  inTransitCount: number;
  needYouCount: number;
  payablesOwed: number;
  payablesOverdue: number;
  payablesOverdueCount: number;
  receivablesOwed: number;
  receivablesCount: number;
}

export interface TopProduct {
  name: string;
  qty: number;
}

export interface BadgeCounts {
  approvals: number;
  deliveries: number;
  stock_alerts: number;
  receivables: number;
  warranties: number;
  suppliers: number;
}

// walk every row of a query (keyset by a unique column) — only used by fallbacks
async function pageAll(build: () => any, key = "id"): Promise<any[]> {
  const out: any[] = [];
  let cursor: any = null;
  for (;;) {
    let q = build().order(key, { ascending: true }).limit(1000);
    if (cursor !== null) q = q.gt(key, cursor);
    const { data, error } = await q;
    if (error) throw error;
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < 1000) return out;
    cursor = rows[rows.length - 1][key];
  }
}

export const getDashboardSummary = cache(async (): Promise<DashboardSummary> => {
  const supabase = await createClient();

  // fast path — one SQL round-trip
  const { data, error } = await supabase.rpc("fn_dashboard_summary");
  if (!error && data) {
    const d = data as any;
    return {
      pendingCount: d.pending_count ?? 0,
      todayRevenue: d.today_revenue ?? 0,
      todayCount: d.today_count ?? 0,
      masterItemCount: d.master_item_count ?? 0,
      lowStockCount: d.low_stock_count ?? 0,
      inTransitCount: d.in_transit_count ?? 0,
      needYouCount: d.need_you_count ?? 0,
      payablesOwed: d.payables_owed ?? 0,
      payablesOverdue: d.payables_overdue ?? 0,
      payablesOverdueCount: d.payables_overdue_count ?? 0,
      receivablesOwed: d.receivables_owed ?? 0,
      receivablesCount: d.receivables_count ?? 0,
    };
  }

  // fallback — direct queries (correct, heavier). Pre-0074 only.
  const today = ph_today();
  const [
    pendS,
    pendL,
    todayS,
    masterP,
    masterE,
    low,
    inT,
    needY,
    pay,
    recv,
  ] = await Promise.all([
    supabase.from("sales").select("id", { count: "exact", head: true }).in("status", ["pending", "questioned"]).is("deleted_at", null),
    supabase.from("losses").select("id", { count: "exact", head: true }).in("status", ["pending", "questioned"]).is("deleted_at", null),
    supabase.from("sales").select("total_centavos").eq("status", "approved").eq("business_date", today).is("deleted_at", null),
    supabase.from("stock_levels").select("qty, parts!inner(deleted_at)").is("shop_id", null).gt("qty", 0),
    supabase.from("engines").select("id", { count: "exact", head: true }).eq("status", "in_master").is("deleted_at", null),
    supabase.from("shop_low_stock").select("product_id", { count: "exact", head: true }),
    supabase.from("deliveries").select("id", { count: "exact", head: true }).eq("status", "in_transit").is("deleted_at", null),
    supabase.from("deliveries").select("id", { count: "exact", head: true }).in("status", ["discrepancy", "requested"]).is("deleted_at", null),
    supabase.from("supplier_payables").select("outstanding, overdue_amount, overdue_count"),
    pageAll(() => supabase.from("receivables").select("sale_id, balance_centavos"), "sale_id"),
  ]);
  const open = (recv as any[]).filter((r) => (r.balance_centavos ?? 0) > 0);
  return {
    pendingCount: (pendS.count ?? 0) + (pendL.count ?? 0),
    todayRevenue: (todayS.data ?? []).reduce((s: number, r: any) => s + (r.total_centavos ?? 0), 0),
    todayCount: (todayS.data ?? []).length,
    masterItemCount: (masterP.data ?? []).filter((r: any) => !r.parts.deleted_at).length + (masterE.count ?? 0),
    lowStockCount: low.count ?? 0,
    inTransitCount: inT.count ?? 0,
    needYouCount: needY.count ?? 0,
    payablesOwed: (pay.data ?? []).reduce((s: number, r: any) => s + (r.outstanding ?? 0), 0),
    payablesOverdue: (pay.data ?? []).reduce((s: number, r: any) => s + (r.overdue_amount ?? 0), 0),
    payablesOverdueCount: (pay.data ?? []).reduce((s: number, r: any) => s + (r.overdue_count ?? 0), 0),
    receivablesOwed: open.reduce((s: number, r: any) => s + (r.balance_centavos ?? 0), 0),
    receivablesCount: open.length,
  };
});

export const getTopProducts = cache(async (from: string, to: string): Promise<TopProduct[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_dashboard_top_products", { p_from: from, p_to: to, p_limit: 5 });
  if (!error && data) {
    return (data as any[]).map((r) => ({ name: r.name as string, qty: Number(r.qty) }));
  }
  // fallback — paginate month sales + aggregate in JS
  const rows = await pageAll(
    () => supabase.from("sales").select("id, sale_lines(description, qty)").eq("status", "approved").gte("business_date", from).lte("business_date", to).is("deleted_at", null),
    "id"
  );
  const byName = new Map<string, number>();
  for (const s of rows) for (const l of s.sale_lines ?? []) {
    const n = l.description ?? "Item";
    byName.set(n, (byName.get(n) ?? 0) + (l.qty ?? 0));
  }
  return [...byName.entries()].map(([name, qty]) => ({ name, qty })).sort((a, b) => b.qty - a.qty).slice(0, 5);
});

export const getBadgeCounts = cache(async (): Promise<BadgeCounts> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_nav_badge_counts");
  if (!error && data) {
    const d = data as any;
    return {
      approvals: d.approvals ?? 0,
      deliveries: d.deliveries ?? 0,
      stock_alerts: d.stock_alerts ?? 0,
      receivables: d.receivables ?? 0,
      warranties: d.warranties ?? 0,
      suppliers: d.suppliers ?? 0,
    };
  }
  // fallback — the same count queries the client badges use
  const [appr, del, ret, masterLow, shopLow, req, recv, warr, sup] = await Promise.all([
    supabase.from("sales").select("id", { count: "exact", head: true }).in("status", ["pending", "questioned"]).is("deleted_at", null),
    supabase.from("deliveries").select("id", { count: "exact", head: true }).in("status", ["requested", "discrepancy"]).is("deleted_at", null),
    supabase.from("returns").select("id", { count: "exact", head: true }).eq("status", "requested").is("deleted_at", null),
    supabase.from("master_low_stock").select("*", { count: "exact", head: true }),
    supabase.from("shop_low_stock").select("*", { count: "exact", head: true }),
    supabase.from("delivery_requests").select("id", { count: "exact", head: true }).eq("status", "open").is("deleted_at", null),
    supabase.from("receivables").select("*", { count: "exact", head: true }).gt("balance_centavos", 0),
    supabase.from("warranty_claims").select("id", { count: "exact", head: true }).eq("status", "requested").is("deleted_at", null),
    supabase.from("receiving_balances").select("*", { count: "exact", head: true }).eq("overdue", true),
  ]);
  return {
    approvals: appr.count ?? 0,
    deliveries: (del.count ?? 0) + (ret.count ?? 0),
    stock_alerts: (masterLow.count ?? 0) + (shopLow.count ?? 0) + (req.count ?? 0),
    receivables: recv.count ?? 0,
    warranties: warr.count ?? 0,
    suppliers: sup.count ?? 0,
  };
});
/* eslint-enable @typescript-eslint/no-explicit-any */
