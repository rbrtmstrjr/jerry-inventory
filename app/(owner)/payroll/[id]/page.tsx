import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { RemittanceTotal } from "@/lib/db-types";
import { PeriodDetail, type EntryRow, type PeriodInfo } from "./period-detail";

export const metadata: Metadata = { title: "Pay Period" };

export default async function PayPeriodPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [periodRes, entriesRes, shopsRes, remittanceRes] = await Promise.all([
    supabase
      .from("pay_periods")
      .select("id, label, start_date, end_date, frequency, status")
      .eq("id", id)
      .is("deleted_at", null)
      .single(),
    supabase
      .from("payroll_entries")
      .select(
        `id, days_worked, gross_pay, net_pay, status, date_paid,
         staff(full_name, pay_type, pay_rate, contributions_enabled, positions(title)),
         shops(id, name),
         payroll_entry_contributions(
           agency, salary_basis_centavos, credited_salary_centavos,
           ee_amount_centavos, er_amount_centavos
         )`
      )
      .eq("pay_period_id", id)
      .order("created_at"),
    supabase.from("shops").select("id, name").is("deleted_at", null).order("name"),
    // Period totals per agency, straight off the frozen snapshots.
    supabase.rpc("fn_remittance_totals", { p_period_id: id }),
  ]);

  const period = periodRes.data as PeriodInfo | null;
  if (!period) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const entries: EntryRow[] = (entriesRes.data ?? [])
    .map((e: any) => ({
      id: e.id,
      staff_name: e.staff?.full_name ?? "?",
      position: e.staff?.positions?.title ?? null,
      pay_type: e.staff?.pay_type ?? "daily",
      pay_rate: e.staff?.pay_rate ?? 0,
      shop_id: e.shops?.id ?? "",
      shop_name: e.shops?.name ?? "?",
      days_worked: Number(e.days_worked),
      gross_pay: e.gross_pay,
      // net_pay is computed by the DB as gross − employee shares. Never recomputed here.
      net_pay: e.net_pay,
      contributions_enabled: e.staff?.contributions_enabled ?? true,
      contributions: e.payroll_entry_contributions ?? [],
      status: e.status,
      date_paid: e.date_paid,
    }))
    .sort((a: EntryRow, b: EntryRow) =>
      (a.shop_name + a.staff_name).localeCompare(b.shop_name + b.staff_name)
    );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <PeriodDetail
      period={period}
      entries={entries}
      shops={shopsRes.data ?? []}
      remittance={(remittanceRes.data ?? []) as RemittanceTotal[]}
    />
  );
}
