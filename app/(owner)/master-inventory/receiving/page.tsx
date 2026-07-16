import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { ReceivingRow } from "@/lib/db-types";
import { ReceivingView, type SupplierOption } from "./receiving-view";

export const metadata: Metadata = { title: "Receiving" };

export default async function ReceivingPage() {
  const supabase = await createClient();

  const [receivingsRes, suppliersRes, partsRes, modelsRes] = await Promise.all([
    supabase
      .from("receivings")
      .select(
        "id, received_at, note, suppliers(name), receiving_lines(part_id, engine_id, qty)"
      )
      .is("deleted_at", null)
      .order("received_at", { ascending: false })
      .limit(100),
    // `credit_limit`, not `credit_limit_centavos` — the latter has never
    // existed. PostgREST rejected the whole select, `.data` came back null, and
    // `?? []` below turned that into "this business has no suppliers": the
    // picker was empty, every receiving was logged with no supplier, and no
    // supplier debt was recorded at all. A failed query must never be
    // indistinguishable from an empty one.
    supabase
      .from("suppliers")
      .select("id, name, credit_limit, payment_terms_days, terms_note")
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("parts")
      .select("id, name, sku, barcode, unit, cost_centavos")
      .is("deleted_at", null)
      .order("name"),
    supabase
      .from("engine_models")
      .select("id, brand, model, horsepower, stroke, default_warranty_months")
      .is("deleted_at", null)
      .order("brand"),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const receivings: ReceivingRow[] = (receivingsRes.data ?? []).map((r: any) => ({
    id: r.id,
    received_at: r.received_at,
    note: r.note,
    supplier_name: r.suppliers?.name ?? null,
    part_lines: (r.receiving_lines ?? []).filter((l: any) => l.part_id).length,
    engine_lines: (r.receiving_lines ?? []).filter((l: any) => l.engine_id).length,
    total_qty: (r.receiving_lines ?? []).reduce((s: number, l: any) => s + l.qty, 0),
  }));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <ReceivingView
      receivings={receivings}
      suppliers={(suppliersRes.data ?? []) as SupplierOption[]}
      parts={partsRes.data ?? []}
      models={modelsRes.data ?? []}
    />
  );
}
