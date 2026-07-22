import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowRight,
  Boxes,
  ClipboardCheck,
  Coins,
  HandCoins,
  Package,
  ShoppingCart,
  TriangleAlert,
  Trophy,
  Truck,
  Wallet,
} from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import { formatCentavos } from "@/lib/format";
import { computePnl } from "@/lib/pnl";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

export const metadata: Metadata = { title: "Dashboard" };

export default async function OwnerDashboardPage() {
  const supabase = await createClient();
  const today = ph_today();
  const monthStart = `${today.slice(0, 7)}-01`; // 1st of the current PH month

  const [
    pendingSales,
    pendingLosses,
    todaySales,
    masterParts,
    masterEngines,
    lowStock,
    // ── new summary feeds ────────────────────────────────────────────────
    pnl, // net income, month-to-date (never rejects — see .catch below)
    monthSales, // approved sales this month → top-selling products
    inTransit, // deliveries still on the road
    deliveriesNeedYou, // discrepancies + transfer requests awaiting the owner
    payables, // what we owe suppliers
    receivables, // what customers owe us
  ] = await Promise.all([
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
    supabase
      .from("sales")
      .select("total_centavos")
      .eq("status", "approved")
      .eq("business_date", today)
      .is("deleted_at", null),
    supabase
      .from("stock_levels")
      .select("qty, parts!inner(deleted_at)")
      .is("shop_id", null)
      .gt("qty", 0),
    supabase
      .from("engines")
      .select("id", { count: "exact", head: true })
      .eq("status", "in_master")
      .is("deleted_at", null),
    supabase
      .from("shop_low_stock")
      .select("product_id", { count: "exact", head: true }),
    computePnl(supabase, { from: monthStart, to: today }).catch(() => null),
    supabase
      .from("sales")
      .select("sale_lines(description, qty)")
      .eq("status", "approved")
      .gte("business_date", monthStart)
      .lte("business_date", today)
      .is("deleted_at", null),
    supabase
      .from("deliveries")
      .select("id", { count: "exact", head: true })
      .eq("status", "in_transit")
      .is("deleted_at", null),
    supabase
      .from("deliveries")
      .select("id", { count: "exact", head: true })
      .in("status", ["discrepancy", "requested"])
      .is("deleted_at", null),
    supabase
      .from("supplier_payables")
      .select("outstanding, overdue_amount, overdue_count"),
    supabase.from("receivables").select("balance_centavos"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const pendingCount = (pendingSales.count ?? 0) + (pendingLosses.count ?? 0);
  const todayRevenue = (todaySales.data ?? []).reduce(
    (s, r) => s + (r.total_centavos ?? 0),
    0
  );
  const masterItemCount =
    (masterParts.data ?? []).filter((r: any) => !r.parts.deleted_at).length +
    (masterEngines.count ?? 0);
  const lowStockCount = lowStock.count ?? 0;

  // top-selling products this month, by quantity sold (approved sales only)
  const qtyByProduct = new Map<string, number>();
  for (const s of (monthSales.data ?? []) as any[]) {
    for (const l of s.sale_lines ?? []) {
      const name = l.description ?? "Item";
      qtyByProduct.set(name, (qtyByProduct.get(name) ?? 0) + (l.qty ?? 0));
    }
  }
  const topProducts = [...qtyByProduct.entries()]
    .map(([name, qty]) => ({ name, qty }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 5);

  const payablesOwed = (payables.data ?? []).reduce(
    (s: number, r: any) => s + (r.outstanding ?? 0),
    0
  );
  const payablesOverdue = (payables.data ?? []).reduce(
    (s: number, r: any) => s + (r.overdue_amount ?? 0),
    0
  );
  const payablesOverdueCount = (payables.data ?? []).reduce(
    (s: number, r: any) => s + (r.overdue_count ?? 0),
    0
  );

  const inTransitCount = inTransit.count ?? 0;
  const needYouCount = deliveriesNeedYou.count ?? 0;

  // outstanding utang — open rows only (balance > 0), same rule as /receivables
  const openReceivables = (receivables.data ?? []).filter(
    (r: any) => (r.balance_centavos ?? 0) > 0
  );
  const receivablesOwed = openReceivables.reduce(
    (s: number, r: any) => s + (r.balance_centavos ?? 0),
    0
  );
  const receivablesCount = openReceivables.length;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const stats = [
    {
      label: "Pending approvals",
      value: `${pendingCount}`,
      hint: "sales + losses awaiting review",
      icon: ClipboardCheck,
      href: "/approvals",
    },
    {
      label: "Approved sales today",
      value: formatCentavos(todayRevenue),
      hint: `${(todaySales.data ?? []).length} sale(s) · all shops`,
      icon: ShoppingCart,
      href: "/reports",
    },
    {
      label: "Master stock items",
      value: `${masterItemCount}`,
      hint: "part lines + engines in central inventory",
      icon: Boxes,
      href: "/master-inventory",
    },
    {
      label: "Low-stock alerts",
      value: `${lowStockCount}`,
      hint: "shop items at/below reorder level",
      icon: TriangleAlert,
      href: "/stock-alerts",
    },
  ];

  const monthLabel = format(new Date(`${today}T00:00:00`), "MMMM");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Cross-shop overview · {format(new Date(), "EEEE, MMMM d")}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Link key={stat.label} href={stat.href}>
            <Card className="transition-colors hover:bg-accent/40">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{stat.label}</CardTitle>
                <stat.icon className="size-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold tabular-nums">{stat.value}</div>
                <p className="text-xs text-muted-foreground">{stat.hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Top sellers + recent activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="size-4" /> Top-selling products
              </CardTitle>
              <CardDescription>{monthLabel} · by quantity sold</CardDescription>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href="/reports">
                Reports <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {topProducts.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No approved sales yet this month.
              </p>
            ) : (
              <>
                {/* #1 — the star seller gets a gold hero panel */}
                <div className="relative overflow-hidden rounded-lg border border-amber-400/40 bg-gradient-to-br from-amber-400/15 via-amber-300/[0.06] to-transparent p-4">
                  <div className="flex items-center gap-3">
                    <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-400/25 text-amber-700 dark:text-amber-300">
                      <Trophy className="size-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                        Top seller
                      </div>
                      <div className="truncate text-base font-semibold">
                        {topProducts[0].name}
                      </div>
                    </div>
                    <div className="shrink-0 text-right leading-none">
                      <div className="text-2xl font-bold tabular-nums">
                        {topProducts[0].qty}
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">sold</div>
                    </div>
                  </div>
                </div>

                {/* #2+ — a quiet, compact ranked list */}
                {topProducts.length > 1 && (
                  <div className="divide-y overflow-hidden rounded-lg border">
                    {topProducts.slice(1).map((t, idx) => (
                      <div
                        key={t.name}
                        className="flex items-center gap-3 px-3 py-2 text-sm"
                      >
                        <span className="w-5 shrink-0 text-center text-xs font-semibold tabular-nums text-muted-foreground">
                          {idx + 2}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{t.name}</span>
                        <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                          {t.qty} sold
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="size-4" /> Profit &amp; Loss
              </CardTitle>
              <CardDescription>{monthLabel} · month-to-date</CardDescription>
            </div>
            <Button variant="outline" size="sm" asChild>
              <Link href="/reports?tab=pnl">
                Full report <ArrowRight className="size-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {pnl ? (
              <>
                {/* headline: the bottom line, answer-first */}
                <div
                  className={`rounded-lg border p-4 ${
                    pnl.netIncome < 0
                      ? "border-destructive/30 bg-destructive/5"
                      : "border-success/30 bg-success/5"
                  }`}
                >
                  <div className="text-xs font-medium text-muted-foreground">
                    Net income
                  </div>
                  <div
                    className={`mt-0.5 text-2xl font-bold tabular-nums ${
                      pnl.netIncome < 0 ? "text-destructive" : "text-success"
                    }`}
                  >
                    {formatCentavos(pnl.netIncome)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {pnl.netMarginPct}% net margin
                  </div>
                </div>

                {/* mini income statement — how we got there */}
                <dl className="flex flex-col gap-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <dt className="text-muted-foreground">Revenue</dt>
                    <dd className="tabular-nums">{formatCentavos(pnl.revenue)}</dd>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <dt>Cost of goods</dt>
                    <dd className="tabular-nums">−{formatCentavos(pnl.cogs)}</dd>
                  </div>
                  <div className="my-1 border-t" />
                  <div className="flex items-center justify-between font-medium">
                    <dt>
                      Gross profit
                      <span className="ml-1.5 font-normal text-muted-foreground">
                        {pnl.grossMarginPct}%
                      </span>
                    </dt>
                    <dd className="tabular-nums">{formatCentavos(pnl.grossProfit)}</dd>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <dt>Expenses</dt>
                    <dd className="tabular-nums">−{formatCentavos(pnl.opex)}</dd>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <dt>Shrinkage</dt>
                    <dd className="tabular-nums">−{formatCentavos(pnl.shrinkage)}</dd>
                  </div>
                  <div className="flex items-center justify-between text-muted-foreground">
                    <dt>Payroll</dt>
                    <dd className="tabular-nums">−{formatCentavos(pnl.laborCost)}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                P&amp;L unavailable.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Operations at a glance */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Deliveries needing attention */}
        <Link href="/deliveries">
          <Card className="h-full transition-colors hover:bg-accent/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Deliveries</CardTitle>
              <Truck className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">
                {needYouCount}
                {needYouCount > 0 && (
                  <span className="ml-2 align-middle text-xs font-normal text-warning-foreground">
                    need you
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {inTransitCount} in transit · discrepancies &amp; transfer requests
              </p>
            </CardContent>
          </Card>
        </Link>

        {/* Supplier payables */}
        <Link href="/suppliers?tab=payables">
          <Card className="h-full transition-colors hover:bg-accent/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Owed to suppliers</CardTitle>
              <Coins className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">
                {formatCentavos(payablesOwed)}
              </div>
              <p className="text-xs text-muted-foreground">
                {payablesOverdue > 0 ? (
                  <span className="text-destructive">
                    {formatCentavos(payablesOverdue)} overdue ({payablesOverdueCount})
                  </span>
                ) : (
                  "nothing overdue"
                )}
              </p>
            </CardContent>
          </Card>
        </Link>

        {/* Receivables — what customers owe us */}
        <Link href="/receivables">
          <Card className="h-full transition-colors hover:bg-accent/40">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Owed by customers</CardTitle>
              <HandCoins className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">
                {formatCentavos(receivablesOwed)}
              </div>
              <p className="text-xs text-muted-foreground">
                {receivablesCount > 0
                  ? `${receivablesCount} unpaid sale${receivablesCount === 1 ? "" : "s"} (utang)`
                  : "all collected"}
              </p>
            </CardContent>
          </Card>
        </Link>
      </div>
    </div>
  );
}
