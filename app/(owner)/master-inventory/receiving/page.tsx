import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import type { ReceivingRow } from "@/lib/db-types";
import { ReceivingView } from "./receiving-view";

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
    supabase
      .from("suppliers")
      .select("id, name")
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
      suppliers={suppliersRes.data ?? []}
      parts={partsRes.data ?? []}
      models={modelsRes.data ?? []}
    />
  );
}
