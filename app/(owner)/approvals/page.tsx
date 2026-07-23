import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import { ApprovalTabs, type QueueTab } from "./approval-tabs";
import {
  ApprovalsView,
  type PendingSale,
  type PendingLoss,
  type PendingExpense,
} from "./approvals-view";
import { ReviewedHistory, type ReviewedItemRow } from "./reviewed-history";

export const metadata: Metadata = { title: "Approval Queue" };

const PAGE_SIZE = 20;

function resolveTab(t?: string): QueueTab {
  return t === "sales" || t === "losses" || t === "expenses" ? t : "all";
}

/**
 * `?tab=` picks the queue view. The shell does NO DB work — it awaits only
 * searchParams — so the heading + tab bar paint instantly (no fall-back to the
 * whole-segment loader). The tab COUNT badges and the ACTIVE tab's data each
 * stream in behind their own `<Suspense>`: the type tabs pull just their own
 * rows, "All" builds the per-shop batches. No tab loads another tab's data.
 */
export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
  const tab = resolveTab(sp.tab);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approval Queue</h1>
        <p className="text-sm text-muted-foreground">
          Each batch is one shop submission you can approve in one click. Stock
          only moves when you approve. Updates live as shops submit.
        </p>
      </div>
      {/* Tab labels paint instantly (fallback); the count badges stream in. */}
      <Suspense fallback={<ApprovalTabs active={tab} />}>
        <ApprovalTabsWithCounts active={tab} />
      </Suspense>
      <Suspense key={tab} fallback={<ApprovalsSkeleton tab={tab} />}>
        <ApprovalsBody sp={sp} tab={tab} />
      </Suspense>
    </div>
  );
}

async function ApprovalTabsWithCounts({ active }: { active: QueueTab }) {
  const supabase = await createClient();
  // Count of items awaiting a decision (pending + questioned) per tab.
  const pq = ["pending", "questioned"];
  const [sc, lc, ec] = await Promise.all([
    supabase.from("sales").select("id", { count: "exact", head: true }).in("status", pq).is("deleted_at", null),
    supabase.from("losses").select("id", { count: "exact", head: true }).in("status", pq).is("deleted_at", null),
    supabase.from("expenses").select("id", { count: "exact", head: true }).eq("source", "shop").in("status", pq).is("deleted_at", null),
  ]);
  const counts: Record<QueueTab, number> = {
    sales: sc.count ?? 0,
    losses: lc.count ?? 0,
    expenses: ec.count ?? 0,
    all: (sc.count ?? 0) + (lc.count ?? 0) + (ec.count ?? 0),
  };
  return <ApprovalTabs active={active} counts={counts} />;
}

async function ApprovalsBody({
  sp,
  tab,
}: {
  sp: Record<string, string | undefined>;
  tab: QueueTab;
}) {
  const supabase = await createClient();

  // ── Reviewed History: filtered + paginated SERVER-SIDE. This list grows
  // forever, so it must never be fetched unbounded and filtered client-side.
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const filters = {
    shop: sp.shop ?? "all",
    type: sp.type ?? "all",
    status: sp.status ?? "all",
    from: sp.from ?? "",
    to: sp.to ?? "",
    q: sp.q ?? "",
    page,
  };

  let historyQuery = supabase
    .from("reviewed_items")
    .select("*", { count: "exact" })
    .order("event_at", { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);

  if (filters.shop !== "all") historyQuery = historyQuery.eq("shop_id", filters.shop);
  if (filters.type !== "all") historyQuery = historyQuery.eq("item_type", filters.type);
  if (filters.status !== "all") historyQuery = historyQuery.eq("status", filters.status);
  if (filters.from) historyQuery = historyQuery.gte("event_date", filters.from);
  if (filters.to) historyQuery = historyQuery.lte("event_date", filters.to);
  if (filters.q.trim()) {
    historyQuery = historyQuery.ilike("search_text", `%${filters.q.trim().toLowerCase()}%`);
  }

  // Only the active tab's rows are fetched. "All" needs every type to build the
  // per-shop batches; each type tab pulls just its own.
  const wantSales = tab === "all" || tab === "sales";
  const wantLosses = tab === "all" || tab === "losses";
  const wantExpenses = tab === "all" || tab === "expenses";
  const empty = Promise.resolve({ data: [] as unknown[] });

  const [salesRes, lossesRes, expensesRes, activeCatsRes, historyRes, shopListRes] =
    await Promise.all([
    wantSales
      ? supabase
          .from("sales")
          .select(
            `id, shop_id, business_date, status, total_centavos, owner_note, created_at, batch_id,
             payment_type, payment_method, amount_paid_centavos, balance_due_centavos, receipt_no,
             discount_card_id, card_discount_centavos, discount_cards(card_no),
             submission_batches(submitted_at),
             shops(name, color_key),
             profiles!sales_recorded_by_fkey(full_name),
             customers(name, phone),
             sale_lines(description, qty, unit_price_centavos, line_total_centavos, engine_id,
                        agreed_price_centavos, list_reference_centavos, discount_centavos,
                        engines(cost_centavos))`
          )
          .in("status", ["pending", "questioned"])
          .is("deleted_at", null)
          .order("created_at", { ascending: true })
      : empty,
    wantLosses
      ? supabase
          .from("losses")
          .select(
            `id, shop_id, business_date, status, reason, qty, note, owner_note, description, created_at, batch_id,
             submission_batches(submitted_at),
             shops(name, color_key),
             profiles!losses_recorded_by_fkey(full_name)`
          )
          .in("status", ["pending", "questioned"])
          .is("deleted_at", null)
          .order("created_at", { ascending: true })
      : empty,
    wantExpenses
      ? supabase
          .from("expenses")
          .select(
            `id, shop_id, expense_date, status, amount, description, paid_to,
             payment_method, reference_no, receipt_image_path, review_note, created_at, batch_id,
             submission_batches(submitted_at),
             shops(name, color_key),
             profiles!expenses_recorded_by_fkey(full_name),
             expense_categories(id, name, status)`
          )
          .eq("source", "shop")
          .in("status", ["pending", "questioned"])
          .is("deleted_at", null)
          .order("created_at", { ascending: true })
      : empty,
    supabase
      .from("expense_categories")
      .select("id, name")
      .eq("status", "active")
      .eq("active", true)
      .is("deleted_at", null)
      .order("sort_order"),
    historyQuery,
    supabase.from("shops").select("id, name, color_key").is("deleted_at", null).order("name"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sales: PendingSale[] = (salesRes.data ?? []).map((s: any) => ({
    id: s.id,
    batch_id: s.batch_id ?? null,
    batch_submitted_at: s.submission_batches?.submitted_at ?? null,
    shop_name: s.shops?.name ?? "?",
    shop_color_key: s.shops?.color_key ?? null,
    employee: s.profiles?.full_name ?? "?",
    customer: s.customers?.name ?? null,
    status: s.status,
    total_centavos: s.total_centavos,
    payment_type: s.payment_type ?? "full",
    payment_method: s.payment_method ?? "cash",
    amount_paid_centavos: s.amount_paid_centavos ?? null,
    balance_due_centavos: s.balance_due_centavos ?? 0,
    receipt_no: s.receipt_no ?? null,
    owner_note: s.owner_note,
    created_at: s.created_at,
    suki_card_no: s.discount_card_id ? (s.discount_cards?.card_no ?? null) : null,
    card_discount_centavos: s.card_discount_centavos ?? 0,
    has_engine: (s.sale_lines ?? []).some((l: any) => l.engine_id),
    lines: (s.sale_lines ?? []).map((l: any) => ({
      description: l.description ?? "Item",
      qty: l.qty,
      line_total_centavos: l.line_total_centavos,
      is_engine: !!l.engine_id,
      agreed_price_centavos: l.agreed_price_centavos ?? null,
      list_reference_centavos: l.list_reference_centavos ?? null,
      discount_centavos: l.discount_centavos ?? null,
      floor_centavos: l.engines?.cost_centavos ?? null, // floor = cost since 0053
    })),
  }));

  const losses: PendingLoss[] = (lossesRes.data ?? []).map((l: any) => ({
    id: l.id,
    batch_id: l.batch_id ?? null,
    batch_submitted_at: l.submission_batches?.submitted_at ?? null,
    shop_name: l.shops?.name ?? "?",
    shop_color_key: l.shops?.color_key ?? null,
    employee: l.profiles?.full_name ?? "?",
    status: l.status,
    reason: l.reason,
    qty: l.qty,
    note: l.note,
    owner_note: l.owner_note,
    description: l.description ?? "Item",
    created_at: l.created_at,
  }));

  const expenses: PendingExpense[] = (expensesRes.data ?? []).map((e: any) => ({
    id: e.id,
    batch_id: e.batch_id ?? null,
    batch_submitted_at: e.submission_batches?.submitted_at ?? null,
    shop_name: e.shops?.name ?? "?",
    shop_color_key: e.shops?.color_key ?? null,
    employee: e.profiles?.full_name ?? "?",
    status: e.status,
    amount_centavos: e.amount,
    expense_date: e.expense_date,
    description: e.description,
    paid_to: e.paid_to,
    payment_method: e.payment_method,
    reference_no: e.reference_no,
    receipt_image_path: e.receipt_image_path,
    review_note: e.review_note,
    created_at: e.created_at,
    category_id: e.expense_categories?.id ?? "",
    category_name: e.expense_categories?.name ?? "?",
    category_proposed: e.expense_categories?.status === "proposed",
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <div className="flex flex-col gap-10">
      <ApprovalsView
        activeTab={tab}
        sales={sales}
        losses={losses}
        expenses={expenses}
        activeCategories={activeCatsRes.data ?? []}
      />
      <ReviewedHistory
        rows={(historyRes.data ?? []) as ReviewedItemRow[]}
        total={historyRes.count ?? 0}
        pageSize={PAGE_SIZE}
        shops={shopListRes.data ?? []}
        filters={filters}
        openItem={sp.item ?? null}
      />
    </div>
  );
}

function ApprovalsSkeleton({ tab }: { tab: QueueTab }) {
  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-3">
        {tab === "all"
          ? Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="overflow-hidden rounded-lg border">
                <div className="border-b bg-muted/50 px-4 py-3">
                  <Skeleton className="h-4 w-48" />
                </div>
                <div className="flex flex-col gap-3 p-3">
                  <Skeleton className="h-20 w-full rounded-md" />
                  <Skeleton className="h-20 w-full rounded-md" />
                </div>
              </div>
            ))
          : Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-28 w-full rounded-lg" />
            ))}
      </div>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-6 w-40" />
        <div className="flex flex-wrap gap-2">
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-40" />
          <Skeleton className="h-9 w-56" />
        </div>
        <div className="overflow-hidden rounded-md border">
          {Array.from({ length: 6 }).map((_, r) => (
            <div key={r} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
