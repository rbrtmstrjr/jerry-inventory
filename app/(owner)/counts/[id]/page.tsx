import type { Metadata } from "next";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CountEntry, type CountLine } from "./count-entry";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Count Entry" };

export default function CountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<CountDetailSkeleton />}>
      <CountDetailBody params={params} />
    </Suspense>
  );
}

async function CountDetailBody({
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

function CountDetailSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <Skeleton className="h-8 w-56" />
          <Skeleton className="mt-2 h-3 w-72" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <Skeleton className="h-9 w-full max-w-xs" />
      <div className="overflow-hidden rounded-md border">
        <div className="flex gap-4 border-b bg-muted/30 px-4 py-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
        {Array.from({ length: 10 }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
