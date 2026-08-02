import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { parseTableParams } from "@/components/data-table/table-params";
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
export default async function MasterInventoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const tab = one(sp.tab) === "engines" ? "engines" : "parts";

  return (
    <CatalogTabs activeTab={tab}>
      {/* Re-suspend on any page/sort/search change so the skeleton shows again */}
      <Suspense key={suspenseKey(sp)} fallback={<CatalogSkeleton />}>
        {tab === "engines" ? <EnginesPanel sp={sp} /> : <PartsPanel sp={sp} />}
      </Suspense>
    </CatalogTabs>
  );
}

type SP = Record<string, string | string[] | undefined>;

/** Re-suspend key: everything EXCEPT `q`. Including the search term would
 *  remount the subtree on every debounced keystroke — destroying the search
 *  box (focus loss) and flashing the skeleton while you are still typing.
 *  Search instead re-renders in place behind the table's own pending state. */
function suspenseKey(sp: Record<string, string | string[] | undefined>) {
  return JSON.stringify(
    Object.entries(sp)
      .filter(([k]) => k !== "q")
      .sort(([a], [b]) => a.localeCompare(b))
  );
}


async function PartsPanel({ sp }: { sp: SP }) {
  const supabase = await createClient();
  const params = parseTableParams(sp, {
    defaultSort: "created_at",
    defaultDir: "desc",
    sortable: ["created_at", "name", "cost_centavos", "price_centavos"],
  });
  const from = (params.page - 1) * params.pageSize;

  // ONE page of products, sliced in SQL. Search hits name/sku/barcode — all on
  // `parts`, so a plain .or() does it without a flattening view.
  let partsQuery = supabase
    .from("parts")
    .select(
      "id, name, category_id, sku, barcode, unit, cost_centavos, price_centavos, reorder_level, notes, image_path, product_categories(name), stock_levels(shop_id, qty)",
      { count: "exact" }
    )
    .is("deleted_at", null);
  if (params.q) {
    // `or=` is a GRAMMAR, not a value: commas separate its conditions and
    // parentheses group them. Interpolating the raw term made a search for a
    // product named "Impeller (40HP)" return nothing, and one containing a
    // comma raise PGRST100 — both surfaced as "Nothing matches" for a product
    // that exists. Double-quote the value so it is parsed as a literal.
    const like = `%${params.q}%`;
    const v = `"${like.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    partsQuery = partsQuery.or(`name.ilike.${v},sku.ilike.${v},barcode.ilike.${v}`);
  }

  const [partsRes, categoriesRes, modelsRes, suppliersRes] = await Promise.all([
    partsQuery
      // newest first — a just-added product must be visible on top
      .order(params.sort ?? "created_at", { ascending: params.dir === "asc" })
      .range(from, from + params.pageSize - 1),
    supabase.from("product_categories").select("id, name").is("deleted_at", null).order("name"),
    supabase
      .from("engine_models")
      .select("id, brand, model, horsepower, stroke, default_warranty_months")
      .is("deleted_at", null)
      .order("brand"),
    supabase.from("suppliers").select("id, name").is("deleted_at", null).order("name"),
  ]);

  // Fitments + supplier prices only for the products ON THIS PAGE. Both used to
  // be fetched whole (every fitment, every comparison row in the business).
  const pageIds = (partsRes.data ?? []).map((p) => p.id);
  const [fitmentsRes, pricesRes] = pageIds.length
    ? await Promise.all([
        supabase.from("part_fitments").select("part_id, engine_model_id").in("part_id", pageIds),
        supabase
          .from("supplier_price_comparison")
          .select(
            "supplier_id, supplier_name, part_id, engine_model_id, last_paid_centavos, last_paid_at, receiving_id, quote_centavos, quoted_at, quote_stale, effective_centavos, effective_source, effective_as_of, is_preferred, is_cheapest"
          )
          .in("part_id", pageIds),
      ])
    : [{ data: [] }, { data: [] }];

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

  // 0100: prices are encoded at entry; editing them afterward is Gerry-only.
  // 0102: retiring/merging a product is Gerry-only too — one getProfile() call
  // serves both flags.
  const profile = await getProfile();

  return (
    <PartsTable
      parts={parts}
      categories={(categoriesRes.data ?? []) as Category[]}
      models={(modelsRes.data ?? []) as EngineModel[]}
      suppliers={suppliersRes.data ?? []}
      fitmentsByPart={fitmentsByPart}
      pricesByPart={pricesByPart}
      priceLocked={profile?.role === "admin"}
      retireLocked={profile?.role === "admin"}
      total={partsRes.count ?? 0}
      page={params.page}
      pageSize={params.pageSize}
      q={params.q}
    />
  );
}

async function EnginesPanel({ sp }: { sp: SP }) {
  const supabase = await createClient();
  const params = parseTableParams(sp, {
    defaultSort: "created_at",
    defaultDir: "desc",
    sortable: ["created_at", "serial_number", "model", "cost_centavos", "price_centavos", "status"],
  });
  const from = (params.page - 1) * params.pageSize;

  // ONE page of serials from the flattened registry (0084) — searching serial
  // OR model spans engines+engine_models, which the view already resolves into
  // a single `search_text`. This used to load EVERY engine into the browser.
  let enginesQuery = supabase
    .from("engine_registry")
    .select("*", { count: "exact" })
    .is("deleted_at", null);
  if (params.q) {
    enginesQuery = enginesQuery.ilike("search_text", `%${params.q.toLowerCase()}%`);
  }

  const [enginesRes, modelsRes, suppliersRes] = await Promise.all([
    enginesQuery
      .order(params.sort ?? "created_at", { ascending: params.dir === "asc" })
      .range(from, from + params.pageSize - 1),
    supabase
      .from("engine_models")
      .select("id, brand, model, horsepower, stroke, default_warranty_months")
      .is("deleted_at", null)
      .order("brand"),
    supabase.from("suppliers").select("id, name").is("deleted_at", null).order("name"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const engines: EngineRow[] = (enginesRes.data ?? []).map((e: any) => ({
    id: e.id,
    serial_number: e.serial_number,
    engine_model_id: e.engine_model_id,
    brand: e.brand ?? "?",
    model: e.model_name ?? "?",
    horsepower: e.horsepower,
    condition: e.condition,
    cost_centavos: e.cost_centavos,
    price_centavos: e.price_centavos,
    warranty_months: e.warranty_months,
    status: e.status,
    shop_name: e.shop,
    shop_color_key: e.shop_color_key,
    image_path: e.image_path,
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const profile = await getProfile();

  return (
    <EnginesTable
      engines={engines}
      models={(modelsRes.data ?? []) as EngineModel[]}
      suppliers={suppliersRes.data ?? []}
      priceLocked={profile?.role === "admin"}
      retireLocked={profile?.role === "admin"}
      total={enginesRes.count ?? 0}
      page={params.page}
      pageSize={params.pageSize}
      q={params.q}
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
