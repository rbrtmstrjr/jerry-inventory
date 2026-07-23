import type { Metadata } from "next";
import { Suspense } from "react";
import { ph_today } from "@/lib/ph-date";
import { ReportTabs } from "./report-tabs";
import { PnlTab } from "./pnl-tab";
import { ShopsTab } from "./shops-tab";
import { SalesTab } from "./sales-tab";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Reports" };

/**
 * Reports streams. The heading + tabs paint instantly; the selected tab's body
 * (which does the heavy fetching/aggregation) streams in behind a skeleton, so
 * the page is never blocked on it. Each tab is an async component — Sales &
 * Inventory, consolidated P&L, and per-shop profitability — all wrapped in one
 * <Suspense> that re-suspends (via `key`) whenever the range/shop changes.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; shop?: string; tab?: string }>;
}) {
  const params = await searchParams;
  const today = ph_today();
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const tab =
    params.tab === "pnl" ? "pnl" : params.tab === "shops" ? "shops" : "sales";

  let body: React.ReactNode;
  if (tab === "pnl") {
    // The P&L default window is "this month" — the question that tab answers.
    const pnlTo = isDate(params.to) ? params.to! : today;
    const pnlFrom = isDate(params.from) ? params.from! : `${pnlTo.slice(0, 7)}-01`;
    body = <PnlTab from={pnlFrom} to={pnlTo} />;
  } else if (tab === "shops") {
    body = <ShopsTab params={params} />;
  } else {
    body = <SalesTab params={params} />;
  }

  // key re-suspends the body (shows the skeleton) when the tab or range changes
  const suspenseKey = `${tab}:${params.from ?? ""}:${params.to ?? ""}:${params.shop ?? ""}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeading />
      <ReportTabs active={tab} />
      <Suspense key={suspenseKey} fallback={<TabSkeleton />}>
        {body}
      </Suspense>
    </div>
  );
}

function PageHeading() {
  return (
    <div className="print:hidden">
      <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
      <p className="text-sm text-muted-foreground">
        What sold and what moved, and what the whole business actually earned.
      </p>
    </div>
  );
}

function TabSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-24" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-7 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-64 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
