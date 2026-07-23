import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchAll } from "@/lib/pnl";
import type { ReceivableRow } from "@/lib/db-types";
import { ShopReceivablesView, type PaymentRow } from "./receivables-view";

export const metadata: Metadata = { title: "Receivables" };

function ShopReceivablesSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-28 w-full rounded-lg" />
        <Skeleton className="h-28 w-full rounded-lg" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-lg" />
      ))}
    </div>
  );
}

export default function ShopReceivablesPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Receivables (Utang)
        </h1>
        <p className="text-sm text-muted-foreground">
          Balances your customers still owe. Record a payment when they pay —
          it applies straight away and Admin sees it in their receivables.
        </p>
      </div>
      <Suspense fallback={<ShopReceivablesSkeleton />}>
        <ShopReceivablesBody />
      </Suspense>
    </div>
  );
}

async function ShopReceivablesBody() {
  const supabase = await createClient();

  const [rows, paymentsRes] = await Promise.all([
    // shop_receivables is already scoped to the caller's shop. Paginated by
    // sale_id and fail-loud, same as the owner page — one busy shop can still
    // outgrow PostgREST's 1,000-row cap.
    fetchAll<ReceivableRow>(() => supabase.from("shop_receivables").select("*"), "sale_id"),
    // full history: posted + voided (voided rows are soft-deleted)
    supabase
      .from("utang_payments")
      .select(
        "id, sale_id, amount_centavos, method, payer_name, payer_contact, note, owner_note, created_at, deleted_at, profiles!utang_payments_recorded_by_fkey(full_name)"
      )
      .order("created_at", { ascending: false }),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const payments: PaymentRow[] = (paymentsRes.data ?? []).map((p: any) => ({
    id: p.id,
    sale_id: p.sale_id,
    amount_centavos: p.amount_centavos,
    method: p.method ?? "cash",
    payer_name: p.payer_name,
    payer_contact: p.payer_contact,
    note: p.note,
    owner_note: p.owner_note,
    created_at: p.created_at,
    voided: !!p.deleted_at,
    recorded_by: p.profiles?.full_name ?? "?",
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ShopReceivablesView
      rows={rows}
      payments={payments}
    />
  );
}
