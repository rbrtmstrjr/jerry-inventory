import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { DeliveriesView } from "./deliveries-view";

export const metadata: Metadata = { title: "Deliveries & Returns" };

export interface TransferHistoryRow {
  id: string;
  at: string;
  shop_name: string;
  note: string | null;
  part_lines: number;
  engine_lines: number;
  total_qty: number;
  kind: "delivery" | "return";
}

export interface MasterPartOption {
  part_id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
  master_qty: number;
}

export interface ShopPartStock {
  part_id: string;
  shop_id: string;
  name: string;
  unit: string;
  qty: number;
}

export interface EngineOption {
  id: string;
  serial_number: string;
  label: string;
  shop_id: string | null; // null = in master
}

export default async function DeliveriesPage() {
  const supabase = await createClient();

  const [shopsRes, masterStockRes, shopStockRes, enginesRes, deliveriesRes, returnsRes] =
    await Promise.all([
      supabase
        .from("shops")
        .select("id, name")
        .eq("active", true)
        .is("deleted_at", null)
        .order("name"),
      supabase
        .from("stock_levels")
        .select("part_id, qty, parts!inner(name, sku, barcode, unit, deleted_at)")
        .is("shop_id", null)
        .gt("qty", 0),
      supabase
        .from("stock_levels")
        .select("part_id, shop_id, qty, parts!inner(name, unit, deleted_at)")
        .not("shop_id", "is", null)
        .gt("qty", 0),
      supabase
        .from("engines")
        .select("id, serial_number, status, shop_id, engine_models(brand, model, horsepower)")
        .in("status", ["in_master", "delivered"])
        .is("deleted_at", null)
        .order("serial_number"),
      supabase
        .from("deliveries")
        .select("id, delivered_at, note, shops(name), delivery_lines(part_id, engine_id, qty)")
        .is("deleted_at", null)
        .order("delivered_at", { ascending: false })
        .limit(100),
      supabase
        .from("returns")
        .select("id, returned_at, reason, shops(name), return_lines(part_id, engine_id, qty)")
        .is("deleted_at", null)
        .order("returned_at", { ascending: false })
        .limit(100),
    ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const masterParts: MasterPartOption[] = (masterStockRes.data ?? [])
    .filter((s: any) => !s.parts.deleted_at)
    .map((s: any) => ({
      part_id: s.part_id,
      name: s.parts.name,
      sku: s.parts.sku,
      barcode: s.parts.barcode,
      unit: s.parts.unit,
      master_qty: s.qty,
    }))
    .sort((a: MasterPartOption, b: MasterPartOption) => a.name.localeCompare(b.name));

  const shopParts: ShopPartStock[] = (shopStockRes.data ?? [])
    .filter((s: any) => !s.parts.deleted_at)
    .map((s: any) => ({
      part_id: s.part_id,
      shop_id: s.shop_id,
      name: s.parts.name,
      unit: s.parts.unit,
      qty: s.qty,
    }))
    .sort((a: ShopPartStock, b: ShopPartStock) => a.name.localeCompare(b.name));

  const engines: EngineOption[] = (enginesRes.data ?? []).map((e: any) => ({
    id: e.id,
    serial_number: e.serial_number,
    label: `${e.serial_number} — ${e.engine_models?.brand ?? ""} ${e.engine_models?.model ?? ""}${
      e.engine_models?.horsepower != null ? ` ${e.engine_models.horsepower}HP` : ""
    }`,
    shop_id: e.status === "in_master" ? null : e.shop_id,
  }));

  const history: TransferHistoryRow[] = [
    ...(deliveriesRes.data ?? []).map((d: any) => ({
      id: d.id,
      at: d.delivered_at,
      shop_name: d.shops?.name ?? "?",
      note: d.note,
      part_lines: (d.delivery_lines ?? []).filter((l: any) => l.part_id).length,
      engine_lines: (d.delivery_lines ?? []).filter((l: any) => l.engine_id).length,
      total_qty: (d.delivery_lines ?? []).reduce((s: number, l: any) => s + l.qty, 0),
      kind: "delivery" as const,
    })),
    ...(returnsRes.data ?? []).map((r: any) => ({
      id: r.id,
      at: r.returned_at,
      shop_name: r.shops?.name ?? "?",
      note: r.reason,
      part_lines: (r.return_lines ?? []).filter((l: any) => l.part_id).length,
      engine_lines: (r.return_lines ?? []).filter((l: any) => l.engine_id).length,
      total_qty: (r.return_lines ?? []).reduce((s: number, l: any) => s + l.qty, 0),
      kind: "return" as const,
    })),
  ];
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <DeliveriesView
      shops={shopsRes.data ?? []}
      masterParts={masterParts}
      shopParts={shopParts}
      engines={engines}
      history={history}
    />
  );
}
