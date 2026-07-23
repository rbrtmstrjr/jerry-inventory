import type { Metadata } from "next";
import { Suspense } from "react";
import { Store, Users, Wallet } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/pnl";
import type { ReceivableRow } from "@/lib/db-types";
import { formatCentavos } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card";
import { ReceivableTabs, type ReceivableTab } from "./receivable-tabs";
import { ReceivablesList, type PaymentHistoryRow } from "./receivables-view";

export const metadata: Metadata = { title: "Receivables" };

function resolveTab(t?: string): ReceivableTab {
  return t === "paid" ? "paid" : "open";
}

/**
 * `?tab=` picks Open (balance > 0) or Fully paid (balance ≤ 0). The shell does
 * NO DB work — heading + tab labels paint instantly. The outstanding summary,
 * the tab count badges, and the ACTIVE tab's list each stream behind their own
 * `<Suspense>`; the parent never fetches both tabs' rows for the client to split.
 */
export default async function OwnerReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: tabParam } = await searchParams;
  const tab = resolveTab(tabParam);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Receivables</h1>
        <p className="text-sm text-muted-foreground">
          Every unpaid balance (utang) across all shops. Balances only drop when
          you approve a payment in the Approval Queue.
        </p>
      </div>

      <Suspense fallback={<SummarySkeleton />}>
        <ReceivablesSummary />
      </Suspense>

      {/* Tab labels instant (fallback); count badges stream in. */}
      <Suspense fallback={<ReceivableTabs active={tab} />}>
        <ReceivableTabsWithCounts active={tab} />
      </Suspense>

      <Suspense key={tab} fallback={<ListSkeleton />}>
        <ReceivablesBody tab={tab} />
      </Suspense>
    </div>
  );
}

/** Outstanding headline — always the OPEN set, light projection only. */
async function ReceivablesSummary() {
  const supabase = await createClient();
  const open = await fetchAll<{
    sale_id: string;
    shop_id: string;
    shop_name: string;
    customer_id: string | null;
    customer_name: string | null;
    balance_centavos: number;
  }>(
    () =>
      supabase
        .from("receivables")
        .select("sale_id, shop_id, shop_name, customer_id, customer_name, balance_centavos")
        .gt("balance_centavos", 0),
    "sale_id"
  );

  const totalOutstanding = open.reduce((s, r) => s + r.balance_centavos, 0);

  const byShop = new Map<string, { name: string; total: number }>();
  for (const r of open) {
    const e = byShop.get(r.shop_id) ?? { name: r.shop_name, total: 0 };
    e.total += r.balance_centavos;
    byShop.set(r.shop_id, e);
  }
  const shops = [...byShop.values()].sort((a, b) => b.total - a.total);

  const byCustomer = new Map<string, { name: string; total: number }>();
  for (const r of open) {
    const key = r.customer_id ?? `walkin-${r.sale_id}`;
    const e = byCustomer.get(key) ?? { name: r.customer_name ?? "Walk-in", total: 0 };
    e.total += r.balance_centavos;
    byCustomer.set(key, e);
  }
  const customers = [...byCustomer.values()].sort((a, b) => b.total - a.total);

  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardDescription>Total outstanding</CardDescription>
          <Wallet className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">
            {formatCentavos(totalOutstanding)}
          </div>
          <p className="text-xs text-muted-foreground">
            across {open.length} open sale{open.length === 1 ? "" : "s"}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardDescription>Shops owing</CardDescription>
          <Store className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">{shops.length}</div>
          <p className="text-xs text-muted-foreground">
            {shops[0] ? `${shops[0].name} highest` : "none"}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardDescription>Customers owing</CardDescription>
          <Users className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">{customers.length}</div>
          <p className="text-xs text-muted-foreground">
            {customers[0]
              ? `${customers[0].name} owes ${formatCentavos(customers[0].total)}`
              : "none"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

async function ReceivableTabsWithCounts({ active }: { active: ReceivableTab }) {
  const supabase = await createClient();
  const [oc, pc] = await Promise.all([
    supabase.from("receivables").select("sale_id", { count: "exact", head: true }).gt("balance_centavos", 0),
    supabase.from("receivables").select("sale_id", { count: "exact", head: true }).lte("balance_centavos", 0),
  ]);
  const counts: Record<ReceivableTab, number> = {
    open: oc.count ?? 0,
    paid: pc.count ?? 0,
  };
  return <ReceivableTabs active={active} counts={counts} />;
}

async function ReceivablesBody({ tab }: { tab: ReceivableTab }) {
  const supabase = await createClient();

  const [rows, historyRes, shopsRes] = await Promise.all([
    // Only the active tab's rows — Open (balance > 0) or Fully paid (≤ 0).
    fetchAll<ReceivableRow>(() => {
      const base = supabase.from("receivables").select("*");
      return tab === "paid"
        ? base.lte("balance_centavos", 0)
        : base.gt("balance_centavos", 0);
    }, "sale_id"),
    // Posted + voided history (voided rows are soft-deleted).
    supabase
      .from("utang_payments")
      .select(
        "id, sale_id, amount_centavos, method, payer_name, payer_contact, status, created_at, deleted_at, owner_note, profiles!utang_payments_recorded_by_fkey(full_name)"
      )
      .order("created_at", { ascending: false }),
    supabase
      .from("shops")
      .select("id, name, color_key")
      .is("deleted_at", null)
      .order("name"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const history: PaymentHistoryRow[] = (historyRes.data ?? []).map((p: any) => ({
    id: p.id,
    sale_id: p.sale_id,
    amount_centavos: p.amount_centavos,
    method: p.method ?? "cash",
    payer_name: p.payer_name,
    payer_contact: p.payer_contact,
    created_at: p.created_at,
    voided: !!p.deleted_at,
    owner_note: p.owner_note ?? null,
    recorded_by: p.profiles?.full_name ?? "?",
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ReceivablesList
      tab={tab}
      rows={rows}
      history={history}
      shops={shopsRes.data ?? []}
    />
  );
}

function SummarySkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-4 w-4" />
          </CardHeader>
          <CardContent>
            <Skeleton className="h-7 w-24" />
            <Skeleton className="mt-2 h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-20" />
        <Skeleton className="h-9 w-96 max-w-full" />
      </div>
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-lg" />
      ))}
    </div>
  );
}
