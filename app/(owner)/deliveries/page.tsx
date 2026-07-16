import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { DeliveriesView } from "./deliveries-view";
import type { RequestRow } from "./requests-panel";

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
  /** returns have no lifecycle — null for them */
  status: "in_transit" | "confirmed" | "discrepancy" | "resolved" | null;
  qty_outstanding: number;
}

/** A delivery with stock still stuck in transit — Admin's action queue. */
export interface DiscrepancyRow {
  delivery_id: string;
  delivery_line_id: string;
  shop_name: string;
  delivered_at: string;
  status: string;
  name: string;
  unit: string;
  is_engine: boolean;
  qty_sent: number;
  qty_received: number | null;
  qty_outstanding: number;
  shop_note: string | null;
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

/** Pre-fill for "Convert to delivery" coming from a shop's delivery request. */
export interface DeliveryPrefill {
  requestId: string;
  shopId: string;
  note: string;
  partLines: { part_id: string; qty: string }[];
  engineIds: string[];
  /** requested engine units we couldn't auto-pick a serial for */
  unmatchedEngines: { name: string; short: number }[];
}

export default async function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; tab?: string }>;
}) {
  const { request: requestId, tab } = await searchParams;
  const supabase = await createClient();

  const [
    shopsRes,
    masterStockRes,
    shopStockRes,
    enginesRes,
    deliveriesRes,
    returnsRes,
    transitRes,
    requestsRes,
  ] = await Promise.all([
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
        .select(
          "id, serial_number, status, shop_id, engine_model_id, engine_models(brand, model, horsepower)"
        )
        .in("status", ["in_master", "delivered"])
        .is("deleted_at", null)
        .order("serial_number"),
      supabase
        .from("deliveries")
        .select(
          "id, delivered_at, note, status, shops(name), delivery_lines(part_id, engine_id, qty, qty_outstanding)"
        )
        .is("deleted_at", null)
        .order("delivered_at", { ascending: false })
        .limit(100),
      supabase
        .from("returns")
        .select("id, returned_at, reason, shops(name), return_lines(part_id, engine_id, qty)")
        .is("deleted_at", null)
        .order("returned_at", { ascending: false })
        .limit(100),
      supabase
        .from("stock_in_transit")
        .select("*")
        .order("delivered_at", { ascending: true }),
      supabase
        .from("delivery_requests")
        .select(
          `id, shop_id, status, note, owner_note, created_at, fulfilled_at, fulfilled_delivery_id,
           shops(name),
           profiles!delivery_requests_requested_by_fkey(full_name),
           delivery_request_lines(qty_requested, note, parts(name, unit), engine_models(brand, model))`
        )
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
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

  // "Convert to delivery": pre-fill this form from a shop's request. Engines
  // are requested by MODEL but delivered by SERIAL, so pick the first
  // available in-master units of that model — the owner can still change them.
  let prefill: DeliveryPrefill | null = null;
  if (requestId) {
    const { data: req } = await supabase
      .from("delivery_requests")
      .select(
        "id, shop_id, status, note, delivery_request_lines(part_id, engine_model_id, qty_requested, engine_models(brand, model))"
      )
      .eq("id", requestId)
      .is("deleted_at", null)
      .maybeSingle();

    if (req && (req as any).status === "open") {
      const r = req as any;
      const inMaster = (enginesRes.data ?? []).filter(
        (e: any) => e.status === "in_master"
      );
      const taken = new Set<string>();
      const engineIds: string[] = [];
      const unmatchedEngines: { name: string; short: number }[] = [];

      for (const l of r.delivery_request_lines ?? []) {
        if (!l.engine_model_id) continue;
        const pool = inMaster.filter(
          (e: any) => e.engine_model_id === l.engine_model_id && !taken.has(e.id)
        );
        const picked = pool.slice(0, l.qty_requested);
        picked.forEach((e: any) => {
          taken.add(e.id);
          engineIds.push(e.id);
        });
        const short = l.qty_requested - picked.length;
        if (short > 0) {
          unmatchedEngines.push({
            name: `${l.engine_models?.brand ?? ""} ${l.engine_models?.model ?? ""}`.trim(),
            short,
          });
        }
      }

      prefill = {
        requestId: r.id,
        shopId: r.shop_id,
        note: r.note ? `Request: ${r.note}` : "From delivery request",
        partLines: (r.delivery_request_lines ?? [])
          .filter((l: any) => l.part_id)
          .map((l: any) => ({ part_id: l.part_id, qty: String(l.qty_requested) })),
        engineIds,
        unmatchedEngines,
      };
    }
  }

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
      status: d.status ?? null,
      qty_outstanding: (d.delivery_lines ?? []).reduce(
        (s: number, l: any) => s + (l.qty_outstanding ?? 0),
        0
      ),
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
      status: null,
      qty_outstanding: 0,
    })),
  ];

  // Everything currently between master and a shop.
  const transit: DiscrepancyRow[] = (transitRes.data ?? []).map((t: any) => ({
    delivery_id: t.delivery_id,
    delivery_line_id: t.delivery_line_id,
    shop_name: t.shop_name,
    delivered_at: t.delivered_at,
    status: t.delivery_status,
    name: t.name,
    unit: t.unit,
    is_engine: !!t.engine_id,
    qty_sent: t.qty_sent,
    qty_received: t.qty_received,
    qty_outstanding: t.qty,
    shop_note: t.shop_note,
  }));

  const requests: RequestRow[] = (requestsRes.data ?? []).map((r: any) => ({
    id: r.id,
    shop_id: r.shop_id,
    shop_name: r.shops?.name ?? "?",
    employee: r.profiles?.full_name ?? "?",
    status: r.status,
    note: r.note,
    owner_note: r.owner_note,
    created_at: r.created_at,
    fulfilled_at: r.fulfilled_at,
    fulfilled_delivery_id: r.fulfilled_delivery_id,
    items: (r.delivery_request_lines ?? []).map((l: any) => ({
      qty: l.qty_requested,
      note: l.note,
      name:
        l.parts?.name ??
        `${l.engine_models?.brand ?? ""} ${l.engine_models?.model ?? ""}`.trim(),
      unit: l.parts?.unit ?? "unit",
      is_engine: !l.parts,
    })),
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <DeliveriesView
      shops={shopsRes.data ?? []}
      masterParts={masterParts}
      shopParts={shopParts}
      engines={engines}
      history={history}
      transit={transit}
      prefill={prefill}
      requests={requests}
      initialTab={tab}
    />
  );
}
