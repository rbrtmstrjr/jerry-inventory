import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { fetchAll, fetchAllOffset } from "@/lib/fetch-all";
import { Skeleton } from "@/components/ui/skeleton";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { RecordSaleForm } from "./record-sale-form";

export const metadata: Metadata = { title: "Record Sale" };

async function RecordSaleBody() {
  const supabase = await createClient();

  // Every read here is PAGED — truncation is silent, and the products sorting
  // last would simply stop existing at the counter with stock on the shelf.
  const [rawStock, engines, fitments, modelsRes, openLines] =
    await Promise.all([
      fetchAll<ShopStockRow>(() => supabase.from("shop_stock").select("*"), "part_id"),
      fetchAll<ShopEngineRow>(() => supabase.from("shop_engines").select("*"), "engine_id"),
      // composite PK, no single unique column
      fetchAllOffset<{ part_id: string; engine_model_id: string }>(
        () => supabase.from("part_fitments").select("part_id, engine_model_id"),
        ["part_id", "engine_model_id"]
      ),
      supabase
        .from("engine_models")
        .select("id, brand, model, horsepower")
        .is("deleted_at", null),
      // Quantities already committed to unapproved sales — stock only moves on
      // approval, so shop_stock.qty still counts them. Must never truncate.
      fetchAll<{ id: string; part_id: string; qty: number }>(
        () =>
          supabase
            .from("sale_lines")
            .select("id, part_id, qty, sales!inner(status, deleted_at)")
            .in("sales.status", ["recorded", "pending", "questioned"])
            .is("sales.deleted_at", null)
            .not("part_id", "is", null),
        "id"
      ),
    ]);

  // part_id → qty already committed to an unapproved sale
  const committed = new Map<string, number>();
  for (const l of openLines) {
    committed.set(l.part_id, (committed.get(l.part_id) ?? 0) + Number(l.qty));
  }

  // `qty` stays the shelf figure (what a stock count would find); `available`
  // is what is genuinely still sellable. The form clamps on `available`.
  const stock = rawStock
    .map((s) => {
      const held = committed.get(s.part_id) ?? 0;
      // round to a hundredth: these are numeric(12,2) values summed in JS
      const left = Math.max(0, Math.round((Number(s.qty) - held) * 100) / 100);
      return { ...s, available: left, committed: held };
    })
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));

  // part_id → "Fits: Yamaha Enduro E40GMHL 40HP, …"
  const modelLabel = new Map(
    (modelsRes.data ?? []).map((m) => [
      m.id,
      `${m.brand} ${m.model}${m.horsepower != null ? ` ${m.horsepower}HP` : ""}`,
    ])
  );
  const fitmentHints: Record<string, string> = {};
  for (const f of fitments) {
    const label = modelLabel.get(f.engine_model_id);
    if (!label) continue;
    fitmentHints[f.part_id] = fitmentHints[f.part_id]
      ? `${fitmentHints[f.part_id]}, ${label}`
      : label;
  }

  return (
    <RecordSaleForm
      stock={stock}
      engines={engines.sort((a, b) =>
        (a.serial_number ?? "").localeCompare(b.serial_number ?? "")
      )}
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
