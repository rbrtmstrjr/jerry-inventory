import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/pnl";
import { ph_today } from "@/lib/ph-date";
import { ReportSkeleton } from "@/components/shell/streaming-skeletons";
import { ExpenseReports, type ExpenseReportData } from "./expense-reports";

export const metadata: Metadata = { title: "Expense Reports" };

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Shell: the layout's heading + tabs stay instant; the report streams behind a
 *  skeleton that re-shows whenever the filters change. */
export default async function ExpenseReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shop?: string }>;
}) {
  const params = await searchParams;
  return (
    <Suspense key={JSON.stringify(params)} fallback={<ReportSkeleton />}>
      <ExpenseReportsBody params={params} />
    </Suspense>
  );
}

async function ExpenseReportsBody({
  params,
}: {
  params: { from?: string; to?: string; shop?: string };
}) {
  const today = ph_today();
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  const to = isDate(params.to) ? params.to! : today;
  const from = isDate(params.from) ? params.from! : addDays(to, -30);
  const shopFilter = params.shop && params.shop !== "all" ? params.shop : null;

  const supabase = await createClient();

  const buildExpenses = () => {
    let q = supabase
      .from("expenses")
      .select(
        `id, amount, expense_date, scope, shop_id, delivery_id, description, paid_to,
         payment_method, expense_categories(name), shops(name, color_key)`
      )
      // reports are money that actually left — pending claims never count (0051)
      .eq("status", "approved")
      .gte("expense_date", from)
      .lte("expense_date", to)
      .is("deleted_at", null);
    if (shopFilter) q = q.eq("shop_id", shopFilter);
    return q;
  };

  // All three cross-module sums are paginated (fetchAll) — a date range wide
  // enough to matter outgrows the 1,000-row cap, which silently understated
  // every per-shop total on this report.
  const [allExpenses, shopsRes, allSales, allLosses, payrollRes] = await Promise.all([
    fetchAll(buildExpenses, "id"),
    supabase.from("shops").select("id, name, color_key").is("deleted_at", null).order("name"),
    // cross-module (read-only): approved revenue in range, per shop
    fetchAll(
      () =>
        supabase
          .from("sales")
          .select("id, shop_id, total_centavos")
          .eq("status", "approved")
          .gte("business_date", from)
          .lte("business_date", to)
          .is("deleted_at", null),
      "id"
    ),
    fetchAll(
      () =>
        supabase
          .from("losses")
          .select("id, shop_id, value_centavos")
          .eq("status", "approved")
          .gte("business_date", from)
          .lte("business_date", to)
          .is("deleted_at", null),
      "id"
    ),
    supabase
      .from("payroll_entries")
      .select("shop_id, net_pay, pay_periods!inner(start_date, end_date, deleted_at)")
      .lte("pay_periods.start_date", to)
      .gte("pay_periods.end_date", from)
      .is("pay_periods.deleted_at", null),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const expenses = allExpenses as any[];
  const shops = shopsRes.data ?? [];

  // by category
  const byCat = new Map<string, number>();
  for (const e of expenses) {
    const c = e.expense_categories?.name ?? "?";
    byCat.set(c, (byCat.get(c) ?? 0) + e.amount);
  }

  // monthly trend
  const byMonth = new Map<string, number>();
  for (const e of expenses) {
    const m = e.expense_date.slice(0, 7);
    byMonth.set(m, (byMonth.get(m) ?? 0) + e.amount);
  }

  // per shop expenses (shop-scoped)
  const expByShop = new Map<string, { color_key: string | null; total: number }>();
  for (const e of expenses) {
    if (e.scope === "shop" && e.shops?.name) {
      const t = expByShop.get(e.shops.name) ?? {
        color_key: e.shops.color_key ?? null,
        total: 0,
      };
      t.total += e.amount;
      expByShop.set(e.shops.name, t);
    }
  }

  // cross-module per shop
  const revByShop = new Map<string, number>();
  for (const s of allSales) {
    revByShop.set(s.shop_id, (revByShop.get(s.shop_id) ?? 0) + (s.total_centavos ?? 0));
  }
  const lossByShop = new Map<string, number>();
  for (const l of allLosses) {
    lossByShop.set(l.shop_id, (lossByShop.get(l.shop_id) ?? 0) + (l.value_centavos ?? 0));
  }
  const payByShop = new Map<string, number>();
  for (const p of payrollRes.data ?? []) {
    payByShop.set(p.shop_id, (payByShop.get(p.shop_id) ?? 0) + (p.net_pay ?? 0));
  }

  const shopNameById = new Map(shops.map((s) => [s.id, s.name]));
  const expByShopId = new Map<string, number>();
  for (const e of expenses) {
    if (e.scope === "shop" && e.shop_id) {
      expByShopId.set(e.shop_id, (expByShopId.get(e.shop_id) ?? 0) + e.amount);
    }
  }

  const costOfBusiness = shops
    .filter((s) => !shopFilter || s.id === shopFilter)
    .map((s) => {
      const revenue = revByShop.get(s.id) ?? 0;
      const opex = expByShopId.get(s.id) ?? 0;
      const payroll = payByShop.get(s.id) ?? 0;
      const losses = lossByShop.get(s.id) ?? 0;
      return {
        shop: shopNameById.get(s.id) ?? "?",
        color_key: s.color_key ?? null,
        revenue,
        opex,
        payroll,
        losses,
        net: revenue - opex - payroll - losses,
      };
    });

  const companyTotal = expenses
    .filter((e) => e.scope === "company")
    .reduce((s, e) => s + e.amount, 0);
  const shopTotal = expenses
    .filter((e) => e.scope === "shop")
    .reduce((s, e) => s + e.amount, 0);
  const deliveryLinked = expenses
    .filter((e) => e.delivery_id)
    .reduce((s, e) => s + e.amount, 0);

  const data: ExpenseReportData = {
    from,
    to,
    shopFilter: shopFilter ?? "all",
    shops,
    totals: {
      total: companyTotal + shopTotal,
      company: companyTotal,
      shop: shopTotal,
      deliveryLinked,
      count: expenses.length,
    },
    byCategory: [...byCat.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total),
    byMonth: [...byMonth.entries()]
      .map(([month, total]) => ({ month, total }))
      .sort((a, b) => a.month.localeCompare(b.month)),
    byShop: [...expByShop.entries()].map(([shop, t]) => ({
      shop,
      color_key: t.color_key,
      total: t.total,
    })),
    shopNames: shops.map((s) => s.name),
    costOfBusiness,
    csvRows: expenses.map((e: any) => ({
      date: e.expense_date,
      category: e.expense_categories?.name ?? "?",
      scope: e.scope,
      shop: e.shops?.name ?? "",
      description: e.description,
      paid_to: e.paid_to ?? "",
      method: e.payment_method ?? "",
      delivery_linked: e.delivery_id ? "yes" : "",
      amount: (e.amount / 100).toFixed(2),
    })),
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return <ExpenseReports data={data} />;
}
