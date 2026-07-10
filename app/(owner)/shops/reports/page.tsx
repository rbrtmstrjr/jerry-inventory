import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import { ShopReports, type ShopReportData } from "./shop-reports";

export const metadata: Metadata = { title: "Shop Reports" };

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export default async function ShopReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shop?: string }>;
}) {
  const params = await searchParams;
  const today = ph_today();
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  const to = isDate(params.to) ? params.to! : today;
  const from = isDate(params.from) ? params.from! : addDays(to, -30);
  const shopFilter = params.shop && params.shop !== "all" ? params.shop : null;

  const supabase = await createClient();

  const [
    shopsRes,
    salesRes,
    lossesRes,
    expensesRes,
    payrollRes,
    deliveriesRes,
    returnsRes,
    stockRes,
    enginesRes,
    pendingSalesRes,
    pendingLossesRes,
  ] = await Promise.all([
    supabase.from("shops").select("id, name").is("deleted_at", null).order("name"),
    supabase
      .from("sales")
      .select("shop_id, total_centavos, sale_lines(qty, engine_id)")
      .eq("status", "approved")
      .gte("business_date", from)
      .lte("business_date", to)
      .is("deleted_at", null),
    supabase
      .from("losses")
      .select("shop_id, value_centavos")
      .eq("status", "approved")
      .gte("business_date", from)
      .lte("business_date", to)
      .is("deleted_at", null),
    supabase
      .from("expenses")
      .select("shop_id, amount")
      .eq("scope", "shop")
      .gte("expense_date", from)
      .lte("expense_date", to)
      .is("deleted_at", null),
    supabase
      .from("payroll_entries")
      .select("shop_id, net_pay, pay_periods!inner(start_date, end_date, deleted_at)")
      .lte("pay_periods.start_date", to)
      .gte("pay_periods.end_date", from)
      .is("pay_periods.deleted_at", null),
    supabase
      .from("deliveries")
      .select("shop_id, delivery_lines(qty)")
      .gte("delivered_at", from)
      .lte("delivered_at", to + "T23:59:59")
      .is("deleted_at", null),
    supabase
      .from("returns")
      .select("shop_id, return_lines(qty)")
      .gte("returned_at", from)
      .lte("returned_at", to + "T23:59:59")
      .is("deleted_at", null),
    supabase.from("shop_stock").select("shop_id, qty, price_centavos"),
    supabase.from("shop_engines").select("shop_id, price_centavos"),
    supabase
      .from("sales")
      .select("shop_id")
      .in("status", ["pending", "questioned"])
      .is("deleted_at", null),
    supabase
      .from("losses")
      .select("shop_id")
      .in("status", ["pending", "questioned"])
      .is("deleted_at", null),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const shops = (shopsRes.data ?? []).filter(
    (s) => !shopFilter || s.id === shopFilter
  );

  type Agg = {
    revenue: number;
    sales_count: number;
    units_sold: number;
    engines_sold: number;
    losses: number;
    opex: number;
    payroll: number;
    delivered_units: number;
    returned_units: number;
    stock_value: number;
    pending: number;
  };
  const zero = (): Agg => ({
    revenue: 0, sales_count: 0, units_sold: 0, engines_sold: 0, losses: 0,
    opex: 0, payroll: 0, delivered_units: 0, returned_units: 0, stock_value: 0,
    pending: 0,
  });
  const agg = new Map<string, Agg>(shops.map((s) => [s.id, zero()]));
  const bump = (shopId: string | null, fn: (a: Agg) => void) => {
    if (!shopId) return;
    const a = agg.get(shopId);
    if (a) fn(a);
  };

  for (const s of salesRes.data ?? []) {
    bump(s.shop_id, (a) => {
      a.revenue += s.total_centavos ?? 0;
      a.sales_count += 1;
      for (const l of (s as any).sale_lines ?? []) {
        if (l.engine_id) a.engines_sold += 1;
        else a.units_sold += l.qty;
      }
    });
  }
  for (const l of lossesRes.data ?? []) {
    bump(l.shop_id, (a) => (a.losses += l.value_centavos ?? 0));
  }
  for (const e of expensesRes.data ?? []) {
    bump(e.shop_id, (a) => (a.opex += e.amount));
  }
  for (const p of payrollRes.data ?? []) {
    bump(p.shop_id, (a) => (a.payroll += p.net_pay ?? 0));
  }
  for (const d of deliveriesRes.data ?? []) {
    bump(d.shop_id, (a) => {
      for (const l of (d as any).delivery_lines ?? []) a.delivered_units += l.qty;
    });
  }
  for (const r of returnsRes.data ?? []) {
    bump(r.shop_id, (a) => {
      for (const l of (r as any).return_lines ?? []) a.returned_units += l.qty;
    });
  }
  for (const s of stockRes.data ?? []) {
    bump(s.shop_id, (a) => (a.stock_value += s.qty * s.price_centavos));
  }
  for (const e of enginesRes.data ?? []) {
    bump(e.shop_id, (a) => (a.stock_value += e.price_centavos));
  }
  for (const p of [...(pendingSalesRes.data ?? []), ...(pendingLossesRes.data ?? [])]) {
    bump(p.shop_id, (a) => (a.pending += 1));
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const perShop = shops.map((s) => {
    const a = agg.get(s.id) ?? zero();
    return {
      shop: s.name,
      ...a,
      net: a.revenue - a.opex - a.payroll - a.losses,
    };
  });

  const sum = (k: keyof (typeof perShop)[number]) =>
    perShop.reduce((t, r) => t + (r[k] as number), 0);

  const data: ShopReportData = {
    from,
    to,
    shopFilter: shopFilter ?? "all",
    shops: shopsRes.data ?? [],
    shopNames: (shopsRes.data ?? []).map((s) => s.name),
    totals: {
      revenue: sum("revenue"),
      stockValue: sum("stock_value"),
      deliveredUnits: sum("delivered_units"),
      pending: sum("pending"),
    },
    perShop,
  };

  return <ShopReports data={data} />;
}
