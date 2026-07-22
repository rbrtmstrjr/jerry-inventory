import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";

import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { formatCentavos } from "@/lib/format";
import { productImageUrl } from "@/lib/product-image";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Receipt" };

// Route-scoped print CSS — 58mm thermal roll. Rendered ONLY by this page, so
// the @page size cannot leak into the other printables (each is its own route /
// print job). Monochrome (thermal is 1-bit): black on white, no fills, no
// theme tokens. `58mm` here is also the fingerprint the doc HTTP suite asserts.
const THERMAL_CSS = `
/* thermal-receipt-58mm */
@page { size: 58mm auto; margin: 0; }
.thermal-58 {
  width: 58mm;
  box-sizing: border-box;
  padding: 2mm;
  margin: 0 auto;
  background: #fff;
  color: #000;
  font-size: 11px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.thermal-58 .rule { border-top: 1px dashed #000; margin: 6px 0; }
.thermal-58 .row { display: flex; justify-content: space-between; gap: 8px; }
.thermal-58 .sm { font-size: 10px; }
@media screen {
  .thermal-58 { border: 1px solid #ccc; box-shadow: 0 1px 6px rgba(0,0,0,.12); }
}
@media print {
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  .thermal-58 { border: 0; box-shadow: none; }
}
`;

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
        `id, business_date, total_centavos, payment_type, payment_method,
         amount_paid_centavos, discount_card_id, card_discount_centavos,
         balance_due_centavos, receipt_no, receipt_generated_at, created_at,
         shops(name, location, logo_path),
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
  const methodLabel =
    { cash: "Cash", gcash: "GCash", bank: "Bank", other: "Other" }[
      s.payment_method as string
    ] ?? "Cash";
  const receiptNo = s.receipt_no ?? `OR-${s.id.slice(0, 8).toUpperCase()}`;
  const saleDate = s.receipt_generated_at ?? s.created_at ?? s.business_date;
  const logoUrl = productImageUrl(s.shops?.logo_path);

  return (
    <div className="flex flex-col items-center gap-4 py-6">
      <style dangerouslySetInnerHTML={{ __html: THERMAL_CSS }} />

      <div className="print:hidden">
        <PrintButton label="Print receipt" />
      </div>

      <div className="thermal-58">
        {/* Letterhead — the branch logo (or the anchor fallback), then the
            business identity. Logo → shop name → address. */}
        <div className="text-center">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              className="mx-auto mb-1 size-12 object-cover"
            />
          ) : (
            <Anchor className="mx-auto mb-1 size-6" />
          )}
          <div className="text-[12px] font-bold uppercase">{business.business_name}</div>
          {business.address && <div className="sm">{business.address}</div>}
          {business.phone && <div className="sm">{business.phone}</div>}
          {business.business_email && <div className="sm">{business.business_email}</div>}
          {business.business_tin && <div className="sm">TIN: {business.business_tin}</div>}
        </div>

        <div className="rule" />

        {/* Receipt header */}
        <div className="text-center">
          <div className="font-bold tracking-wide">RECEIPT</div>
          <div className="font-mono sm">{receiptNo}</div>
        </div>
        <div className="sm mt-1">{format(new Date(saleDate), "MMM d, yyyy · h:mm a")}</div>
        {/* Branch identity — same business name, but which branch + where */}
        {s.shops?.name && <div className="sm font-bold">Branch: {s.shops.name}</div>}
        {s.shops?.location && <div className="sm">{s.shops.location}</div>}
        {s.customers?.name && (
          <div className="sm">
            Customer: {s.customers.name}
            {s.customers.phone ? ` · ${s.customers.phone}` : ""}
          </div>
        )}

        <div className="rule" />

        {/* Lines */}
        {lines.map((l, i) => {
          const discount = l.discount_centavos ?? 0;
          return (
            <div key={i} className="py-0.5">
              <div className="row">
                <span className="min-w-0">
                  {l.description ?? "Item"}
                  {l.qty > 1 && ` × ${l.qty}`}
                </span>
                <span>{formatCentavos(l.line_total_centavos)}</span>
              </div>
              {/* any discounted line (parts too) shows the tawad */}
              {discount > 0 && l.list_reference_centavos != null && (
                <div className="sm">
                  Was {formatCentavos(l.list_reference_centavos)} · {formatCentavos(discount)} off
                </div>
              )}
            </div>
          );
        })}

        <div className="rule" />

        {/* Totals */}
        {/* Suki card (0072): the discount already lives in the line prices —
            this line just names the program so the suki sees their benefit. */}
        {s.discount_card_id && (s.card_discount_centavos ?? 0) > 0 && (
          <div className="row sm">
            <span>Suki card discount</span>
            <span>−{formatCentavos(s.card_discount_centavos)}</span>
          </div>
        )}
        <div className="row font-bold">
          <span>Total</span>
          <span>{formatCentavos(s.total_centavos)}</span>
        </div>
        {isPartial ? (
          <>
            <div className="row sm">
              <span>Downpayment</span>
              <span>{formatCentavos(s.amount_paid_centavos ?? 0)}</span>
            </div>
            <div className="row font-bold">
              <span>Balance due</span>
              <span>{formatCentavos(s.balance_due_centavos ?? 0)}</span>
            </div>
          </>
        ) : (
          <div className="row sm">
            <span>Paid in full</span>
            <span>{formatCentavos(s.amount_paid_centavos ?? s.total_centavos)}</span>
          </div>
        )}
        <div className="row sm">
          <span>{isPartial ? "Downpayment via" : "Paid via"}</span>
          <span>{methodLabel}</span>
        </div>

        <div className="rule" />

        {/* Payment status — plain text, not a filled badge */}
        <div className="text-center font-bold uppercase">
          {isPartial ? "Partial — balance on pickup" : "Paid in full"}
        </div>

        <div className="rule" />

        {/* Footer + whitespace for the cutter */}
        <div className="sm pb-6 text-center">
          {business.receipt_footer
            ? business.receipt_footer
            : "Thank you! Please keep this receipt for warranty & claims."}
        </div>
      </div>
    </div>
  );
}
