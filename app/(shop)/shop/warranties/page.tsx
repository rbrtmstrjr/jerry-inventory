import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { ShopEngineRow } from "@/lib/db-types";
import {
  ShopWarrantiesView,
  type ShopWarrantyRow,
  type ShopWarrantyClaimRow,
} from "./warranties-view";

export const metadata: Metadata = { title: "Warranties" };

export default async function ShopWarrantiesPage() {
  const supabase = await createClient();

  const [warrantiesRes, claimsRes, enginesRes] = await Promise.all([
    // shop_warranties is scoped to the caller's shop (via the originating sale)
    // and carries no cost columns.
    supabase
      .from("shop_warranties")
      .select("*")
      .order("expires_on", { ascending: true }),
    // this shop's own claims + status
    supabase
      .from("shop_warranty_claims")
      .select("*")
      .order("created_at", { ascending: false }),
    // on-hand engines the shop can offer as a replacement
    supabase.from("shop_engines").select("*").order("serial_number"),
  ]);

  return (
    <ShopWarrantiesView
      rows={(warrantiesRes.data ?? []) as ShopWarrantyRow[]}
      claims={(claimsRes.data ?? []) as ShopWarrantyClaimRow[]}
      engines={(enginesRes.data ?? []) as ShopEngineRow[]}
    />
  );
}
