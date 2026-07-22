import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import {
  SubmissionsView,
  type ExpenseSubmission,
  type SaleSubmission,
  type LossSubmission,
} from "./submissions-view";

export const metadata: Metadata = { title: "Submissions" };

export default async function SubmissionsPage() {
  const supabase = await createClient();

  const [salesRes, lossesRes, expensesRes] = await Promise.all([
    supabase
      .from("sales")
      .select(
        "id, business_date, status, total_centavos, owner_note, created_at, batch_id, submission_batches(submitted_at), sale_lines(description, qty, unit_price_centavos, line_total_centavos, engine_id)"
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("losses")
      .select(
        "id, business_date, status, reason, qty, note, owner_note, description, created_at, batch_id, submission_batches(submitted_at)"
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
    // shop-recorded only — Admin's own expenses never rode a batch
    supabase
      .from("expenses")
      .select(
        "id, expense_date, status, amount, description, paid_to, review_note, created_at, batch_id, submission_batches(submitted_at), expense_categories(name)"
      )
      .eq("source", "shop")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const withBatch = (r: any) => ({
    ...r,
    batch_id: r.batch_id ?? null,
    batch_submitted_at: r.submission_batches?.submitted_at ?? null,
  });
  const expenses = (expensesRes.data ?? []).map((r: any) => ({
    ...withBatch(r),
    category_name: r.expense_categories?.name ?? null,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <SubmissionsView
      sales={(salesRes.data ?? []).map(withBatch) as SaleSubmission[]}
      losses={(lossesRes.data ?? []).map(withBatch) as LossSubmission[]}
      expenses={expenses as ExpenseSubmission[]}
    />
  );
}
