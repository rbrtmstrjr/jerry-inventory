import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { RecordSaleForm } from "./record-sale-form";

export const metadata: Metadata = { title: "Record Sale" };

async function RecordSaleBody() {
  const supabase = await createClient();

  const [stockRes, enginesRes, fitmentsRes, modelsRes] = await Promise.all([
    supabase.from("shop_stock").select("*").order("name"),
    supabase.from("shop_engines").select("*").order("serial_number"),
    supabase.from("part_fitments").select("part_id, engine_model_id"),
    supabase
      .from("engine_models")
      .select("id, brand, model, horsepower")
      .is("deleted_at", null),
  ]);

  // part_id → "Fits: Yamaha Enduro E40GMHL 40HP, …"
  const modelLabel = new Map(
    (modelsRes.data ?? []).map((m) => [
      m.id,
      `${m.brand} ${m.model}${m.horsepower != null ? ` ${m.horsepower}HP` : ""}`,
    ])
  );
  const fitmentHints: Record<string, string> = {};
  for (const f of fitmentsRes.data ?? []) {
    const label = modelLabel.get(f.engine_model_id);
    if (!label) continue;
    fitmentHints[f.part_id] = fitmentHints[f.part_id]
      ? `${fitmentHints[f.part_id]}, ${label}`
      : label;
  }

  return (
    <RecordSaleForm
      stock={(stockRes.data ?? []) as ShopStockRow[]}
      engines={(enginesRes.data ?? []) as ShopEngineRow[]}
      fitmentHints={fitmentHints}
    />
  );
}

function RecordSaleSkeleton() {
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Skeleton className="h-[60vh] rounded-lg lg:col-span-3" />
      <Skeleton className="h-[60vh] rounded-lg lg:col-span-2" />
    </div>
  );
}

export default function RecordSalePage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Record Sale</h1>
        <p className="text-sm text-muted-foreground">
          Scan a barcode / engine serial, or search. Nothing deducts until
          the owner approves.
        </p>
      </div>
      <Suspense fallback={<RecordSaleSkeleton />}>
        <RecordSaleBody />
      </Suspense>
    </div>
  );
}
