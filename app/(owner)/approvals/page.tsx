import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import {
  ApprovalsView,
  type PendingSale,
  type PendingLoss,
} from "./approvals-view";
import { ReviewedHistory, type ReviewedItemRow } from "./reviewed-history";

export const metadata: Metadata = { title: "Approval Queue" };

const PAGE_SIZE = 20;

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const sp = await searchParams;
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

  const [salesRes, lossesRes, historyRes, shopListRes] = await Promise.all([
    supabase
      .from("sales")
      .select(
        `id, shop_id, business_date, status, total_centavos, owner_note, created_at, batch_id,
         payment_type, amount_paid_centavos, balance_due_centavos, receipt_no,
         submission_batches(submitted_at),
         shops(name),
         profiles!sales_recorded_by_fkey(full_name),
         customers(name, phone),
         sale_lines(description, qty, unit_price_centavos, line_total_centavos, engine_id,
                    agreed_price_centavos, list_reference_centavos, discount_centavos,
                    engines(price_floor_centavos))`
      )
      .in("status", ["pending", "questioned"])
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    supabase
      .from("losses")
      .select(
        `id, shop_id, business_date, status, reason, qty, note, owner_note, description, created_at, batch_id,
         submission_batches(submitted_at),
         shops(name),
         profiles!losses_recorded_by_fkey(full_name)`
      )
      .in("status", ["pending", "questioned"])
      .is("deleted_at", null)
      .order("created_at", { ascending: true }),
    historyQuery,
    supabase.from("shops").select("id, name").is("deleted_at", null).order("name"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const sales: PendingSale[] = (salesRes.data ?? []).map((s: any) => ({
    id: s.id,
    batch_id: s.batch_id ?? null,
    batch_submitted_at: s.submission_batches?.submitted_at ?? null,
    shop_name: s.shops?.name ?? "?",
    employee: s.profiles?.full_name ?? "?",
    customer: s.customers?.name ?? null,
    status: s.status,
    total_centavos: s.total_centavos,
    payment_type: s.payment_type ?? "full",
    amount_paid_centavos: s.amount_paid_centavos ?? null,
    balance_due_centavos: s.balance_due_centavos ?? 0,
    receipt_no: s.receipt_no ?? null,
    owner_note: s.owner_note,
    created_at: s.created_at,
    has_engine: (s.sale_lines ?? []).some((l: any) => l.engine_id),
    lines: (s.sale_lines ?? []).map((l: any) => ({
      description: l.description ?? "Item",
      qty: l.qty,
      line_total_centavos: l.line_total_centavos,
      is_engine: !!l.engine_id,
      agreed_price_centavos: l.agreed_price_centavos ?? null,
      list_reference_centavos: l.list_reference_centavos ?? null,
      discount_centavos: l.discount_centavos ?? null,
      floor_centavos: l.engines?.price_floor_centavos ?? null,
    })),
  }));

  const losses: PendingLoss[] = (lossesRes.data ?? []).map((l: any) => ({
    id: l.id,
    batch_id: l.batch_id ?? null,
    batch_submitted_at: l.submission_batches?.submitted_at ?? null,
    shop_name: l.shops?.name ?? "?",
    employee: l.profiles?.full_name ?? "?",
    status: l.status,
    reason: l.reason,
    qty: l.qty,
    note: l.note,
    owner_note: l.owner_note,
    description: l.description ?? "Item",
    created_at: l.created_at,
  }));

  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <div className="flex flex-col gap-10">
      <ApprovalsView sales={sales} losses={losses} />
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
