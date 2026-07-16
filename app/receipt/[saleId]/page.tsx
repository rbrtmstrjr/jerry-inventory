import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor, Receipt } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { formatCentavos } from "@/lib/format";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Receipt" };

/* eslint-disable @typescript-eslint/no-explicit-any */
export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ saleId: string }>;
}) {
  const { saleId } = await params;
  const supabase = await createClient();

  // Identity comes from `public_settings`, not `settings`. This page is shared:
  // the SHOP opens it right after recording a sale, and `settings` is
  // owner-only — so it used to render a nameless receipt for the one caller
  // who prints nearly all of them, while the owner's reprint of the same sale
  // looked complete.
  const [saleRes, business] = await Promise.all([
    supabase
      .from("sales")
      .select(
        `id, business_date, total_centavos, payment_type, amount_paid_centavos,
         balance_due_centavos, receipt_no, receipt_generated_at, created_at,
         shops(name, location),
         customers(name, phone, address),
         sale_lines(description, qty, unit_price_centavos, line_total_centavos,
                    agreed_price_centavos, list_reference_centavos, discount_centavos, engine_id)`
      )
      .eq("id", saleId)
      .is("deleted_at", null)
      .single(),
    getBusinessIdentity(supabase),
  ]);

  const s = saleRes.data as any;
  if (!s) notFound();

  const lines = (s.sale_lines ?? []) as any[];
  const isPartial = s.payment_type === "partial";
  const receiptNo = s.receipt_no ?? `OR-${s.id.slice(0, 8).toUpperCase()}`;
  const saleDate = s.receipt_generated_at ?? s.created_at ?? s.business_date;

  return (
    <div className="mx-auto max-w-md p-4">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print receipt" />
      </div>

      <div className="rounded-lg border bg-card p-6 text-card-foreground print:rounded-none print:border-0 print:p-0">
        {/* Header */}
        <div className="flex items-start justify-between border-b pb-3">
          <div className="flex items-center gap-2">
            <div className="flex size-9 items-center justify-center rounded-md bg-primary text-primary-foreground print:border print:bg-transparent print:text-foreground">
              <Anchor className="size-5" />
            </div>
            <div className="leading-tight">
              <div className="font-bold">{business.business_name}</div>
              {business.address && (
                <div className="text-xs text-muted-foreground">
                  {business.address}
                </div>
              )}
              {business.phone && (
                <div className="text-xs text-muted-foreground">
                  {business.phone}
                </div>
              )}
              {business.business_email && (
                <div className="text-xs text-muted-foreground">
                  {business.business_email}
                </div>
              )}
              {business.business_tin && (
                <div className="text-xs text-muted-foreground">
                  TIN: {business.business_tin}
                </div>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="flex items-center justify-end gap-1 text-sm font-bold">
              <Receipt className="size-4" /> RECEIPT
            </div>
            <div className="font-mono text-xs">{receiptNo}</div>
          </div>
        </div>

        {/* Meta */}
        <div className="flex justify-between py-3 text-xs text-muted-foreground">
          <div>
            <div>{format(new Date(saleDate), "MMM d, yyyy · h:mm a")}</div>
            {s.shops?.name && <div>Shop: {s.shops.name}</div>}
          </div>
          {s.customers?.name && (
            <div className="text-right">
              <div className="font-medium text-foreground">
                {s.customers.name}
              </div>
              {s.customers.phone && <div>{s.customers.phone}</div>}
            </div>
          )}
        </div>

        {/* Lines */}
        <div className="border-y py-2">
          {lines.map((l, i) => {
            const discount = l.discount_centavos ?? 0;
            return (
              <div key={i} className="py-1.5 text-sm">
                <div className="flex justify-between gap-2">
                  <span className="min-w-0">
                    {l.description ?? "Item"}
                    {l.qty > 1 && ` × ${l.qty}`}
                  </span>
                  <span className="tabular-nums">
                    {formatCentavos(l.line_total_centavos)}
                  </span>
                </div>
                {l.engine_id && discount > 0 && l.list_reference_centavos != null && (
                  <div className="text-xs text-muted-foreground">
                    Was {formatCentavos(l.list_reference_centavos)} ·{" "}
                    {formatCentavos(discount)} off
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Totals */}
        <div className="flex flex-col gap-1 py-3 text-sm">
          <div className="flex justify-between font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{formatCentavos(s.total_centavos)}</span>
          </div>
          {isPartial ? (
            <>
              <div className="flex justify-between text-muted-foreground">
                <span>Downpayment</span>
                <span className="tabular-nums">
                  {formatCentavos(s.amount_paid_centavos ?? 0)}
                </span>
              </div>
              <div className="flex justify-between font-semibold text-warning-foreground">
                <span>Balance due</span>
                <span className="tabular-nums">
                  {formatCentavos(s.balance_due_centavos ?? 0)}
                </span>
              </div>
            </>
          ) : (
            <div className="flex justify-between text-muted-foreground">
              <span>Paid in full</span>
              <span className="tabular-nums">
                {formatCentavos(s.amount_paid_centavos ?? s.total_centavos)}
              </span>
            </div>
          )}
        </div>

        {/* Payment badge */}
        <div className="border-t pt-3 text-center">
          <span className="inline-block rounded-full border px-3 py-1 text-xs font-medium uppercase tracking-wide">
            {isPartial ? "Partial — balance on pickup" : "Paid in full"}
          </span>
        </div>

        {/* Footer — the owner's line if they've set one, else a sensible default.
            Before 0043 the shop's copy could never show a custom footer at all,
            so this branch only ever ran for the owner. */}
        <div className="mt-4 text-center text-xs text-muted-foreground">
          {business.receipt_footer ? (
            <p>{business.receipt_footer}</p>
          ) : (
            <p>Thank you! Please keep this receipt for warranty & claims.</p>
          )}
        </div>
      </div>
    </div>
  );
}
