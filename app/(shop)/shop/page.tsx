import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { ShopStockView } from "./shop-stock-view";

export const metadata: Metadata = { title: "My Shop Stock" };

export default async function ShopStockPage() {
  const supabase = await createClient();
  const today = ph_today();

  const [stockRes, enginesRes, todaySalesRes, openSalesRes, openLossesRes] =
    await Promise.all([
      supabase.from("shop_stock").select("*").order("name"),
      supabase.from("shop_engines").select("*").order("serial_number"),
      supabase
        .from("sales")
        .select("total_centavos, status")
        .eq("business_date", today)
        .is("deleted_at", null),
      supabase
        .from("sales")
        .select("status")
        .in("status", ["recorded", "pending", "questioned"])
        .is("deleted_at", null),
      supabase
        .from("losses")
        .select("status")
        .in("status", ["recorded", "pending", "questioned"])
        .is("deleted_at", null),
    ]);

  const todaySales = todaySalesRes.data ?? [];
  const open = [...(openSalesRes.data ?? []), ...(openLossesRes.data ?? [])];

  return (
    <ShopStockView
      stock={(stockRes.data ?? []) as ShopStockRow[]}
      engines={(enginesRes.data ?? []) as ShopEngineRow[]}
      todayCount={todaySales.length}
      todayTotalCentavos={todaySales.reduce((s, r) => s + (r.total_centavos ?? 0), 0)}
      recordedCount={open.filter((r) => r.status === "recorded").length}
      pendingCount={open.filter((r) => r.status !== "recorded").length}
    />
  );
}
