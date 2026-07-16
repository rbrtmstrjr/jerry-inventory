import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { ShopWarrantiesView, type ShopWarrantyRow } from "./warranties-view";

export const metadata: Metadata = { title: "Warranties" };

export default async function ShopWarrantiesPage() {
  const supabase = await createClient();

  // shop_warranties is scoped to the caller's shop (via the originating sale)
  // and carries no cost columns.
  const { data } = await supabase
    .from("shop_warranties")
    .select("*")
    .order("expires_on", { ascending: true });

  return (
    <ShopWarrantiesView rows={(data ?? []) as ShopWarrantyRow[]} />
  );
}
