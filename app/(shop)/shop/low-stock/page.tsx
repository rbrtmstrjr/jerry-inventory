import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import type { ShopLowStockRow } from "@/lib/db-types";
import { ShopLowStockView, type MyRequestRow } from "./low-stock-view";

export const metadata: Metadata = { title: "Low Stock" };

function ShopLowStockSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-lg" />
      ))}
    </div>
  );
}

export default function ShopLowStockPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Low Stock</h1>
        <p className="text-sm text-muted-foreground">
          Items at or below their reorder level. Ask Admin to deliver more —
          shops don&apos;t order from suppliers.
        </p>
      </div>
      <Suspense fallback={<ShopLowStockSkeleton />}>
        <ShopLowStockBody />
      </Suspense>
    </div>
  );
}

async function ShopLowStockBody() {
  const supabase = await createClient();

  const [lowRes, reqRes] = await Promise.all([
    // shop-safe view: already scoped to the caller's shop, no cost columns
    supabase.from("shop_low_stock_safe").select("*").order("shortfall", { ascending: false }),
    // The embed still resolves names when 0081 isn't applied yet (fallback):
    // parts/engine_models are owner-only so it reads null under RLS, but it
    // keeps the pre-0081 behaviour rather than blanking the list.
    supabase
      .from("delivery_requests")
      .select(
        "id, status, note, owner_note, created_at, fulfilled_at, delivery_request_lines(qty_requested, custom_name, parts(name), engine_models(brand, model))"
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  // Line names come from the shop-safe view (0081): parts/engine_models are
  // owner-only, so the embed above returns null names and every catalog item
  // renders as "New product". shop_delivery_request_lines resolves the name for
  // the shop (scoped to its own requests). If the view isn't present yet, the
  // embed above is used as a fallback — never worse than before.
  const reqIds = (reqRes.data ?? []).map((r) => r.id);
  const lineRes = reqIds.length
    ? await supabase
        .from("shop_delivery_request_lines")
        .select("delivery_request_id, qty_requested, name, is_custom")
        .in("delivery_request_id", reqIds)
    : { data: null, error: null };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const linesByReq = new Map<string, MyRequestRow["items"]>();
  for (const l of (lineRes.data ?? []) as any[]) {
    const arr = linesByReq.get(l.delivery_request_id) ?? [];
    arr.push({ qty: l.qty_requested, name: l.name ?? "Product", is_custom: l.is_custom });
    linesByReq.set(l.delivery_request_id, arr);
  }

  const embedItems = (r: any): MyRequestRow["items"] =>
    (r.delivery_request_lines ?? []).map((l: any) => ({
      qty: l.qty_requested,
      name:
        l.parts?.name ??
        (l.engine_models
          ? `${l.engine_models.brand ?? ""} ${l.engine_models.model ?? ""}`.trim()
          : l.custom_name ?? "New product"),
      is_custom: !l.parts && !l.engine_models,
    }));

  const requests: MyRequestRow[] = (reqRes.data ?? []).map((r: any) => ({
    id: r.id,
    status: r.status,
    note: r.note,
    owner_note: r.owner_note,
    created_at: r.created_at,
    fulfilled_at: r.fulfilled_at,
    items: linesByReq.get(r.id) ?? embedItems(r),
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ShopLowStockView
      rows={(lowRes.data ?? []) as ShopLowStockRow[]}
      requests={requests}
    />
  );
}
