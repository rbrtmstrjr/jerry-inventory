import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { TableSkeleton } from "@/components/shell/streaming-skeletons";
import { PositionsView, type PositionRow } from "./positions-view";

export const metadata: Metadata = { title: "Positions" };

/** Shell: the layout's heading + tabs stay instant; the positions table streams. */
export default function PositionsPage() {
  return (
    <Suspense fallback={<TableSkeleton cols={5} />}>
      <PositionsBody />
    </Suspense>
  );
}

async function PositionsBody() {
  const supabase = await createClient();

  const [positionsRes, shopsRes, staffRes] = await Promise.all([
    supabase
      .from("positions")
      .select("id, title, shop_id, default_pay_rate, active, shops(name)")
      .is("deleted_at", null)
      .order("title"),
    supabase.from("shops").select("id, name").is("deleted_at", null).order("name"),
    supabase
      .from("staff")
      .select("position_id")
      .is("deleted_at", null),
  ]);

  const staffCount: Record<string, number> = {};
  for (const s of staffRes.data ?? []) {
    if (s.position_id) staffCount[s.position_id] = (staffCount[s.position_id] ?? 0) + 1;
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const positions: PositionRow[] = (positionsRes.data ?? []).map((p: any) => ({
    id: p.id,
    title: p.title,
    shop_id: p.shop_id,
    shop_name: p.shops?.name ?? null,
    default_pay_rate: p.default_pay_rate,
    active: p.active,
    staff_count: staffCount[p.id] ?? 0,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return <PositionsView positions={positions} shops={shopsRes.data ?? []} />;
}
