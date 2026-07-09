import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { CountsList, type CountListRow } from "./counts-list";

export const metadata: Metadata = { title: "Monthly Count" };

export default async function CountsPage() {
  const supabase = await createClient();

  const [snapshotsRes, shopsRes] = await Promise.all([
    supabase
      .from("count_snapshots")
      .select(
        "id, snapshot_date, note, created_at, shops(name), count_snapshot_lines(id, expected_qty, counted_qty, shortage_loss_id)"
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("shops")
      .select("id, name")
      .eq("active", true)
      .is("deleted_at", null)
      .order("name"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const snapshots: CountListRow[] = (snapshotsRes.data ?? []).map((s: any) => {
    const lines = s.count_snapshot_lines ?? [];
    const counted = lines.filter((l: any) => l.counted_qty !== null);
    const variances = counted.filter((l: any) => l.counted_qty !== l.expected_qty);
    return {
      id: s.id,
      snapshot_date: s.snapshot_date,
      note: s.note,
      shop_name: s.shops?.name ?? "?",
      total_lines: lines.length,
      counted_lines: counted.length,
      variance_lines: variances.length,
      sent_lines: lines.filter((l: any) => l.shortage_loss_id).length,
    };
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return <CountsList snapshots={snapshots} shops={shopsRes.data ?? []} />;
}
