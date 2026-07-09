import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { SubmissionsView, type SaleSubmission, type LossSubmission } from "./submissions-view";

export const metadata: Metadata = { title: "Submissions" };

export default async function SubmissionsPage() {
  const supabase = await createClient();

  const [salesRes, lossesRes] = await Promise.all([
    supabase
      .from("sales")
      .select(
        "id, business_date, status, total_centavos, owner_note, created_at, sale_lines(description, qty, unit_price_centavos, line_total_centavos)"
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("losses")
      .select(
        "id, business_date, status, reason, qty, note, owner_note, description, created_at"
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  return (
    <SubmissionsView
      sales={(salesRes.data ?? []) as SaleSubmission[]}
      losses={(lossesRes.data ?? []) as LossSubmission[]}
    />
  );
}
