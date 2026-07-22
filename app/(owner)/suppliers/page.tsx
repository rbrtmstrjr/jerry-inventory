import type { Metadata } from "next";

import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import type { ReceivingBalanceRow, ReceivingRow, SupplierPayableRow } from "@/lib/db-types";
import { SupplierTabs } from "./supplier-tabs";
import { SuppliersTable } from "./suppliers-table";
import { PayablesView, type PaymentHistoryRow } from "./payables-view";
import { ComparisonView } from "./comparison-view";
import {
  ReceivingView,
  type PriceHistoryRow,
  type SupplierOption,
} from "./receiving-view";
import type { ComparisonRow } from "./types";

export const metadata: Metadata = { title: "Suppliers" };

/**
 * Suppliers, consolidated. Stock starts at a supplier, so everything about them
 * lives in one place: who they are (Directory), what we owe them (Payables),
 * and who's cheapest (Price Comparison).
 *
 * Directory and Payables moved here UNCHANGED from /master-inventory/suppliers
 * and /suppliers/payables — same components, same actions, same behavior; only
 * the address moved (both old routes redirect). Comparison is new.
 */
export default async function SuppliersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; view?: string }>;
}) {
  const { tab: rawTab, view } = await searchParams;
  const tab =
    rawTab === "payables"
      ? "payables"
      : rawTab === "comparison"
        ? "comparison"
        : rawTab === "receiving"
          ? "receiving"
          : "directory";
  const supabase = await createClient();

  const heading = (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
      <p className="text-sm text-muted-foreground">
        Where stock starts: the people you buy from, what you owe them, and who
        gives the best price.
      </p>
    </div>
  );

  // Receiving — moved here UNCHANGED from /master-inventory/receiving (which
  // 307-redirects): receiving is a supplier transaction. Same view, same
  // fn_receive_stock flow, same ?view=<id> detail deep-link.
  if (tab === "receiving") {
    const [receivingsRes, suppliersRes, partsRes, modelsRes, categoriesRes, historyRes] =
      await Promise.all([
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
        supabase
          .from("product_categories")
          .select("id, name")
          .is("deleted_at", null)
          .order("name"),
        // Last price PAID per supplier × product — shown as context on each
        // line so a moved price is visible before it's accepted.
        supabase
          .from("supplier_product_prices_history")
          .select(
            "supplier_id, supplier_name, part_id, engine_model_id, unit_cost_centavos, received_at"
          ),
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
      <div className="flex flex-col gap-4">
        {heading}
        <SupplierTabs active="receiving" />
        <ReceivingView
          receivings={receivings}
          suppliers={(suppliersRes.data ?? []) as SupplierOption[]}
          parts={partsRes.data ?? []}
          models={modelsRes.data ?? []}
          categories={categoriesRes.data ?? []}
          history={(historyRes.data ?? []) as PriceHistoryRow[]}
          initialViewId={view ?? null}
        />
      </div>
    );
  }

  if (tab === "payables") {
    const [payRes, balRes, histRes] = await Promise.all([
      supabase.from("supplier_payables").select("*").order("outstanding", { ascending: false }),
      supabase
        .from("receiving_balances")
        .select("*")
        .not("supplier_id", "is", null)
        .order("received_at", { ascending: true }),
      supabase
        .from("supplier_payments")
        .select(
          "id, payment_group_id, supplier_id, receiving_id, amount, paid_at, method, reference_no, note, receipt_image_path, created_at"
        )
        .is("deleted_at", null)
        .order("paid_at", { ascending: false })
        .limit(500),
    ]);

    return (
      <div className="flex flex-col gap-4">
        {heading}
        <SupplierTabs active="payables" />
        <PayablesView
          suppliers={(payRes.data ?? []) as SupplierPayableRow[]}
          balances={(balRes.data ?? []) as ReceivingBalanceRow[]}
          payments={(histRes.data ?? []) as PaymentHistoryRow[]}
          today={ph_today()}
        />
      </div>
    );
  }

  if (tab === "comparison") {
    const [cmpRes, partsRes, modelsRes, catRes] = await Promise.all([
      supabase.from("supplier_price_comparison").select("*"),
      supabase
        .from("parts")
        .select("id, name, sku, unit, created_at, stock_levels(shop_id, qty)")
        .is("deleted_at", null)
        .order("name"),
      supabase.from("engine_models").select("id, brand, model, created_at").order("brand"),
      supabase.from("product_categories").select("id, name").order("name"),
    ]);

    // product_id → catalog creation timestamp, so the comparison can float the
    // most recently added product to the top (finer than the date-level price).
    const createdAtByProduct: Record<string, string> = {};
    for (const p of partsRes.data ?? []) createdAtByProduct[p.id] = p.created_at;
    for (const m of modelsRes.data ?? []) createdAtByProduct[m.id] = m.created_at;

    return (
      <div className="flex flex-col gap-4">
        {heading}
        <SupplierTabs active="comparison" />
        <ComparisonView
          rows={(cmpRes.data ?? []) as ComparisonRow[]}
          createdAtByProduct={createdAtByProduct}
          parts={(partsRes.data ?? []).map((p) => ({
            id: p.id,
            name: p.name,
            sku: p.sku,
            unit: p.unit,
            // total on-hand across ALL locations — a merge blocks on any stock
            stock_qty: (p.stock_levels ?? []).reduce((sum, s) => sum + s.qty, 0),
          }))}
          categories={(catRes.data ?? []).map((c) => c.name)}
        />
      </div>
    );
  }

  // Directory — verbatim the old /master-inventory/suppliers page body.
  const [supRes, payRes] = await Promise.all([
    supabase
      .from("suppliers")
      .select("id, name, contact, notes, credit_limit, payment_terms_days, terms_note")
      .is("deleted_at", null)
      .order("name"),
    // what each supplier is currently owed, to show inline on the row
    supabase.from("supplier_payables").select("supplier_id, outstanding, utilization_pct"),
  ]);

  const owed = new Map(
    (payRes.data ?? []).map((p) => [
      p.supplier_id as string,
      {
        outstanding: (p.outstanding as number) ?? 0,
        utilization_pct: p.utilization_pct as number | null,
      },
    ])
  );
  const suppliers = (supRes.data ?? []).map((s) => ({
    ...s,
    outstanding: owed.get(s.id)?.outstanding ?? 0,
    utilization_pct: owed.get(s.id)?.utilization_pct ?? null,
  }));

  return (
    <div className="flex flex-col gap-4">
      {heading}
      <SupplierTabs active="directory" />
      <SuppliersTable suppliers={suppliers} />
    </div>
  );
}
