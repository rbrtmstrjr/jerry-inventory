import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { RecordSaleForm } from "./record-sale-form";

export const metadata: Metadata = { title: "Record Sale" };

export default async function RecordSalePage() {
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
