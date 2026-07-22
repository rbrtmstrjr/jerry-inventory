import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { ReceivableRow } from "@/lib/db-types";
import { OwnerReceivablesView, type PaymentHistoryRow } from "./receivables-view";

export const metadata: Metadata = { title: "Receivables" };

export default async function OwnerReceivablesPage() {
  const supabase = await createClient();

  const [rowsRes, historyRes, shopsRes] = await Promise.all([
    // owner sees every shop through the same view
    supabase.from("receivables").select("*").order("created_at", { ascending: false }),
    // full history: posted + voided (voided rows are soft-deleted)
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
    <OwnerReceivablesView
      rows={(rowsRes.data ?? []) as ReceivableRow[]}
      history={history}
      shops={shopsRes.data ?? []}
    />
  );
}
