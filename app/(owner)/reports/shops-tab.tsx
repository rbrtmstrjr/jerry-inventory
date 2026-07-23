import { createClient } from "@/lib/supabase/server";
import { computePnl, fetchAll } from "@/lib/pnl";
import { ph_today } from "@/lib/ph-date";
import { ShopReports, type ShopReportData } from "./shop-reports";

function addDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Per-shop profitability, moved in verbatim from /shops/reports (which now
 * redirects here). It is FINANCIAL reporting and already shares lib/pnl.ts
 * with the P&L tab — it belongs beside the financials, not under shop
 * management. Only the wrapper changed; the body and figures did not.
 */
export async function ShopsTab({
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

  // The money comes from lib/pnl.ts — the SAME module /reports?tab=pnl uses, so
  // the two pages cannot drift apart. Everything fetched alongside it here is
  // operational context (stock on hand, units moved, what's waiting for you),
  // which is this page's own concern and has no place in a P&L.
  const [
    pnl,
    shopsRes,
    deliveriesRes,
    returnsRes,
    stockRes,
    enginesRes,
    pendingSalesRes,
    pendingLossesRes,
    shopExpenseRows,
  ] = await Promise.all([
    computePnl(supabase, { from, to, shopId: shopFilter }),
    // Unfiltered — the shop picker lists every branch, not just the selected one.
    supabase.from("shops").select("id, name, color_key, deleted_at").order("name"),
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
    // Shop expenses by category — the breakdown behind each shop's opex. SAME
    // filter as lib/pnl.ts's opex (scope=shop, approved, in range, live) so the
    // matrix's column totals reconcile to the "Shop exp." figures.
    fetchAll<{
      id: string;
      shop_id: string | null;
      amount: number;
      expense_categories: { name: string } | null;
    }>(() =>
      supabase
        .from("expenses")
        .select("id, shop_id, amount, expense_categories(name)")
        .eq("scope", "shop")
        .eq("status", "approved")
        .gte("expense_date", from)
        .lte("expense_date", to)
        .is("deleted_at", null)
    ),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  type Ctx = {
    delivered_units: number;
    returned_units: number;
    stock_value: number;
    pending: number;
  };
  const zeroCtx = (): Ctx => ({
    delivered_units: 0, returned_units: 0, stock_value: 0, pending: 0,
  });
  const ctx = new Map<string, Ctx>(pnl.perShop.map((r) => [r.shop_id, zeroCtx()]));
  const bump = (shopId: string | null, fn: (c: Ctx) => void) => {
    if (!shopId) return;
    const c = ctx.get(shopId);
    if (c) fn(c);
  };

  for (const d of deliveriesRes.data ?? []) {
    bump(d.shop_id, (c) => {
      for (const l of (d as any).delivery_lines ?? []) c.delivered_units += l.qty;
    });
  }
  for (const r of returnsRes.data ?? []) {
    bump(r.shop_id, (c) => {
      for (const l of (r as any).return_lines ?? []) c.returned_units += l.qty;
    });
  }
  for (const s of stockRes.data ?? []) {
    bump(s.shop_id, (c) => (c.stock_value += s.qty * s.price_centavos));
  }
  for (const e of enginesRes.data ?? []) {
    bump(e.shop_id, (c) => (c.stock_value += e.price_centavos));
  }
  for (const p of [...(pendingSalesRes.data ?? []), ...(pendingLossesRes.data ?? [])]) {
    bump(p.shop_id, (c) => (c.pending += 1));
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const pct = (part: number, whole: number) =>
    whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;

  const colorByShopId = new Map(
    (shopsRes.data ?? []).map((s) => [s.id, s.color_key ?? null])
  );

  const displayed = pnl.perShop
    .map((r) => ({
      ...r,
      color_key: colorByShopId.get(r.shop_id) ?? null,
      ...(ctx.get(r.shop_id) ?? zeroCtx()),
    }))
    // An open shop always earns a row, even at zero. A closed one only if
    // something actually happened — including stock it still holds or units it
    // moved, which is why this test is wider than the P&L's money-only one.
    .filter(
      (r) =>
        !r.closed ||
        r.revenue !== 0 || r.cogs !== 0 || r.opex !== 0 ||
        r.payroll_gross !== 0 || r.payroll_er !== 0 || r.losses !== 0 ||
        r.stock_value !== 0 || r.delivered_units !== 0 ||
        r.returned_units !== 0 || r.pending !== 0
    );

  // The matrix below needs shop_id for column alignment; the view rows carry it
  // harmlessly (ShopReportData.perShop just doesn't declare the field).
  const perShop = displayed;

  // Expenses by shop (category × shop matrix). Columns = the displayed shops in
  // the same order; each column total reconciles to that shop's opex ("Shop exp.").
  const cols = displayed.map((d) => ({
    shop_id: d.shop_id,
    name: d.shop,
    color_key: d.color_key,
  }));
  const byCategory = new Map<string, Map<string, number>>();
  for (const e of shopExpenseRows) {
    if (!e.shop_id) continue;
    const cat = e.expense_categories?.name ?? "Uncategorized";
    const inner = byCategory.get(cat) ?? new Map<string, number>();
    inner.set(e.shop_id, (inner.get(e.shop_id) ?? 0) + e.amount);
    byCategory.set(cat, inner);
  }
  const expenseCategories = [...byCategory.entries()]
    .map(([name, inner]) => {
      const amounts = cols.map((c) => inner.get(c.shop_id) ?? 0);
      return { name, amounts, total: amounts.reduce((a, b) => a + b, 0) };
    })
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total);
  const shopExpenseTotals = cols.map((_, i) =>
    expenseCategories.reduce((t, c) => t + c.amounts[i], 0)
  );
  const expensesByShop = {
    shops: cols.map((c, i) => ({
      name: c.name,
      color_key: c.color_key,
      total: shopExpenseTotals[i],
    })),
    categories: expenseCategories,
    grandTotal: shopExpenseTotals.reduce((a, b) => a + b, 0),
  };

  const sum = (k: keyof (typeof perShop)[number]) =>
    perShop.reduce((t, r) => t + (r[k] as number), 0);

  const shopNetTotal = sum("net_contribution");

  const data: ShopReportData = {
    from,
    to,
    shopFilter: shopFilter ?? "all",
    // Drill-down list: open shops, plus any closed one still showing in range.
    shops: (shopsRes.data ?? [])
      .filter((s) => !s.deleted_at || perShop.some((r) => r.shop === s.name))
      .map((s) => ({
        id: s.id,
        name: s.name,
        color_key: s.color_key ?? null,
        closed: !!s.deleted_at,
      })),
    shopNames: (shopsRes.data ?? []).map((s) => s.name),
    totals: {
      revenue: sum("revenue"),
      cogs: sum("cogs"),
      grossProfit: sum("gross_profit"),
      grossMarginPct: pct(sum("gross_profit"), sum("revenue")),
      shopNet: shopNetTotal,
      // Overhead belongs to the business, not to any shop. Subtracted ONCE at
      // the bottom — never spread across them.
      companyOverhead: pnl.companyOverhead,
      // NOTE: this is net BEFORE shrinkage — it is a contribution figure, not
      // the business's net income. Losses stay out of a shop's number on
      // purpose, so their sum can't be an income statement. The consolidated
      // P&L (/reports?tab=pnl) subtracts shrinkage from exactly this figure to
      // reach net income; the two reconcile by construction.
      businessNet: shopNetTotal - pnl.companyOverhead,
      laborCost: sum("labor_cost"),
      employerShare: sum("payroll_er"),
      losses: sum("losses"),
      stockValue: sum("stock_value"),
      deliveredUnits: sum("delivered_units"),
      pending: sum("pending"),
    },
    perShop,
    expensesByShop,
  };

  return <ShopReports data={data} />;
}
