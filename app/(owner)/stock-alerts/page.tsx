import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import type { MasterLowStockRow, ShopLowStockRow } from "@/lib/db-types";
import {
  StockAlertsView,
  type ProductThresholdRow,
  type OverrideRow,
} from "./stock-alerts-view";
import type { RequestRow } from "./requests-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const metadata: Metadata = { title: "Stock Alerts" };

/**
 * Stock Alerts streams: the heading paints instantly and the body (summary
 * cards + tabs + tables) loads behind a matching skeleton — only the data area
 * shows a skeleton, not the whole page.
 */
export default function StockAlertsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stock Alerts</h1>
        <p className="text-sm text-muted-foreground">
          Master shortages are bought from a supplier. Shop shortages are fixed
          by delivering from master.
        </p>
      </div>
      <Suspense fallback={<StockAlertsBodySkeleton />}>
        <StockAlertsBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function StockAlertsBody({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const supabase = await createClient();

  const [masterRes, shopRes, partsRes, modelsRes, overridesRes, shopsRes, suppliersRes, requestsRes] =
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
          "id, shop_id, part_id, engine_model_id, reorder_level, shops(name, color_key), parts(name, reorder_level), engine_models(brand, model, reorder_level)"
        )
        .is("deleted_at", null),
      supabase.from("shops").select("id, name, color_key").is("deleted_at", null).order("name"),
      supabase.from("suppliers").select("id, name").is("deleted_at", null).order("name"),
      // Shops asking for stock — moved here from Deliveries (a request is a
      // stock-alert signal, not a movement). Convert jumps to the delivery form.
      supabase
        .from("delivery_requests")
        .select(
          `id, shop_id, status, note, owner_note, created_at, fulfilled_at, fulfilled_delivery_id,
           shops(name, color_key),
           profiles!delivery_requests_requested_by_fkey(full_name),
           delivery_request_lines(qty_requested, note, custom_name, parts(name, unit), engine_models(brand, model))`
        )
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100),
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
    shop_color_key: o.shops?.color_key ?? null,
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

  const requests: RequestRow[] = (requestsRes.data ?? []).map((r: any) => ({
    id: r.id,
    shop_id: r.shop_id,
    shop_name: r.shops?.name ?? "?",
    shop_color_key: r.shops?.color_key ?? null,
    employee: r.profiles?.full_name ?? "?",
    status: r.status,
    note: r.note,
    owner_note: r.owner_note,
    created_at: r.created_at,
    fulfilled_at: r.fulfilled_at,
    fulfilled_delivery_id: r.fulfilled_delivery_id,
    items: (r.delivery_request_lines ?? []).map((l: any) => ({
      qty: l.qty_requested,
      note: l.note,
      name:
        l.parts?.name ??
        (l.engine_models
          ? `${l.engine_models.brand ?? ""} ${l.engine_models.model ?? ""}`.trim()
          : l.custom_name ?? "New product"),
      unit: l.parts?.unit ?? "unit",
      is_engine: !l.parts && !!l.engine_models,
      is_custom: !l.parts && !l.engine_models,
    })),
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
      requests={requests}
      initialTab={tab}
    />
  );
}

function StockAlertsBodySkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardHeader className="pb-2">
              <Skeleton className="h-4 w-28" />
            </CardHeader>
            <CardContent>
              <Skeleton className="h-8 w-16" />
              <Skeleton className="mt-2 h-3 w-40" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-28" />
      </div>
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-40" />
      </div>
      <div className="overflow-hidden rounded-xl border">
        <div className="flex gap-4 border-b bg-muted/30 px-4 py-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, r) => (
          <div key={r} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
