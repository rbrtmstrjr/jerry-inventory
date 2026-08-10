import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ShopDeliveriesView,
  type IncomingDelivery,
  type IncomingLine,
} from "./deliveries-view";

export const metadata: Metadata = { title: "Incoming Deliveries" };

function ShopDeliveriesSkeleton() {
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

export default function ShopDeliveriesPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Incoming Deliveries
        </h1>
        <p className="text-sm text-muted-foreground">
          Count what actually arrives and confirm it. Stock only joins your shop
          once you confirm.
        </p>
      </div>
      <Suspense fallback={<ShopDeliveriesSkeleton />}>
        <ShopDeliveriesBody />
      </Suspense>
    </div>
  );
}

async function ShopDeliveriesBody() {
  const supabase = await createClient();

  // Lines are fetched IN PAGES: an unbounded select caps at 1000 arbitrary rows,
  // which starved newer deliveries and would book them entirely as missing.
  const delRes = await supabase
    .from("shop_incoming_deliveries")
    .select("*")
    .order("delivered_at", { ascending: false })
    .limit(50);

  const deliveries = (delRes.data ?? []) as IncomingDelivery[];

  const PAGE = 1000;
  const lines: IncomingLine[] = [];
  if (deliveries.length) {
    const ids = deliveries.map((d) => d.id);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("shop_incoming_delivery_lines")
        .select("*")
        .in("delivery_id", ids)
        .order("id")
        .range(from, from + PAGE - 1);
      if (error || !data?.length) break;
      lines.push(...(data as IncomingLine[]));
      if (data.length < PAGE) break;
    }
  }

  return <ShopDeliveriesView deliveries={deliveries} lines={lines} />;
}
