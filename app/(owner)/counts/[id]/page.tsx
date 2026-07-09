import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CountEntry, type CountLine } from "./count-entry";

export const metadata: Metadata = { title: "Count Entry" };

export default async function CountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: snap } = await supabase
    .from("count_snapshots")
    .select(
      `id, snapshot_date, note, shops(name),
       count_snapshot_lines(id, expected_qty, counted_qty, shortage_loss_id,
         parts(name, unit, barcode))`
    )
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (!snap) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const s = snap as any;
  const lines: CountLine[] = (s.count_snapshot_lines ?? [])
    .map((l: any) => ({
      id: l.id,
      part_name: l.parts?.name ?? "?",
      unit: l.parts?.unit ?? "pc",
      barcode: l.parts?.barcode ?? null,
      expected_qty: l.expected_qty,
      counted_qty: l.counted_qty,
      sent: !!l.shortage_loss_id,
    }))
    .sort((a: CountLine, b: CountLine) => a.part_name.localeCompare(b.part_name));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <CountEntry
      snapshotId={s.id}
      shopName={s.shops?.name ?? "?"}
      snapshotDate={s.snapshot_date}
      note={s.note}
      lines={lines}
    />
  );
}
