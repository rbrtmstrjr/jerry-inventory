import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/pnl";
import type { Category, EngineModel, EngineRow, PartRow } from "@/lib/db-types";
import { CatalogTabs } from "./catalog-tabs";
import { PartsTable } from "./parts-table";
import { EnginesTable } from "./engines-table";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Master Inventory" };

/**
 * Master Inventory streams: the tab bar (Parts / Engines) paints instantly and
 * each tab's table loads behind its own skeleton — the page is never blocked on
 * the catalog fetch, and only the DATA area shows a skeleton (not the whole
 * page). Parts and Engines fetch concurrently.
 */
export default function MasterInventoryPage() {
  return (
    <CatalogTabs
      partsSlot={
        <Suspense fallback={<CatalogSkeleton />}>
          <PartsPanel />
        </Suspense>
      }
      enginesSlot={
        <Suspense fallback={<CatalogSkeleton />}>
          <EnginesPanel />
        </Suspense>
      }
    />
  );
}

async function PartsPanel() {
  const supabase = await createClient();
  const [partsRes, categoriesRes, modelsRes, fitmentsRes, pricesRes, suppliersRes] =
    await Promise.all([
      supabase
        .from("parts")
        .select(
          "id, name, category_id, sku, barcode, unit, cost_centavos, price_centavos, reorder_level, notes, image_path, product_categories(name), stock_levels(shop_id, qty)"
        )
        .is("deleted_at", null)
        // newest first — a just-added product must be visible on top
        .order("created_at", { ascending: false }),
      supabase.from("product_categories").select("id, name").is("deleted_at", null).order("name"),
      supabase
        .from("engine_models")
        .select("id, brand, model, horsepower, stroke, default_warranty_months")
        .is("deleted_at", null)
        .order("brand"),
      supabase.from("part_fitments").select("part_id, engine_model_id"),
      // Supplier price comparison (owner-only view) — per product.
      supabase
        .from("supplier_price_comparison")
        .select(
          "supplier_id, supplier_name, part_id, engine_model_id, last_paid_centavos, last_paid_at, receiving_id, quote_centavos, quoted_at, quote_stale, effective_centavos, effective_source, effective_as_of, is_preferred, is_cheapest"
        )
        .not("part_id", "is", null),
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
    master_qty: (p.stock_levels ?? []).find((s: any) => s.shop_id === null)?.qty ?? 0,
    total_qty: (p.stock_levels ?? []).reduce((sum: number, s: any) => sum + s.qty, 0),
  }));

  const pricesByPart: Record<string, any[]> = {};
  for (const r of pricesRes.data ?? []) {
    (pricesByPart[(r as any).part_id] ??= []).push(r);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <PartsTable
      parts={parts}
      categories={(categoriesRes.data ?? []) as Category[]}
      models={(modelsRes.data ?? []) as EngineModel[]}
      suppliers={suppliersRes.data ?? []}
      fitmentsByPart={fitmentsByPart}
      pricesByPart={pricesByPart}
    />
  );
}

async function EnginesPanel() {
  const supabase = await createClient();
  const [allEngines, modelsRes, suppliersRes] = await Promise.all([
    // every serial-tracked engine — paginated (keyset by id) past the 1,000 cap.
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
      .from("engine_models")
      .select("id, brand, model, horsepower, stroke, default_warranty_months")
      .is("deleted_at", null)
      .order("brand"),
    supabase.from("suppliers").select("id, name").is("deleted_at", null).order("name"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
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

  return (
    <EnginesTable
      engines={engines}
      models={(modelsRes.data ?? []) as EngineModel[]}
      suppliers={suppliersRes.data ?? []}
    />
  );
}

/** Skeleton for a catalog tab: toolbar (view toggle · add · search) + a card grid. */
function CatalogSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-2">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-64" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="flex flex-col overflow-hidden rounded-lg border">
            <Skeleton className="aspect-square w-full rounded-none" />
            <div className="flex flex-col gap-2 p-3">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="mt-1 h-5 w-2/3" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
