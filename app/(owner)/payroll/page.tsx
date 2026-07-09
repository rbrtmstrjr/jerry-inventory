import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { PeriodsList, type PeriodRow } from "./periods-list";

export const metadata: Metadata = { title: "Run Payroll" };

export default async function PayrollPage() {
  const supabase = await createClient();

  const [periodsRes, staffCountRes] = await Promise.all([
    supabase
      .from("pay_periods")
      .select(
        "id, label, start_date, end_date, frequency, status, payroll_entries(status, net_pay)"
      )
      .is("deleted_at", null)
      .order("start_date", { ascending: false })
      .limit(50),
    supabase
      .from("staff")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .is("deleted_at", null),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const periods: PeriodRow[] = (periodsRes.data ?? []).map((p: any) => {
    const entries = p.payroll_entries ?? [];
    return {
      id: p.id,
      label: p.label,
      start_date: p.start_date,
      end_date: p.end_date,
      frequency: p.frequency,
      status: p.status,
      entry_count: entries.length,
      paid_count: entries.filter((e: any) => e.status === "paid").length,
      total_net: entries.reduce((s: number, e: any) => s + (e.net_pay ?? 0), 0),
    };
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <PeriodsList periods={periods} activeStaffCount={staffCountRes.count ?? 0} />
  );
}
