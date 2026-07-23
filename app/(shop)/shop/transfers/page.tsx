import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { Skeleton } from "@/components/ui/skeleton";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import {
  ShopTransfersView,
  type DestShop,
  type OutgoingTransfer,
  type OutgoingLine,
} from "./transfers-view";
import type { ShopReturn, ShopReturnLine } from "./returns-panel";

export const metadata: Metadata = { title: "Transfers" };

export default function ShopTransfersPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Transfers</h1>
        <p className="text-sm text-muted-foreground">
          Send stock to another shop. Admin approves the request first; the
          receiving shop then confirms what actually arrives.
        </p>
      </div>
      <Suspense fallback={<ShopTransfersSkeleton />}>
        <ShopTransfersBody />
      </Suspense>
    </div>
  );
}

function ShopTransfersSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-lg" />
      ))}
    </div>
  );
}

async function ShopTransfersBody() {
  const supabase = await createClient();
  const profile = await getProfile();
  const myShopId = profile?.shop_id ?? null;

  const [shopsRes, stockRes, enginesRes, txRes, lineRes, returnsRes, returnLinesRes] =
    await Promise.all([
    // other live, active shops we can send to — a safe view (0067), since
    // shops_select scopes an employee to its OWN shop row only
    supabase
      .from("shop_transfer_destinations")
      .select("id, name, color_key")
      .order("name"),
    supabase.from("shop_stock").select("*").order("name"),
    supabase.from("shop_engines").select("*").order("serial_number"),
    // both views are already scoped to the caller's shop and carry no cost
    supabase
      .from("shop_outgoing_transfers")
      .select("*")
      .order("requested_at", { ascending: false })
      .limit(50),
    supabase.from("shop_outgoing_transfer_lines").select("*"),
    // this shop's own return requests (0065), scoped by the safe views
    supabase
      .from("shop_returns")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50),
    supabase.from("shop_return_lines").select("*"),
  ]);

  const destinations = ((shopsRes.data ?? []) as DestShop[]).filter(
    (s) => s.id !== myShopId
  );

  return (
    <ShopTransfersView
      destinations={destinations}
      stock={(stockRes.data ?? []) as ShopStockRow[]}
      engines={(enginesRes.data ?? []) as ShopEngineRow[]}
      transfers={(txRes.data ?? []) as OutgoingTransfer[]}
      lines={(lineRes.data ?? []) as OutgoingLine[]}
      returns={(returnsRes.data ?? []) as ShopReturn[]}
      returnLines={(returnLinesRes.data ?? []) as ShopReturnLine[]}
    />
  );
}
