import type { Metadata } from "next";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { classifyRequestLines, type ClassifiedRequest } from "@/lib/request-fulfillment";
import { DeliveriesView } from "./deliveries-view";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = { title: "Deliveries & Returns" };

export interface TransferHistoryRow {
  id: string;
  at: string;
  shop_name: string;
  shop_color_key: string | null;
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
  shop_color_key: string | null;
  delivered_at: string;
  status: string;
  name: string;
  unit: string;
  is_engine: boolean;
  qty_sent: number;
  qty_received: number | null;
  qty_outstanding: number;
  shop_note: string | null;
  // how much of the outstanding the shop flagged DAMAGED (rest = missing),
  // + a signed URL to the shop's damage photo (private receipts bucket).
  qty_damaged: number;
  damage_photo_url: string | null;
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

/** One line of a shop-to-shop transfer. */
export interface TransferLineRow {
  /** delivery_line_id — the target for resolveDeliveryDiscrepancy */
  id: string;
  is_engine: boolean;
  name: string;
  sku: string | null;
  unit: string;
  serial_number: string | null;
  qty: number;
  qty_received: number | null;
  qty_outstanding: number;
}

/** A shop-to-shop transfer awaiting owner review, confirmation, or resolution. */
export interface TransferRow {
  id: string;
  status: "requested" | "in_transit" | "discrepancy";
  requested_at: string;
  approved_at: string | null;
  note: string | null;
  review_note: string | null;
  from_shop_name: string;
  from_shop_color_key: string | null;
  to_shop_name: string;
  to_shop_color_key: string | null;
  requested_by: string | null;
  lines: TransferLineRow[];
}

/**
 * Pre-fill for "Convert to delivery" coming from a shop's delivery request.
 * Every requested line is carried and classified into available (deliverable,
 * capped to master) vs no-stock (shown disabled) — see classifyRequestLines.
 */
export type DeliveryPrefill = {
  requestId: string;
  shopId: string;
  note: string;
  /** free-text products the shop requested that aren't in the catalog (0077) —
   *  informational: the owner creates them via Receiving, then delivers. */
  customItems: { name: string; qty_requested: number }[];
} & ClassifiedRequest;

/**
 * Deliveries streams: the heading paints instantly and the body (tab bar +
 * content) loads behind a matching skeleton — only the data area shows a
 * skeleton, not the whole page.
 */
export default function DeliveriesPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; tab?: string }>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Deliveries &amp; Returns
        </h1>
        <p className="text-sm text-muted-foreground">
          Move stock between master and shops. Stock leaves master into transit
          and lands only once the shop confirms what actually arrived.
        </p>
      </div>
      <Suspense fallback={<DeliveriesBodySkeleton />}>
        <DeliveriesBody searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function DeliveriesBody({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; tab?: string }>;
}) {
  const { request: requestId, tab } = await searchParams;
  const supabase = await createClient();

  const [
    shopsRes,
    masterStockRes,
    enginesRes,
    deliveriesRes,
    returnsRes,
    transitRes,
    transfersRes,
    pendingReturnsRes,
  ] = await Promise.all([
      supabase
        .from("shops")
        .select("id, name, color_key")
        .eq("active", true)
        .is("deleted_at", null)
        .order("name"),
      supabase
        .from("stock_levels")
        .select("part_id, qty, parts!inner(name, sku, barcode, unit, deleted_at)")
        .is("shop_id", null)
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
          "id, delivered_at, note, status, shops!deliveries_shop_id_fkey(name, color_key), delivery_lines(part_id, engine_id, qty, qty_outstanding)"
        )
        // master→shop deliveries only — shop→shop transfers (from_shop_id set)
        // live in the Transfers tab and carry statuses this History can't render
        .is("from_shop_id", null)
        .is("deleted_at", null)
        .order("delivered_at", { ascending: false })
        .limit(100),
      supabase
        .from("returns")
        .select("id, returned_at, reason, shops(name, color_key), return_lines(part_id, engine_id, qty)")
        .eq("status", "approved")
        .is("deleted_at", null)
        .order("returned_at", { ascending: false })
        .limit(100),
      supabase
        .from("stock_in_transit")
        .select("*")
        .order("delivered_at", { ascending: true }),
      supabase
        .from("deliveries")
        .select(
          `id, created_at, approved_at, status, note, review_note,
           to_shop:shops!deliveries_shop_id_fkey(name, color_key),
           from_shop:shops!deliveries_from_shop_id_fkey(name, color_key),
           requester:profiles!deliveries_requested_by_fkey(full_name),
           delivery_lines(id, part_id, engine_id, qty, qty_received, qty_outstanding,
             parts(name, sku, unit),
             engines(serial_number, engine_models(brand, model)))`
        )
        .not("from_shop_id", "is", null)
        .in("status", ["requested", "in_transit", "discrepancy"])
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(100),
      // shop-requested returns awaiting approval (0065)
      supabase
        .from("returns")
        .select(
          `id, created_at, reason,
           shops(name, color_key),
           requester:profiles!returns_requested_by_fkey(full_name),
           return_lines(id, part_id, engine_id, qty, qty_damaged,
             parts(name, unit),
             engines(serial_number, engine_models(brand, model)))`
        )
        .eq("status", "requested")
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
        // parts(name, sku, unit) so an out-of-stock requested part still shows
        // its name in the disabled "No master stock" block.
        "id, shop_id, status, note, delivery_request_lines(part_id, engine_model_id, custom_name, qty_requested, parts(name, sku, unit), engine_models(brand, model))"
      )
      .eq("id", requestId)
      .is("deleted_at", null)
      .maybeSingle();

    if (req && (req as any).status === "open") {
      const r = req as any;
      const inMaster = (enginesRes.data ?? [])
        .filter((e: any) => e.status === "in_master")
        .map((e: any) => ({ id: e.id, engine_model_id: e.engine_model_id }));

      const classified = classifyRequestLines(
        (r.delivery_request_lines ?? []).map((l: any) => ({
          part_id: l.part_id,
          engine_model_id: l.engine_model_id,
          qty_requested: l.qty_requested,
          part_name: l.parts?.name ?? null,
          part_sku: l.parts?.sku ?? null,
          model_name: l.engine_models
            ? `${l.engine_models.brand ?? ""} ${l.engine_models.model ?? ""}`.trim()
            : null,
        })),
        masterParts.map((m) => ({ part_id: m.part_id, master_qty: m.master_qty })),
        inMaster
      );

      const customItems = (r.delivery_request_lines ?? [])
        .filter((l: any) => !l.part_id && !l.engine_model_id && l.custom_name)
        .map((l: any) => ({ name: l.custom_name as string, qty_requested: l.qty_requested }));

      prefill = {
        requestId: r.id,
        shopId: r.shop_id,
        note: r.note ? `Request: ${r.note}` : "From delivery request",
        customItems,
        ...classified,
      };
    }
  }

  const history: TransferHistoryRow[] = [
    ...(deliveriesRes.data ?? []).map((d: any) => ({
      id: d.id,
      at: d.delivered_at,
      shop_name: d.shops?.name ?? "?",
      shop_color_key: d.shops?.color_key ?? null,
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
      shop_color_key: r.shops?.color_key ?? null,
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
  const shopColorById = new Map<string, string | null>(
    (shopsRes.data ?? []).map((s: any) => [s.id, s.color_key ?? null])
  );
  const transit: DiscrepancyRow[] = (transitRes.data ?? []).map((t: any) => ({
    delivery_id: t.delivery_id,
    delivery_line_id: t.delivery_line_id,
    shop_name: t.shop_name,
    shop_color_key: shopColorById.get(t.shop_id) ?? null,
    delivered_at: t.delivered_at,
    status: t.delivery_status,
    name: t.name,
    unit: t.unit,
    is_engine: !!t.engine_id,
    qty_sent: t.qty_sent,
    qty_received: t.qty_received,
    qty_outstanding: t.qty,
    shop_note: t.shop_note,
    qty_damaged: 0,
    damage_photo_url: null,
  }));

  // Enrich discrepancy lines with the shop's damaged count + a signed photo URL
  // (owner reads the base table + the private receipts bucket).
  const shortLineIds = transit
    .filter((t) => t.status === "discrepancy")
    .map((t) => t.delivery_line_id);
  if (shortLineIds.length > 0) {
    const { data: dmg } = await supabase
      .from("delivery_lines")
      .select("id, qty_damaged, damage_photo_path")
      .in("id", shortLineIds);
    const byId = new Map((dmg ?? []).map((d: any) => [d.id, d]));
    await Promise.all(
      transit.map(async (t) => {
        const d = byId.get(t.delivery_line_id);
        if (!d) return;
        t.qty_damaged = d.qty_damaged ?? 0;
        if (d.damage_photo_path) {
          const { data: signed } = await supabase.storage
            .from("receipts")
            .createSignedUrl(d.damage_photo_path, 3600);
          t.damage_photo_url = signed?.signedUrl ?? null;
        }
      })
    );
  }

  const transfers: TransferRow[] = (transfersRes.data ?? []).map((d: any) => ({
    id: d.id,
    status: d.status,
    requested_at: d.created_at,
    approved_at: d.approved_at,
    note: d.note,
    review_note: d.review_note,
    from_shop_name: d.from_shop?.name ?? "?",
    from_shop_color_key: d.from_shop?.color_key ?? null,
    to_shop_name: d.to_shop?.name ?? "?",
    to_shop_color_key: d.to_shop?.color_key ?? null,
    requested_by: d.requester?.full_name ?? null,
    lines: (d.delivery_lines ?? []).map((l: any) => ({
      id: l.id,
      is_engine: !!l.engine_id,
      name:
        l.parts?.name ??
        `${l.engines?.engine_models?.brand ?? ""} ${l.engines?.engine_models?.model ?? ""}`.trim(),
      sku: l.parts?.sku ?? null,
      unit: l.parts?.unit ?? "unit",
      serial_number: l.engines?.serial_number ?? null,
      qty: l.qty,
      qty_received: l.qty_received,
      qty_outstanding: l.qty_outstanding ?? 0,
    })),
  }));

  const pendingReturns = (pendingReturnsRes.data ?? []).map((r: any) => ({
    id: r.id,
    shop_name: r.shops?.name ?? "?",
    shop_color_key: r.shops?.color_key ?? null,
    reason: r.reason ?? null,
    requested_by: r.requester?.full_name ?? null,
    created_at: r.created_at,
    lines: (r.return_lines ?? []).map((l: any) => ({
      id: l.id,
      is_engine: !!l.engine_id,
      name:
        l.parts?.name ??
        `${l.engines?.engine_models?.brand ?? ""} ${l.engines?.engine_models?.model ?? ""}`.trim(),
      unit: l.parts?.unit ?? "unit",
      serial_number: l.engines?.serial_number ?? null,
      qty: l.qty,
      qty_damaged: l.qty_damaged ?? 0,
    })),
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <DeliveriesView
      shops={shopsRes.data ?? []}
      masterParts={masterParts}
      engines={engines}
      history={history}
      transit={transit}
      prefill={prefill}
      transfers={transfers}
      returns={pendingReturns}
      initialTab={tab}
    />
  );
}

function DeliveriesBodySkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-24" />
        <Skeleton className="h-9 w-44" />
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}
