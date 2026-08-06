import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { RecordSaleForm } from "./record-sale-form";

export const metadata: Metadata = { title: "Record Sale" };

async function RecordSaleBody() {
  const supabase = await createClient();

  const [stockRes, enginesRes, fitmentsRes, modelsRes, openRes] =
    await Promise.all([
      supabase.from("shop_stock").select("*").order("name"),
      supabase.from("shop_engines").select("*").order("serial_number"),
      supabase.from("part_fitments").select("part_id, engine_model_id"),
      supabase
        .from("engine_models")
        .select("id, brand, model, horsepower")
        .is("deleted_at", null),
      // Quantities already SPOKEN FOR by sales this shop has recorded but the
      // owner has not approved. Stock only moves on approval, so shop_stock.qty
      // still shows those units on the shelf — record four sales against one
      // 3 kg bag and each of them looks affordable on its own, then the owner's
      // whole batch fails atomically at approval. RLS scopes this to the
      // caller's own shop.
      supabase
        .from("sale_lines")
        .select("part_id, qty, sales!inner(status, deleted_at)")
        .in("sales.status", ["recorded", "pending", "questioned"])
        .is("sales.deleted_at", null)
        .not("part_id", "is", null),
    ]);

  // part_id → qty already committed to an unapproved sale
  const committed = new Map<string, number>();
  for (const l of (openRes.data ?? []) as { part_id: string; qty: number }[]) {
    committed.set(l.part_id, (committed.get(l.part_id) ?? 0) + Number(l.qty));
  }

  // `qty` stays the shelf figure (what a stock count would find); `available`
  // is what is genuinely still sellable. The form clamps on `available`.
  const stock = ((stockRes.data ?? []) as ShopStockRow[]).map((s) => {
    const held = committed.get(s.part_id) ?? 0;
    // round to a tenth: these are numeric(12,1) values summed in JS
    const left = Math.max(0, Math.round((Number(s.qty) - held) * 10) / 10);
    return { ...s, available: left, committed: held };
  });

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
      stock={stock}
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
