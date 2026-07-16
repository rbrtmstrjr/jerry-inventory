import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { ReceivableRow } from "@/lib/db-types";
import { ShopReceivablesView, type PaymentRow } from "./receivables-view";

export const metadata: Metadata = { title: "Receivables" };

export default async function ShopReceivablesPage() {
  const supabase = await createClient();

  const [openRes, paymentsRes] = await Promise.all([
    // shop_receivables is already scoped to the caller's shop
    supabase
      .from("shop_receivables")
      .select("*")
      .order("created_at", { ascending: false }),
    // full history: posted + voided (voided rows are soft-deleted)
    supabase
      .from("utang_payments")
      .select(
        "id, sale_id, amount_centavos, note, owner_note, created_at, deleted_at, profiles!utang_payments_recorded_by_fkey(full_name)"
      )
      .order("created_at", { ascending: false }),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const payments: PaymentRow[] = (paymentsRes.data ?? []).map((p: any) => ({
    id: p.id,
    sale_id: p.sale_id,
    amount_centavos: p.amount_centavos,
    note: p.note,
    owner_note: p.owner_note,
    created_at: p.created_at,
    voided: !!p.deleted_at,
    recorded_by: p.profiles?.full_name ?? "?",
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ShopReceivablesView
      rows={(openRes.data ?? []) as ReceivableRow[]}
      payments={payments}
    />
  );
}
