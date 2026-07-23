import type { Metadata } from "next";
import { Suspense } from "react";

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
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";

export const metadata: Metadata = { title: "Suppliers" };

/**
 * Walk every row of a comparison VIEW. These are keyed by (supplier × product),
 * with no single column to keyset on, so this uses offset paging — safe because
 * the builder carries a deterministic .order() (else pages could overlap) and
 * the views are bounded by catalog×suppliers (thousands, not transactions), so
 * a handful of pages covers them. Without this the page silently capped at the
 * PostgREST 1,000-row limit — the comparison was showing < half its rows.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
async function fetchAllPaged(build: () => any): Promise<any[]> {
  const out: any[] = [];
  for (let off = 0; ; off += 1000) {
    const { data, error } = await build().range(off, off + 999);
    if (error) throw new Error(`Suppliers query failed: ${error.message}`);
    out.push(...(data ?? []));
    if ((data ?? []).length < 1000) return out;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Suppliers, consolidated: who they are (Directory), what we owe (Payables),
 * who's cheapest (Price Comparison), and stock intake (Receiving).
 *
 * STREAMS like Reports: the heading + tabs paint instantly; the selected tab's
 * body (which does the fetching) streams in behind a skeleton, so the page is
 * never blocked on it. The Comparison tab additionally reveals its (server-
 * rendered) product cards in scroll batches, so a 500-product list doesn't paint
 * all at once — SSR'd first batch, lazy the rest.
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

  return (
    <div className="flex flex-col gap-4">
      <Heading />
      <SupplierTabs active={tab} />
      <Suspense key={`${tab}:${view ?? ""}`} fallback={<TabSkeleton tab={tab} />}>
        {tab === "receiving" ? (
          <ReceivingTab view={view ?? null} />
        ) : tab === "payables" ? (
          <PayablesTab />
        ) : tab === "comparison" ? (
          <ComparisonTab />
        ) : (
          <DirectoryTab />
        )}
      </Suspense>
    </div>
  );
}

function Heading() {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Suppliers</h1>
      <p className="text-sm text-muted-foreground">
        Where stock starts: the people you buy from, what you owe them, and who
        gives the best price.
      </p>
    </div>
  );
}

// ── Receiving — the single stock entry point ────────────────────────────────
async function ReceivingTab({ view }: { view: string | null }) {
  const supabase = await createClient();
  const [receivingsRes, suppliersRes, partsRes, modelsRes, categoriesRes, historyRes] =
    await Promise.all([
      supabase
        .from("receivings")
        .select("id, received_at, note, suppliers(name), receiving_lines(part_id, engine_id, qty)")
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
      supabase.from("product_categories").select("id, name").is("deleted_at", null).order("name"),
      // Last price PAID per supplier × product. Paginated — 2k+ rows > 1,000 cap.
      fetchAllPaged(() =>
        supabase
          .from("supplier_product_prices_history")
          .select("supplier_id, supplier_name, part_id, engine_model_id, unit_cost_centavos, received_at")
          .order("supplier_id")
          .order("part_id", { nullsFirst: false })
          .order("engine_model_id", { nullsFirst: false })
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
    <ReceivingView
      receivings={receivings}
      suppliers={(suppliersRes.data ?? []) as SupplierOption[]}
      parts={partsRes.data ?? []}
      models={modelsRes.data ?? []}
      categories={categoriesRes.data ?? []}
      history={historyRes as PriceHistoryRow[]}
      initialViewId={view}
    />
  );
}

// ── Payables — what we owe suppliers ────────────────────────────────────────
async function PayablesTab() {
  const supabase = await createClient();
  const [payRes, balRes, histRes] = await Promise.all([
    supabase.from("supplier_payables").select("*").order("outstanding", { ascending: false }),
    supabase
      .from("receiving_balances")
      .select("*")
      .not("supplier_id", "is", null)
      .order("received_at", { ascending: true }),
    supabase
      .from("supplier_payments")
      .select("id, payment_group_id, supplier_id, receiving_id, amount, paid_at, method, reference_no, note, receipt_image_path, created_at")
      .is("deleted_at", null)
      .order("paid_at", { ascending: false })
      .limit(500),
  ]);

  return (
    <PayablesView
      suppliers={(payRes.data ?? []) as SupplierPayableRow[]}
      balances={(balRes.data ?? []) as ReceivingBalanceRow[]}
      payments={(histRes.data ?? []) as PaymentHistoryRow[]}
      today={ph_today()}
    />
  );
}

// ── Price Comparison ────────────────────────────────────────────────────────
async function ComparisonTab() {
  const supabase = await createClient();
  const [allCmp, partsRes, modelsRes, catRes] = await Promise.all([
    // Paginated (stable order) — 2k+ comparison rows outgrow the 1,000 cap.
    fetchAllPaged(() =>
      supabase
        .from("supplier_price_comparison")
        .select("*")
        .order("supplier_id")
        .order("part_id", { nullsFirst: false })
        .order("engine_model_id", { nullsFirst: false })
    ),
    supabase
      .from("parts")
      .select("id, name, sku, unit, created_at, stock_levels(shop_id, qty)")
      .is("deleted_at", null)
      .order("name"),
    supabase.from("engine_models").select("id, brand, model, created_at").order("brand"),
    supabase.from("product_categories").select("id, name").order("name"),
  ]);

  const createdAtByProduct: Record<string, string> = {};
  for (const p of partsRes.data ?? []) createdAtByProduct[p.id] = p.created_at;
  for (const m of modelsRes.data ?? []) createdAtByProduct[m.id] = m.created_at;

  return (
    <ComparisonView
      rows={allCmp as ComparisonRow[]}
      createdAtByProduct={createdAtByProduct}
      parts={(partsRes.data ?? []).map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        unit: p.unit,
        stock_qty: (p.stock_levels ?? []).reduce((sum, s) => sum + s.qty, 0),
      }))}
      categories={(catRes.data ?? []).map((c) => c.name)}
    />
  );
}

// ── Directory ───────────────────────────────────────────────────────────────
async function DirectoryTab() {
  const supabase = await createClient();
  const [supRes, payRes] = await Promise.all([
    supabase
      .from("suppliers")
      .select("id, name, contact, notes, credit_limit, payment_terms_days, terms_note")
      .is("deleted_at", null)
      .order("name"),
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

  return <SuppliersTable suppliers={suppliers} />;
}

// ── streaming skeletons — each mirrors its tab's real layout ────────────────
function TabSkeleton({ tab }: { tab: string }) {
  if (tab === "payables") return <PayablesSkeleton />;
  if (tab === "comparison") return <ComparisonSkeleton />;
  if (tab === "receiving") return <ReceivingSkeleton />;
  return <DirectorySkeleton />;
}

/** A generic data-table placeholder: header row + body rows. */
function TableSkeleton({ rows = 8, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-xl border">
      <div className="flex gap-4 border-b bg-muted/30 px-4 py-3">
        {Array.from({ length: cols }).map((_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 border-b px-4 py-3.5 last:border-0">
          {Array.from({ length: cols }).map((_, i) => (
            <Skeleton key={i} className="h-4 flex-1" />
          ))}
        </div>
      ))}
    </div>
  );
}

// Directory: a searchable supplier table.
function DirectorySkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-9 w-28" />
      </div>
      <TableSkeleton rows={8} cols={5} />
    </div>
  );
}

// Payables: COGS note · 3 summary cards · toolbar · balances table.
function PayablesSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-10 w-full rounded-lg" />
      <div className="grid gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex flex-col gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-8 w-40" />
              <Skeleton className="h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-24" />
      </div>
      <Skeleton className="h-9 w-64" />
      <TableSkeleton rows={6} cols={7} />
    </div>
  );
}

// Price Comparison: filter bar · product comparison cards.
function ComparisonSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-x-6 gap-y-3">
          {[52, 40, 36].map((w, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-9" style={{ width: `${w * 4}px` }} />
            </div>
          ))}
          <Skeleton className="h-5 w-40" />
        </CardContent>
      </Card>
      {Array.from({ length: 5 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="flex flex-col gap-3">
            <Skeleton className="h-5 w-56" />
            {Array.from({ length: 2 }).map((_, j) => (
              <div key={j} className="flex items-center justify-between">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-4 w-24" />
              </div>
            ))}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// Receiving: a search bar + "New Receiving" button, then the receivings table.
// (The intake form lives behind the button in a dialog — not shown inline.)
function ReceivingSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-9 w-40" />
      </div>
      <TableSkeleton rows={11} cols={6} />
    </div>
  );
}
