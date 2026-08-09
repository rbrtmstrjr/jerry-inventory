import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import { Skeleton } from "@/components/ui/skeleton";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { RecordLossForm } from "./record-loss-form";

export const metadata: Metadata = { title: "Record Loss" };

async function RecordLossBody() {
  const supabase = await createClient();

  // paged — past 1,000 products PostgREST truncates without erroring
  const [stock, engines] = await Promise.all([
    fetchAll<ShopStockRow>(() => supabase.from("shop_stock").select("*"), "part_id"),
    fetchAll<ShopEngineRow>(() => supabase.from("shop_engines").select("*"), "engine_id"),
  ]);

  return (
    <RecordLossForm
      stock={stock.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))}
      engines={engines.sort((a, b) =>
        (a.serial_number ?? "").localeCompare(b.serial_number ?? "")
      )}
    />
  );
}

function RecordLossSkeleton() {
  return <Skeleton className="h-96 w-full rounded-lg" />;
}

export default function RecordLossPage() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Record Loss / Adjustment
        </h1>
        <p className="text-sm text-muted-foreground">
          Reason-tagged write-off request. It joins your batch and stock only
          deducts when the owner approves.
        </p>
      </div>
      <Suspense fallback={<RecordLossSkeleton />}>
        <RecordLossBody />
      </Suspense>
    </div>
  );
}
