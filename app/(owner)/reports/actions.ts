"use server";

import { createClient } from "@/lib/supabase/server";
import { isPrimaryOwner } from "@/lib/auth";
import { fetchAll } from "@/lib/pnl";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface SalesCsvRow {
  date: string;
  shop: string;
  item: string;
  type: string;
  qty: number;
  line_total_centavos: number;
}

export interface LossesCsvRow {
  date: string;
  shop: string;
  item: string;
  reason: string;
  qty: number;
  value_centavos: number;
}

type ExportResult =
  | { ok: true; salesCsv: SalesCsvRow[]; lossesCsv: LossesCsvRow[] }
  | { ok: false; error: string };

/** On-demand CSV export: fn_sales_report returns aggregates only, so the
 *  per-line fetch happens only when the owner clicks Export. */
export async function exportSalesCsv(
  from: string,
  to: string,
  shop: string
): Promise<ExportResult> {
  if (!(await isPrimaryOwner()))
    return { ok: false, error: "Only the owner can export reports" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    return { ok: false, error: "Invalid date range" };

  const supabase = await createClient();
  const shopFilter = shop && shop !== "all" ? shop : null;

  const buildSales = () => {
    let q = supabase
      .from("sales")
      .select(
        `id, business_date, total_centavos, shops(name),
         sale_lines(description, qty, line_total_centavos, part_id, engine_id)`
      )
      .eq("status", "approved")
      .gte("business_date", from)
      .lte("business_date", to)
      .is("deleted_at", null);
    if (shopFilter) q = q.eq("shop_id", shopFilter);
    return q;
  };

  const buildLosses = () => {
    let q = supabase
      .from("losses")
      .select("id, business_date, reason, qty, value_centavos, description, shops(name)")
      .eq("status", "approved")
      .gte("business_date", from)
      .lte("business_date", to)
      .is("deleted_at", null);
    if (shopFilter) q = q.eq("shop_id", shopFilter);
    return q;
  };

  const [allSales, allLosses] = await Promise.all([
    fetchAll(buildSales),
    fetchAll(buildLosses),
  ]);

  const salesCsv: SalesCsvRow[] = (allSales as any[]).flatMap((s) =>
    (s.sale_lines ?? []).map((l: any) => ({
      date: s.business_date,
      shop: s.shops?.name ?? "?",
      item: l.description ?? "Item",
      type: l.engine_id ? "engine" : "part",
      qty: l.qty,
      line_total_centavos: l.line_total_centavos,
    }))
  );
  const lossesCsv: LossesCsvRow[] = (allLosses as any[]).map((l) => ({
    date: l.business_date,
    shop: l.shops?.name ?? "?",
    item: l.description ?? "Item",
    reason: l.reason,
    qty: l.qty,
    value_centavos: l.value_centavos ?? 0,
  }));

  return { ok: true, salesCsv, lossesCsv };
}
/* eslint-enable @typescript-eslint/no-explicit-any */
