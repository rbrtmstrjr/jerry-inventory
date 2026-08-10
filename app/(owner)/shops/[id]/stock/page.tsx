import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { fetchAll } from "@/lib/fetch-all";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { Button } from "@/components/ui/button";
import { TableSkeleton } from "@/components/shell/streaming-skeletons";
import { ShopStockReadonly } from "./shop-stock-readonly";

export const metadata: Metadata = { title: "Shop Stock" };

export default async function OwnerShopStockPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: shop } = await supabase
    .from("shops")
    .select("id, name, location")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (!shop) notFound();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button variant="ghost" size="sm" className="-ml-2 mb-1" asChild>
          <Link href="/shops">
            <ArrowLeft className="size-4" /> Shops &amp; Employees
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">
          {shop.name} — Stock
        </h1>
        <p className="text-sm text-muted-foreground">
          {shop.location ? `${shop.location} · ` : ""}Read-only — exactly what
          this shop&apos;s employees see. Move stock from Deliveries &amp;
          Returns.
        </p>
      </div>

      <Suspense fallback={<TableSkeleton cols={5} toolbar={false} />}>
        <ShopStockBody shopId={id} />
      </Suspense>
    </div>
  );
}

async function ShopStockBody({ shopId }: { shopId: string }) {
  const supabase = await createClient();
  // Employee-safe views return every shop for the owner, so scope to this one
  // FIRST: part_id repeats across shops and keyset paging would drop rows.
  const [stock, engines] = await Promise.all([
    fetchAll<ShopStockRow>(
      () => supabase.from("shop_stock").select("*").eq("shop_id", shopId),
      "part_id"
    ),
    fetchAll<ShopEngineRow>(
      () => supabase.from("shop_engines").select("*").eq("shop_id", shopId),
      "engine_id"
    ),
  ]);

  return (
    <ShopStockReadonly
      stock={stock.sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))}
      engines={engines.sort((a, b) =>
        (a.serial_number ?? "").localeCompare(b.serial_number ?? "")
      )}
    />
  );
}
