import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { CountsList, type CountListRow } from "./counts-list";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Monthly Count" };

/**
 * The heading paints instantly; the New-count card + history table stream in
 * behind a matching skeleton — only the data area shows a skeleton.
 */
export default function CountsPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Monthly Count</h1>
        <p className="text-sm text-muted-foreground">
          Freeze a shop&apos;s expected stock, print the sheet, count physically,
          enter results — shortages go through the normal approval queue.
        </p>
      </div>
      <Suspense fallback={<CountsBodySkeleton />}>
        <CountsBody />
      </Suspense>
    </div>
  );
}

async function CountsBody() {
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

function CountsBodySkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="pb-2">
          <Skeleton className="h-4 w-36" />
          <Skeleton className="mt-2 h-3 w-72" />
        </CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Skeleton className="h-9 w-52" />
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-9 w-44" />
          <Skeleton className="h-9 w-36" />
        </CardContent>
      </Card>
      <Skeleton className="h-9 w-full max-w-xs" />
      <div className="overflow-hidden rounded-md border">
        <div className="flex gap-4 border-b bg-muted/30 px-4 py-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
        {Array.from({ length: 6 }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
