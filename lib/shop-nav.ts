import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export interface ShopNav {
  shopName: string;
  badges: { "/shop/deliveries": number; "/shop/low-stock": number; "/shop/receivables": number };
}

export const getShopBadgeCounts = cache(async (shopId: string | null): Promise<ShopNav> => {
  const supabase = await createClient();
  const empty: ShopNav = { shopName: "My Shop", badges: { "/shop/deliveries": 0, "/shop/low-stock": 0, "/shop/receivables": 0 } };
  if (!shopId) return empty;

  // fast path: one aggregate round-trip
  const { data, error } = await supabase.rpc("fn_shop_badge_counts");
  if (!error && data) {
    return {
      shopName: (data as any).shop_name ?? "My Shop",
      badges: {
        "/shop/deliveries": (data as any).deliveries ?? 0,
        "/shop/low-stock": (data as any).low_stock ?? 0,
        "/shop/receivables": (data as any).receivables ?? 0,
      },
    };
  }

  // fallback: the pre-0109 four-query path (correct, heavier)
  const head = { count: "exact" as const, head: true };
  const [nameRes, delRes, lowRes, recRes] = await Promise.all([
    supabase.from("shops").select("name").eq("id", shopId).single(),
    supabase.from("shop_incoming_deliveries").select("*", head).eq("status", "in_transit"),
    supabase.from("shop_low_stock_safe").select("*", head),
    supabase.from("shop_receivables").select("*", head).gt("balance_centavos", 0),
  ]);
  return {
    shopName: nameRes.data?.name ?? "My Shop",
    badges: {
      "/shop/deliveries": delRes.count ?? 0,
      "/shop/low-stock": lowRes.count ?? 0,
      "/shop/receivables": recRes.count ?? 0,
    },
  };
});
