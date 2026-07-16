import type { Metadata } from "next";

import { createClient } from "@/lib/supabase/server";
import { ph_today } from "@/lib/ph-date";
import type { ReceivingBalanceRow, SupplierPayableRow } from "@/lib/db-types";
import { SupplierTabs } from "./supplier-tabs";
import { SuppliersTable } from "./suppliers-table";
import { PayablesView, type PaymentHistoryRow } from "./payables-view";
import { ComparisonView } from "./comparison-view";
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
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab: rawTab } = await searchParams;
  const tab =
    rawTab === "payables" ? "payables" : rawTab === "comparison" ? "comparison" : "directory";
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
    const [cmpRes, supRes, partsRes, modelsRes, catRes] = await Promise.all([
      supabase.from("supplier_price_comparison").select("*"),
      supabase.from("suppliers").select("id, name").is("deleted_at", null).order("name"),
      supabase.from("parts").select("id, name, sku").is("deleted_at", null).order("name"),
      supabase.from("engine_models").select("id, brand, model").order("brand"),
      supabase.from("product_categories").select("id, name").order("name"),
    ]);

    return (
      <div className="flex flex-col gap-4">
        {heading}
        <SupplierTabs active="comparison" />
        <ComparisonView
          rows={(cmpRes.data ?? []) as ComparisonRow[]}
          suppliers={supRes.data ?? []}
          parts={partsRes.data ?? []}
          engineModels={(modelsRes.data ?? []).map((m) => ({
            id: m.id,
            name: `${m.brand} ${m.model}`,
          }))}
          categories={(catRes.data ?? []).map((c) => c.name)}
          today={ph_today()}
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
