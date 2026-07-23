import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/pnl";
import type { Category, EngineModel, EngineRow, PartRow } from "@/lib/db-types";
import { CatalogTabs } from "./catalog-tabs";

export const metadata: Metadata = { title: "Master Inventory" };

export default async function MasterInventoryPage() {
  const supabase = await createClient();

  const [partsRes, allEngines, categoriesRes, modelsRes, fitmentsRes, pricesRes, suppliersRes] = await Promise.all([
    supabase
      .from("parts")
      .select(
        "id, name, category_id, sku, barcode, unit, cost_centavos, price_centavos, reorder_level, notes, image_path, product_categories(name), stock_levels(shop_id, qty)"
      )
      .is("deleted_at", null)
      // newest first, same as engines — a just-added product must be visible on top
      .order("created_at", { ascending: false }),
    // every serial-tracked engine — paginated (keyset by id): this outgrows the
    // 1,000-row cap, which would drop engines from the catalog. The view sorts.
    fetchAll(
      () =>
        supabase
          .from("engines")
          .select(
            "id, serial_number, engine_model_id, condition, cost_centavos, price_centavos, warranty_months, status, image_path, engine_models(brand, model, horsepower), shops(name, color_key)"
          )
          .is("deleted_at", null),
      "id"
    ),
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
    // Supplier price comparison (owner-only view): every price labelled with
    // source + date; surfaced per product so "same part, three suppliers,
    // three prices" is visible where Jerry actually looks.
    supabase
      .from("supplier_price_comparison")
      .select(
        "supplier_id, supplier_name, part_id, engine_model_id, last_paid_centavos, last_paid_at, receiving_id, quote_centavos, quoted_at, quote_stale, effective_centavos, effective_source, effective_as_of, is_preferred, is_cheapest"
      )
      .not("part_id", "is", null),
    // suppliers for the Add product/engine attribution dropdown ("No supplier")
    supabase.from("suppliers").select("id, name").is("deleted_at", null).order("name"),
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
    total_qty: (p.stock_levels ?? []).reduce((sum: number, s: any) => sum + s.qty, 0),
  }));

  const engines: EngineRow[] = (allEngines as any[]).map((e: any) => ({
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
    shop_color_key: e.shops?.color_key ?? null,
    image_path: e.image_path,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const categories: Category[] = categoriesRes.data ?? [];
  const models: EngineModel[] = modelsRes.data ?? [];
  const suppliers = suppliersRes.data ?? [];

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const pricesByPart: Record<string, any[]> = {};
  for (const r of pricesRes.data ?? []) {
    (pricesByPart[(r as any).part_id] ??= []).push(r);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <CatalogTabs
      parts={parts}
      engines={engines}
      categories={categories}
      models={models}
      suppliers={suppliers}
      fitmentsByPart={fitmentsByPart}
      pricesByPart={pricesByPart}
    />
  );
}
