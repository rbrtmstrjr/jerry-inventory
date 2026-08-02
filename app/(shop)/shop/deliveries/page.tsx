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

  // Both views are already scoped to the caller's shop and carry no cost.
  //
  // The lines are fetched for the deliveries actually shown, IN PAGES. An
  // unbounded select is capped at 1000 rows by PostgREST, and with no ORDER BY
  // the surviving 1000 are an arbitrary subset — so on a shop with real history
  // (35 deliveries here, 5 660 lines between them, monthly restocks of ~250)
  // the newest deliveries were silently starved of their lines. The card still
  // said "N items on the way" and still offered "Confirm what arrived", but
  // there was nothing to count, so confirming would have posted an empty
  // payload and booked the entire delivery as missing.
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
