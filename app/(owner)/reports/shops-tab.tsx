import { createClient } from "@/lib/supabase/server";
import { computePnl } from "@/lib/pnl";
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

  const perShop = pnl.perShop
    .map((r) => {
      const { shop_id, ...rest } = r;
      return {
        ...rest,
        color_key: colorByShopId.get(shop_id) ?? null,
        ...(ctx.get(shop_id) ?? zeroCtx()),
      };
    })
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
  };

  return <ShopReports data={data} />;
}
