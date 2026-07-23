import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import { ph_today } from "@/lib/ph-date";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { ShopStockView } from "./shop-stock-view";

export const metadata: Metadata = { title: "My Shop Stock" };

async function ShopStockBody() {
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

function ShopStockSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 rounded-lg" />
        ))}
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-9 w-28 rounded-md" />
        <Skeleton className="h-9 w-24 rounded-md" />
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="aspect-square rounded-lg" />
        ))}
      </div>
    </div>
  );
}

export default function ShopStockPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">My Shop Stock</h1>
        <p className="text-sm text-muted-foreground">
          Everything delivered to your shop. Record sales and losses — the
          owner approves before stock moves.
        </p>
      </div>
      <Suspense fallback={<ShopStockSkeleton />}>
        <ShopStockBody />
      </Suspense>
    </div>
  );
}
