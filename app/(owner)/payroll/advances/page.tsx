import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import {
  AdvancesView,
  type StaffOption,
  type BalanceRow,
  type AdvanceRow,
} from "./advances-view";

export const metadata: Metadata = { title: "Advances" };

export default async function PayrollAdvancesPage() {
  const supabase = await createClient();

  const [staffRes, balancesRes, advancesRes] = await Promise.all([
    supabase
      .from("staff")
      .select("id, full_name, shops(name, color_key)")
      .eq("active", true)
      .is("deleted_at", null)
      .order("full_name"),
    supabase
      .from("staff_advance_balances")
      .select("staff_id, full_name, advanced, deducted, balance"),
    supabase
      .from("staff_advances")
      .select(
        "id, staff_id, amount_centavos, note, advance_date, staff(full_name), shops(name, color_key)"
      )
      .is("deleted_at", null)
      .order("advance_date", { ascending: false })
      .limit(100),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const staff: StaffOption[] = (staffRes.data ?? []).map((s: any) => ({
    id: s.id,
    full_name: s.full_name,
    shop_name: s.shops?.name ?? null,
    shop_color_key: s.shops?.color_key ?? null,
  }));
  const balances: BalanceRow[] = (balancesRes.data ?? [])
    .map((b: any) => ({
      staff_id: b.staff_id,
      full_name: b.full_name,
      advanced: b.advanced ?? 0,
      deducted: b.deducted ?? 0,
      balance: b.balance ?? 0,
    }))
    .filter((b: BalanceRow) => b.balance > 0)
    .sort((a: BalanceRow, b: BalanceRow) => b.balance - a.balance);
  const advances: AdvanceRow[] = (advancesRes.data ?? []).map((a: any) => ({
    id: a.id,
    staff_name: a.staff?.full_name ?? "?",
    shop_name: a.shops?.name ?? null,
    shop_color_key: a.shops?.color_key ?? null,
    amount_centavos: a.amount_centavos,
    note: a.note,
    advance_date: a.advance_date,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return <AdvancesView staff={staff} balances={balances} advances={advances} />;
}
