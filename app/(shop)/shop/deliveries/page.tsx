import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import {
  ShopDeliveriesView,
  type IncomingDelivery,
  type IncomingLine,
} from "./deliveries-view";

export const metadata: Metadata = { title: "Incoming Deliveries" };

export default async function ShopDeliveriesPage() {
  const supabase = await createClient();

  // Both views are already scoped to the caller's shop and carry no cost.
  const [delRes, lineRes] = await Promise.all([
    supabase
      .from("shop_incoming_deliveries")
      .select("*")
      .order("delivered_at", { ascending: false })
      .limit(50),
    supabase.from("shop_incoming_delivery_lines").select("*"),
  ]);

  const deliveries = (delRes.data ?? []) as IncomingDelivery[];
  const lines = (lineRes.data ?? []) as IncomingLine[];

  return <ShopDeliveriesView deliveries={deliveries} lines={lines} />;
}
