import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  AdvancesView,
  type StaffOption,
  type BalanceRow,
  type AdvanceRow,
} from "./advances-view";

export const metadata: Metadata = { title: "Advances" };

/** Shell: the layout's heading + tabs stay instant; the vale ledger streams. */
export default function PayrollAdvancesPage() {
  return (
    <Suspense fallback={<AdvancesSkeleton />}>
      <PayrollAdvancesBody />
    </Suspense>
  );
}

async function PayrollAdvancesBody() {
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

function AdvancesSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="mt-2 h-3 w-56" />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <Skeleton className="h-5 w-28" />
            <Skeleton className="mt-2 h-3 w-48" />
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full rounded-md" />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
