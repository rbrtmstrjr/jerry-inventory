import type { Metadata } from "next";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowRight,
  Boxes,
  ClipboardCheck,
  ShoppingCart,
  TriangleAlert,
} from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
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

  const [
    pendingSales,
    pendingLosses,
    todaySales,
    masterParts,
    masterEngines,
    shopStock,
    recentPending,
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
      .from("stock_levels")
      .select("qty, parts!inner(reorder_level, deleted_at)")
      .not("shop_id", "is", null),
    supabase
      .from("sales")
      .select("id, total_centavos, created_at, status, shops(name), profiles!sales_recorded_by_fkey(full_name)")
      .in("status", ["pending", "questioned"])
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(5),
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
  const lowStockCount = (shopStock.data ?? []).filter(
    (r: any) =>
      !r.parts.deleted_at && r.parts.reorder_level > 0 && r.qty <= r.parts.reorder_level
  ).length;
  const recent = (recentPending.data ?? []) as any[];
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
      href: "/reports",
    },
  ];

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

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Waiting on you</CardTitle>
            <CardDescription>Latest submissions from the shops</CardDescription>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/approvals">
              Open queue <ArrowRight className="size-4" />
            </Link>
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {recent.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Queue is clear — nothing waiting.
            </p>
          )}
          {recent.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
            >
              <span className="text-muted-foreground">
                {s.shops?.name} · {s.profiles?.full_name} ·{" "}
                {format(new Date(s.created_at), "MMM d, h:mm a")}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums font-medium">
                  {formatCentavos(s.total_centavos)}
                </span>
                <Badge variant={s.status === "questioned" ? "outline" : "secondary"}>
                  {s.status}
                </Badge>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
