import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { RecordLossForm } from "./record-loss-form";

export const metadata: Metadata = { title: "Record Loss" };

export default async function RecordLossPage() {
  const supabase = await createClient();

  const [stockRes, enginesRes] = await Promise.all([
    supabase.from("shop_stock").select("*").order("name"),
    supabase.from("shop_engines").select("*").order("serial_number"),
  ]);

  return (
    <RecordLossForm
      stock={(stockRes.data ?? []) as ShopStockRow[]}
      engines={(enginesRes.data ?? []) as ShopEngineRow[]}
    />
  );
}
