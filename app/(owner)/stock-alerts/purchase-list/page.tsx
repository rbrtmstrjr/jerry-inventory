import type { Metadata } from "next";
import { Anchor, ShoppingBag } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { formatCentavos } from "@/lib/format";
import type { MasterLowStockRow } from "@/lib/db-types";
import { ph_today } from "@/lib/ph-date";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Purchase List" };

/**
 * Standalone print document: what master needs to BUY, grouped by supplier —
 * one block Admin can hand to / order from each supplier.
 * Suggested order qty = shortfall + a small buffer so they aren't reordering the
 * same item next week.
 */
const BUFFER = 2;

export default async function PurchaseListPage() {
  const supabase = await createClient();

  const [lowRes, cmpRes, business] = await Promise.all([
    supabase.from("master_low_stock").select("*"),
    // Cheapest known source per product, with provenance. SUGGESTION ONLY: the
    // list stays grouped by the supplier Jerry will actually order from —
    // supplier choice rides on relationships, terms, credit and lead time the
    // system doesn't know. It says; he decides.
    supabase
      .from("supplier_price_comparison")
      .select(
        "part_id, engine_model_id, supplier_id, supplier_name, effective_centavos, effective_source, effective_as_of, is_cheapest"
      )
      .eq("is_cheapest", true),
    getBusinessIdentity(supabase),
  ]);

  const rows = (lowRes.data ?? []) as MasterLowStockRow[];

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const cheapestByProduct = new Map<string, any>();
  for (const c of cmpRes.data ?? []) {
    cheapestByProduct.set((c as any).part_id ?? (c as any).engine_model_id, c);
  }
  const suggestionLabel = (c: any): string => {
    const price = formatCentavos(c.effective_centavos);
    const when = new Date(`${String(c.effective_as_of).slice(0, 10)}T00:00:00Z`)
      .toLocaleDateString("en-PH", { timeZone: "UTC", month: "short", day: "numeric" });
    const verb = c.effective_source === "paid" ? "Paid" : "Quoted";
    const stale = c.effective_source === "stale_quote" ? " (stale)" : "";
    return `${verb} ${price} · ${when}${stale}`;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // group by supplier; unassigned items land in their own block
  const groups = new Map<
    string,
    { name: string; contact: string | null; items: MasterLowStockRow[] }
  >();
  for (const r of rows) {
    const key = r.supplier_id ?? "__none__";
    const g = groups.get(key) ?? {
      name: r.supplier_name ?? "No supplier set",
      contact: r.supplier_contact ?? null,
      items: [],
    };
    g.items.push(r);
    groups.set(key, g);
  }
  const blocks = [...groups.entries()].sort((a, b) =>
    a[0] === "__none__" ? 1 : b[0] === "__none__" ? -1 : a[1].name.localeCompare(b[1].name)
  );

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print purchase list" />
      </div>

      <div className="rounded-lg border bg-card p-8 text-card-foreground print:rounded-none print:border-0 print:p-0">
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground print:border print:bg-transparent print:text-foreground">
              <Anchor className="size-5" />
            </div>
            <div>
              <div className="text-lg font-bold">{business.business_name}</div>
              {business.address && (
                <div className="text-xs text-muted-foreground">{business.address}</div>
              )}
              {business.phone && (
                <div className="text-xs text-muted-foreground">{business.phone}</div>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="flex items-center justify-end gap-1 text-lg font-bold">
              <ShoppingBag className="size-5" /> PURCHASE LIST
            </div>
            <div className="text-sm text-muted-foreground">{ph_today()}</div>
          </div>
        </div>

        {rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">
            Nothing to order — master stock is above every reorder level.
          </p>
        ) : (
          blocks.map(([key, g]) => (
            <section key={key} className="break-inside-avoid border-b py-4 last:border-b-0">
              {/* Supplier header */}
              <div className="mb-2 flex items-baseline justify-between gap-4">
                <div>
                  <div className="text-base font-bold">{g.name}</div>
                  {g.contact && (
                    <div className="text-xs text-muted-foreground">{g.contact}</div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {g.items.length} item{g.items.length === 1 ? "" : "s"}
                </div>
              </div>

              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-1 font-medium">Product</th>
                    <th className="py-1 text-right font-medium">On hand</th>
                    <th className="py-1 text-right font-medium">Reorder at</th>
                    <th className="py-1 text-right font-medium">Order qty</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((i) => {
                    const cheapest = cheapestByProduct.get(i.product_id);
                    const elsewhere =
                      cheapest && cheapest.supplier_id !== i.supplier_id;
                    return (
                    <tr key={`${i.kind}-${i.product_id}`} className="border-b last:border-b-0">
                      <td className="py-1.5">
                        {i.name}
                        {i.kind === "engine_model" && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            (engine)
                          </span>
                        )}
                        {i.sku && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            {i.sku}
                          </span>
                        )}
                        {/* Suggestion, never a reassignment: the row stays in
                            the block Jerry will actually order from. */}
                        {cheapest && (
                          <div className={`text-[10px] ${elsewhere ? "font-medium" : "text-muted-foreground"}`}>
                            {elsewhere
                              ? `Cheapest: ${cheapest.supplier_name} — ${suggestionLabel(cheapest)}`
                              : `Best known price here — ${suggestionLabel(cheapest)}`}
                          </div>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {i.on_hand} {i.unit}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-muted-foreground">
                        {i.threshold}
                      </td>
                      <td className="py-1.5 text-right text-base font-bold tabular-nums">
                        {i.shortfall + BUFFER}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </section>
          ))
        )}

        {/* Notes + sign-off */}
        {rows.length > 0 && (
          <>
            <div className="mt-6">
              <div className="text-xs uppercase text-muted-foreground">Notes</div>
              <div className="mt-1 h-16 rounded-md border border-dashed" />
            </div>
            <div className="mt-8 grid grid-cols-2 gap-12 text-sm">
              <div className="border-t pt-2 text-center text-muted-foreground">
                Ordered by
              </div>
              <div className="border-t pt-2 text-center text-muted-foreground">
                Received by
              </div>
            </div>
            <p className="mt-4 text-center text-[10px] text-muted-foreground">
              Order qty = shortfall + {BUFFER} buffer. Quantities are a
              suggestion — adjust before ordering.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
