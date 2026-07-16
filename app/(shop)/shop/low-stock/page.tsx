import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { ShopLowStockRow } from "@/lib/db-types";
import { ShopLowStockView, type MyRequestRow } from "./low-stock-view";

export const metadata: Metadata = { title: "Low Stock" };

export default async function ShopLowStockPage() {
  const supabase = await createClient();

  const [lowRes, reqRes] = await Promise.all([
    // shop-safe view: already scoped to the caller's shop, no cost columns
    supabase.from("shop_low_stock_safe").select("*").order("shortfall", { ascending: false }),
    supabase
      .from("delivery_requests")
      .select(
        "id, status, note, owner_note, created_at, fulfilled_at, delivery_request_lines(qty_requested, parts(name), engine_models(brand, model))"
      )
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const requests: MyRequestRow[] = (reqRes.data ?? []).map((r: any) => ({
    id: r.id,
    status: r.status,
    note: r.note,
    owner_note: r.owner_note,
    created_at: r.created_at,
    fulfilled_at: r.fulfilled_at,
    items: (r.delivery_request_lines ?? []).map((l: any) => ({
      qty: l.qty_requested,
      name: l.parts?.name ?? `${l.engine_models?.brand ?? ""} ${l.engine_models?.model ?? ""}`.trim(),
    })),
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ShopLowStockView
      rows={(lowRes.data ?? []) as ShopLowStockRow[]}
      requests={requests}
    />
  );
}
