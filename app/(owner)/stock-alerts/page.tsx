import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { MasterLowStockRow, ShopLowStockRow } from "@/lib/db-types";
import {
  StockAlertsView,
  type ProductThresholdRow,
  type OverrideRow,
} from "./stock-alerts-view";

export const metadata: Metadata = { title: "Stock Alerts" };

export default async function StockAlertsPage() {
  const supabase = await createClient();

  const [masterRes, shopRes, partsRes, modelsRes, overridesRes, shopsRes, suppliersRes] =
    await Promise.all([
      supabase.from("master_low_stock").select("*"),
      supabase.from("shop_low_stock").select("*"),
      supabase
        .from("parts")
        .select("id, name, unit, reorder_level, preferred_supplier_id")
        .is("deleted_at", null)
        .order("name"),
      supabase
        .from("engine_models")
        .select("id, brand, model, reorder_level, preferred_supplier_id")
        .is("deleted_at", null)
        .order("brand"),
      supabase
        .from("shop_reorder_levels")
        .select(
          "id, shop_id, part_id, engine_model_id, reorder_level, shops(name), parts(name, reorder_level), engine_models(brand, model, reorder_level)"
        )
        .is("deleted_at", null),
      supabase.from("shops").select("id, name").is("deleted_at", null).order("name"),
      supabase.from("suppliers").select("id, name").is("deleted_at", null).order("name"),
    ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const products: ProductThresholdRow[] = [
    ...(partsRes.data ?? []).map((p: any) => ({
      kind: "part" as const,
      id: p.id,
      name: p.name,
      unit: p.unit,
      reorder_level: p.reorder_level ?? 0,
      preferred_supplier_id: p.preferred_supplier_id ?? null,
    })),
    ...(modelsRes.data ?? []).map((m: any) => ({
      kind: "engine_model" as const,
      id: m.id,
      name: `${m.brand} ${m.model}`,
      unit: "unit",
      reorder_level: m.reorder_level ?? 0,
      preferred_supplier_id: m.preferred_supplier_id ?? null,
    })),
  ];

  const overrides: OverrideRow[] = (overridesRes.data ?? []).map((o: any) => ({
    id: o.id,
    shop_id: o.shop_id,
    shop_name: o.shops?.name ?? "?",
    kind: o.part_id ? "part" : "engine_model",
    product_id: o.part_id ?? o.engine_model_id,
    product_name: o.part_id
      ? (o.parts?.name ?? "?")
      : `${o.engine_models?.brand ?? ""} ${o.engine_models?.model ?? ""}`.trim(),
    reorder_level: o.reorder_level,
    default_level: o.part_id
      ? (o.parts?.reorder_level ?? 0)
      : (o.engine_models?.reorder_level ?? 0),
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <StockAlertsView
      master={(masterRes.data ?? []) as MasterLowStockRow[]}
      shopLow={(shopRes.data ?? []) as ShopLowStockRow[]}
      products={products}
      overrides={overrides}
      shops={shopsRes.data ?? []}
      suppliers={suppliersRes.data ?? []}
    />
  );
}
