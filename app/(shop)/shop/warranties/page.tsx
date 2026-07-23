import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Skeleton } from "@/components/ui/skeleton";
import type { ShopEngineRow } from "@/lib/db-types";
import {
  ShopWarrantiesView,
  type ShopWarrantyRow,
  type ShopWarrantyClaimRow,
} from "./warranties-view";

export const metadata: Metadata = { title: "Warranties" };

function ShopWarrantiesSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

export default function ShopWarrantiesPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Warranties</h1>
        <p className="text-sm text-muted-foreground">
          Engines your shop sold. Look up a serial when a customer comes in, and
          file a warranty claim when one comes back — Admin approves it.
        </p>
      </div>
      <Suspense fallback={<ShopWarrantiesSkeleton />}>
        <ShopWarrantiesBody />
      </Suspense>
    </div>
  );
}

async function ShopWarrantiesBody() {
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
