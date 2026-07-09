import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { Button } from "@/components/ui/button";
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

  // the same employee-safe views — for the owner they return every shop,
  // so filter to this one
  const [stockRes, enginesRes] = await Promise.all([
    supabase.from("shop_stock").select("*").eq("shop_id", id).order("name"),
    supabase
      .from("shop_engines")
      .select("*")
      .eq("shop_id", id)
      .order("serial_number"),
  ]);

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

      <ShopStockReadonly
        stock={(stockRes.data ?? []) as ShopStockRow[]}
        engines={(enginesRes.data ?? []) as ShopEngineRow[]}
      />
    </div>
  );
}
