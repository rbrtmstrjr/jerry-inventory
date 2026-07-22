import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { ShopStockView } from "./shop-stock-view";

export const metadata: Metadata = { title: "My Shop Stock" };

export default async function ShopStockPage() {
  const supabase = await createClient();
  const today = ph_today();

  const [stockRes, enginesRes, todaySalesRes, receivablesRes] =
    await Promise.all([
      supabase.from("shop_stock").select("*").order("name"),
      supabase.from("shop_engines").select("*").order("serial_number"),
      supabase
        .from("sales")
        .select("total_centavos, status")
        .eq("business_date", today)
        .is("deleted_at", null),
      // shop_receivables is already scoped to this shop; open utang = balance > 0
      supabase
        .from("shop_receivables")
        .select("balance_centavos")
        .gt("balance_centavos", 0),
    ]);

  const todaySales = todaySalesRes.data ?? [];
  const receivables = receivablesRes.data ?? [];

  return (
    <ShopStockView
      stock={(stockRes.data ?? []) as ShopStockRow[]}
      engines={(enginesRes.data ?? []) as ShopEngineRow[]}
      todayCount={todaySales.length}
      todayTotalCentavos={todaySales.reduce((s, r) => s + (r.total_centavos ?? 0), 0)}
      receivablesCentavos={receivables.reduce(
        (s, r) => s + (r.balance_centavos ?? 0),
        0
      )}
      receivablesCount={receivables.length}
    />
  );
}
