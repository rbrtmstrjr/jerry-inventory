import type { Metadata } from "next";
import { Suspense } from "react";
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
import { getDashboardSummary, getTopProducts } from "@/lib/dashboard";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The dashboard streams. The shell + section skeletons render instantly; each
 * card group is an async component in its own <Suspense>, so the fast KPIs paint
 * in one round-trip while the heavier P&L fills a moment later — the page is
 * never blocked on its slowest query. Numbers come from lib/dashboard.ts (SQL
 * aggregates via 0074, with a direct-query fallback).
 */
export default function OwnerDashboardPage() {
  const today = ph_today();
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthLabel = format(new Date(`${today}T00:00:00`), "MMMM");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Cross-shop overview · {format(new Date(), "EEEE, MMMM d")}
        </p>
      </div>

      <Suspense fallback={<StatsSkeleton />}>
        <StatsCards />
      </Suspense>

      <div className="grid gap-4 lg:grid-cols-2">
        <Suspense fallback={<CardSkeleton lines={5} />}>
          <TopProductsCard from={monthStart} to={today} monthLabel={monthLabel} />
        </Suspense>
        <Suspense fallback={<CardSkeleton lines={6} />}>
          <PnlCard from={monthStart} to={today} monthLabel={monthLabel} />
        </Suspense>
      </div>

      <Suspense fallback={<OpsSkeleton />}>
        <OpsCards />
      </Suspense>
    </div>
  );
}

// ── top KPI row ──────────────────────────────────────────────────────────────
async function StatsCards() {
  const s = await getDashboardSummary();
  const stats = [
    {
      label: "Pending approvals",
      value: `${s.pendingCount}`,
      hint: "sales + losses awaiting review",
      icon: ClipboardCheck,
      href: "/approvals",
    },
    {
      label: "Approved sales today",
      value: formatCentavos(s.todayRevenue),
      hint: `${s.todayCount} sale(s) · all shops`,
      icon: ShoppingCart,
      href: "/reports",
    },
    {
      label: "Master stock items",
      value: `${s.masterItemCount}`,
      hint: "part lines + engines in central inventory",
      icon: Boxes,
      href: "/master-inventory",
    },
    {
      label: "Low-stock alerts",
      value: `${s.lowStockCount}`,
      hint: "shop items at/below reorder level",
      icon: TriangleAlert,
      href: "/stock-alerts",
    },
  ];
  return (
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
  );
}

// ── top-selling products ─────────────────────────────────────────────────────
async function TopProductsCard({
  from,
  to,
  monthLabel,
}: {
  from: string;
  to: string;
  monthLabel: string;
}) {
  const topProducts = await getTopProducts(from, to);
  return (
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
            <div className="relative overflow-hidden rounded-lg border border-amber-400/40 bg-gradient-to-br from-amber-400/15 via-amber-300/[0.06] to-transparent p-4">
              <div className="flex items-center gap-3">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-amber-400/25 text-amber-700 dark:text-amber-300">
                  <Trophy className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                    Top seller
                  </div>
                  <div className="truncate text-base font-semibold">{topProducts[0].name}</div>
                </div>
                <div className="shrink-0 text-right leading-none">
                  <div className="text-2xl font-bold tabular-nums">{topProducts[0].qty}</div>
                  <div className="mt-1 text-[11px] text-muted-foreground">sold</div>
                </div>
              </div>
            </div>

            {topProducts.length > 1 && (
              <div className="divide-y overflow-hidden rounded-lg border">
                {topProducts.slice(1).map((t, idx) => (
                  <div key={t.name} className="flex items-center gap-3 px-3 py-2 text-sm">
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
  );
}

// ── P&L (month-to-date) — the authoritative computePnl, just streamed ────────
async function PnlCard({
  from,
  to,
  monthLabel,
}: {
  from: string;
  to: string;
  monthLabel: string;
}) {
  const supabase = await createClient();
  const pnl = await computePnl(supabase, { from, to }).catch(() => null);
  return (
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
            <div
              className={`rounded-lg border p-4 ${
                pnl.netIncome < 0
                  ? "border-destructive/30 bg-destructive/5"
                  : "border-success/30 bg-success/5"
              }`}
            >
              <div className="text-xs font-medium text-muted-foreground">Net income</div>
              <div
                className={`mt-0.5 text-2xl font-bold tabular-nums ${
                  pnl.netIncome < 0 ? "text-destructive" : "text-success"
                }`}
              >
                {formatCentavos(pnl.netIncome)}
              </div>
              <div className="text-xs text-muted-foreground">{pnl.netMarginPct}% net margin</div>
            </div>

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
          <p className="py-6 text-center text-sm text-muted-foreground">P&amp;L unavailable.</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── operations row ───────────────────────────────────────────────────────────
async function OpsCards() {
  const s = await getDashboardSummary();
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Link href="/deliveries">
        <Card className="h-full transition-colors hover:bg-accent/40">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Deliveries</CardTitle>
            <Truck className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">
              {s.needYouCount}
              {s.needYouCount > 0 && (
                <span className="ml-2 align-middle text-xs font-normal text-warning-foreground">
                  need you
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {s.inTransitCount} in transit · discrepancies &amp; transfer requests
            </p>
          </CardContent>
        </Card>
      </Link>

      <Link href="/suppliers?tab=payables">
        <Card className="h-full transition-colors hover:bg-accent/40">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Owed to suppliers</CardTitle>
            <Coins className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">
              {formatCentavos(s.payablesOwed)}
            </div>
            <p className="text-xs text-muted-foreground">
              {s.payablesOverdue > 0 ? (
                <span className="text-destructive">
                  {formatCentavos(s.payablesOverdue)} overdue ({s.payablesOverdueCount})
                </span>
              ) : (
                "nothing overdue"
              )}
            </p>
          </CardContent>
        </Card>
      </Link>

      <Link href="/receivables">
        <Card className="h-full transition-colors hover:bg-accent/40">
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Owed by customers</CardTitle>
            <HandCoins className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold tabular-nums">
              {formatCentavos(s.receivablesOwed)}
            </div>
            <p className="text-xs text-muted-foreground">
              {s.receivablesCount > 0
                ? `${s.receivablesCount} unpaid sale${s.receivablesCount === 1 ? "" : "s"} (utang)`
                : "all collected"}
            </p>
          </CardContent>
        </Card>
      </Link>
    </div>
  );
}

// ── skeletons (paint instantly while sections stream) ────────────────────────
function StatsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-28" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-7 w-20" />
            <Skeleton className="mt-2 h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function OpsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="pb-2">
            <Skeleton className="h-4 w-32" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-7 w-24" />
            <Skeleton className="mt-2 h-3 w-36" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function CardSkeleton({ lines }: { lines: number }) {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-1 h-3 w-24" />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full rounded-lg" />
        {Array.from({ length: lines }).map((_, i) => (
          <Skeleton key={i} className="h-4 w-full" />
        ))}
      </CardContent>
    </Card>
  );
}
