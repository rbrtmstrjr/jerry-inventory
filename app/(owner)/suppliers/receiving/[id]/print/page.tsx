import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { formatCentavos } from "@/lib/format";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Receiving Voucher" };

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  bank: "Bank transfer",
  gcash: "GCash",
  check: "Cheque",
  other: "Other",
};

const STATUS_LABEL: Record<string, string> = {
  paid: "Paid in full",
  partial: "Partially paid",
  unpaid: "Unpaid (on credit)",
};

/**
 * Printable goods-received voucher for one receiving — the owner's record of
 * what a supplier delivered, at what cost, and how it was paid. Owner route
 * (reads owner-only `receivings`/`receiving_lines`).
 */
export default async function ReceivingVoucherPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [rcvRes, business] = await Promise.all([
    supabase
      .from("receivings")
      .select(
        `id, received_at, note, total_amount, amount_paid, payment_status,
         payment_method, reference_no, due_date, settled_at,
         suppliers(name, contact),
         profiles!receivings_created_by_fkey(full_name),
         receiving_lines(qty, unit_cost_centavos, part_id, engine_id,
           parts(name, sku, unit),
           engines(serial_number, engine_models(brand, model, horsepower)))`
      )
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
    getBusinessIdentity(supabase),
  ]);

  if (!rcvRes.data) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const r = rcvRes.data as any;
  const lines = (r.receiving_lines ?? []) as any[];
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const total = Number(r.total_amount ?? 0);
  const paid = Number(r.amount_paid ?? 0);
  const balance = Math.max(0, total - paid);
  const refNo = `RV-${r.id.slice(0, 8).toUpperCase()}`;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print voucher" />
      </div>

      <div className="rounded-lg border bg-card p-8 print:rounded-none print:border-0 print:p-0">
        {/* Header */}
        <div className="flex items-start justify-between border-b pb-4">
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
            <div className="text-lg font-bold">RECEIVING VOUCHER</div>
            <div className="font-mono text-sm">{refNo}</div>
          </div>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-2 gap-4 border-b py-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Supplier</div>
            <div className="font-medium">{r.suppliers?.name ?? "Manual entry"}</div>
            {r.suppliers?.contact && (
              <div className="text-muted-foreground">{r.suppliers.contact}</div>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-muted-foreground">Date received</div>
            <div className="font-medium">
              {format(new Date(r.received_at), "MMMM d, yyyy h:mm a")}
            </div>
            {r.profiles?.full_name && (
              <div className="text-muted-foreground">Received by {r.profiles.full_name}</div>
            )}
          </div>
        </div>

        {/* Lines */}
        <table className="w-full py-2 text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2">#</th>
              <th className="py-2">Item</th>
              <th className="py-2 text-right">Qty</th>
              <th className="py-2 text-right">Unit cost</th>
              <th className="py-2 text-right">Line total</th>
            </tr>
          </thead>
          <tbody>
            {/* eslint-disable @typescript-eslint/no-explicit-any */}
            {lines.map((l: any, i: number) => {
              const isEngine = !!l.engine_id;
              const name = isEngine
                ? `Engine — ${l.engines?.engine_models?.brand ?? ""} ${
                    l.engines?.engine_models?.model ?? ""
                  }`.trim()
                : (l.parts?.name ?? "Item");
              const sub = isEngine
                ? `SN ${l.engines?.serial_number ?? "?"}`
                : l.parts?.sku
                  ? `SKU ${l.parts.sku}`
                  : null;
              const qty = Number(l.qty ?? 0);
              const unit = Number(l.unit_cost_centavos ?? 0);
              return (
                <tr key={i} className="border-b align-top">
                  <td className="py-2 text-muted-foreground">{i + 1}</td>
                  <td className="py-2">
                    <div>{name}</div>
                    {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {qty} {isEngine ? "unit" : (l.parts?.unit ?? "")}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatCentavos(unit)}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatCentavos(unit * qty)}
                  </td>
                </tr>
              );
            })}
            {/* eslint-enable @typescript-eslint/no-explicit-any */}
          </tbody>
        </table>

        {/* Totals + payment */}
        <div className="ml-auto mt-4 w-full max-w-xs text-sm">
          <div className="flex justify-between border-b py-1.5">
            <span className="text-muted-foreground">Total cost</span>
            <span className="font-semibold tabular-nums">{formatCentavos(total)}</span>
          </div>
          <div className="flex justify-between py-1.5">
            <span className="text-muted-foreground">Paid</span>
            <span className="tabular-nums">{formatCentavos(paid)}</span>
          </div>
          {balance > 0 && (
            <div className="flex justify-between border-t py-1.5 font-medium">
              <span>Balance due</span>
              <span className="tabular-nums">{formatCentavos(balance)}</span>
            </div>
          )}
        </div>

        {/* Payment details */}
        <div className="mt-4 grid grid-cols-2 gap-4 border-t py-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Payment</div>
            <div className="font-medium">
              {STATUS_LABEL[r.payment_status] ?? r.payment_status}
            </div>
            {r.payment_method && (
              <div className="text-muted-foreground">
                via {METHOD_LABEL[r.payment_method] ?? r.payment_method}
                {r.reference_no ? ` · ${r.reference_no}` : ""}
              </div>
            )}
          </div>
          {r.due_date && balance > 0 && (
            <div className="text-right">
              <div className="text-xs uppercase text-muted-foreground">Due date</div>
              <div className="font-medium">
                {format(new Date(`${r.due_date}T00:00:00`), "MMMM d, yyyy")}
              </div>
            </div>
          )}
        </div>

        {r.note && (
          <div className="border-b py-3 text-sm">
            <span className="text-xs uppercase text-muted-foreground">Note: </span>
            {r.note}
          </div>
        )}

        {/* Signatures */}
        <div className="mt-12 grid grid-cols-2 gap-12 text-sm">
          <div className="border-t pt-2 text-center text-muted-foreground">
            Received by (signature / date)
          </div>
          <div className="border-t pt-2 text-center text-muted-foreground">
            Supplier / delivered by (signature / date)
          </div>
        </div>
      </div>
    </div>
  );
}
