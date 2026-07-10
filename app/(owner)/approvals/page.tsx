import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import {
  ApprovalsView,
  type PendingSale,
  type PendingLoss,
} from "./approvals-view";

export const metadata: Metadata = { title: "Approval Queue" };

export default async function ApprovalsPage() {
  const supabase = await createClient();

  const [salesRes, lossesRes, reviewedRes] = await Promise.all([
    supabase
      .from("sales")
      .select(
        `id, shop_id, business_date, status, total_centavos, owner_note, created_at, batch_id,
         submission_batches(submitted_at),
         shops(name),
         profiles!sales_recorded_by_fkey(full_name),
         customers(name, phone),
         sale_lines(description, qty, unit_price_centavos, line_total_centavos, engine_id)`
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
    supabase
      .from("sales")
      .select("id, status, total_centavos, reviewed_at, shops(name)")
      .in("status", ["approved", "rejected"])
      .is("deleted_at", null)
      .order("reviewed_at", { ascending: false })
      .limit(10),
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
    owner_note: s.owner_note,
    created_at: s.created_at,
    has_engine: (s.sale_lines ?? []).some((l: any) => l.engine_id),
    lines: (s.sale_lines ?? []).map((l: any) => ({
      description: l.description ?? "Item",
      qty: l.qty,
      line_total_centavos: l.line_total_centavos,
      is_engine: !!l.engine_id,
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

  const recent = (reviewedRes.data ?? []).map((s: any) => ({
    id: s.id as string,
    status: s.status as string,
    total_centavos: s.total_centavos as number,
    reviewed_at: s.reviewed_at as string | null,
    shop_name: (s.shops?.name ?? "?") as string,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return <ApprovalsView sales={sales} losses={losses} recent={recent} />;
}
