import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { Category, EngineModel, EngineRow, PartRow } from "@/lib/db-types";
import { CatalogTabs } from "./catalog-tabs";

export const metadata: Metadata = { title: "Master Inventory" };

export default async function MasterInventoryPage() {
  const supabase = await createClient();

  const [partsRes, enginesRes, categoriesRes, modelsRes, fitmentsRes] = await Promise.all([
    supabase
      .from("parts")
      .select(
        "id, name, category_id, sku, barcode, unit, cost_centavos, price_centavos, reorder_level, notes, image_path, product_categories(name), stock_levels(shop_id, qty)"
      )
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("engines")
      .select(
        "id, serial_number, engine_model_id, condition, cost_centavos, price_centavos, warranty_months, status, image_path, engine_models(brand, model, horsepower), shops(name)"
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("product_categories")
      .select("id, name")
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("engine_models")
      .select("id, brand, model, horsepower, stroke, default_warranty_months")
      .is("deleted_at", null)
      .order("brand"),
    supabase.from("part_fitments").select("part_id, engine_model_id"),
  ]);

  const fitmentsByPart: Record<string, string[]> = {};
  for (const f of fitmentsRes.data ?? []) {
    (fitmentsByPart[f.part_id] ??= []).push(f.engine_model_id);
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const parts: PartRow[] = (partsRes.data ?? []).map((p: any) => ({
    id: p.id,
    name: p.name,
    category_id: p.category_id,
    category_name: p.product_categories?.name ?? null,
    sku: p.sku,
    barcode: p.barcode,
    unit: p.unit,
    cost_centavos: p.cost_centavos,
    price_centavos: p.price_centavos,
    reorder_level: p.reorder_level,
    notes: p.notes,
    image_path: p.image_path,
    master_qty:
      (p.stock_levels ?? []).find((s: any) => s.shop_id === null)?.qty ?? 0,
  }));

  const engines: EngineRow[] = (enginesRes.data ?? []).map((e: any) => ({
    id: e.id,
    serial_number: e.serial_number,
    engine_model_id: e.engine_model_id,
    brand: e.engine_models?.brand ?? "?",
    model: e.engine_models?.model ?? "?",
    horsepower: e.engine_models?.horsepower ?? null,
    condition: e.condition,
    cost_centavos: e.cost_centavos,
    price_centavos: e.price_centavos,
    warranty_months: e.warranty_months,
    status: e.status,
    shop_name: e.shops?.name ?? null,
    image_path: e.image_path,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const categories: Category[] = categoriesRes.data ?? [];
  const models: EngineModel[] = modelsRes.data ?? [];

  return (
    <CatalogTabs
      parts={parts}
      engines={engines}
      categories={categories}
      models={models}
      fitmentsByPart={fitmentsByPart}
    />
  );
}
