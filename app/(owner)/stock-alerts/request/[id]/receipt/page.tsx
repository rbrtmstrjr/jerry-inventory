import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Stock Request Receipt" };

/**
 * The INGOING document: a shop's request for stock, printed as an itemized
 * receipt (every requested item + qty), for the admin's records. The outgoing
 * counterpart is the Delivery Note printed when the request is fulfilled.
 *
 * Owner route (reads parts/engine_models directly, which are owner-only).
 */
export default async function StockRequestReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [reqRes, business] = await Promise.all([
    supabase
      .from("delivery_requests")
      .select(
        `id, created_at, status, note,
         shops(name, location),
         profiles!delivery_requests_requested_by_fkey(full_name),
         delivery_request_lines(qty_requested, note,
           parts(name, sku, unit),
           engine_models(brand, model, horsepower))`
      )
      .eq("id", id)
      .is("deleted_at", null)
      .maybeSingle(),
    getBusinessIdentity(supabase),
  ]);

  if (!reqRes.data) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const r = reqRes.data as any;
  const lines = (r.delivery_request_lines ?? []) as any[];
  const partLines = lines.filter((l) => l.parts);
  const engineLines = lines.filter((l) => l.engine_models);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const refNo = `SR-${r.id.slice(0, 8).toUpperCase()}`;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print request" />
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
            <div className="text-lg font-bold">STOCK REQUEST</div>
            <div className="font-mono text-sm">{refNo}</div>
          </div>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-2 gap-4 border-b py-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Requested by</div>
            <div className="font-medium">{r.shops?.name}</div>
            {r.shops?.location && (
              <div className="text-muted-foreground">{r.shops.location}</div>
            )}
            {r.profiles?.full_name && (
              <div className="text-muted-foreground">{r.profiles.full_name}</div>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-muted-foreground">Date</div>
            <div className="font-medium">
              {format(new Date(r.created_at), "MMMM d, yyyy h:mm a")}
            </div>
            <div className="text-muted-foreground capitalize">{r.status}</div>
          </div>
        </div>

        {/* Lines */}
        <table className="w-full py-2 text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2">#</th>
              <th className="py-2">Item</th>
              <th className="py-2 text-right">Qty</th>
            </tr>
          </thead>
          <tbody>
            {/* eslint-disable @typescript-eslint/no-explicit-any */}
            {partLines.map((l: any, i: number) => (
              <tr key={`p-${i}`} className="border-b">
                <td className="py-2 text-muted-foreground">{i + 1}</td>
                <td className="py-2">
                  {l.parts.name}
                  {l.parts.sku && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      SKU {l.parts.sku}
                    </span>
                  )}
                  {l.note && (
                    <span className="ml-2 text-xs text-muted-foreground">({l.note})</span>
                  )}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {l.qty_requested} {l.parts.unit}
                </td>
              </tr>
            ))}
            {engineLines.map((l: any, i: number) => (
              <tr key={`e-${i}`} className="border-b">
                <td className="py-2 text-muted-foreground">{partLines.length + i + 1}</td>
                <td className="py-2">
                  Engine — {l.engine_models?.brand} {l.engine_models?.model}
                  {l.engine_models?.horsepower != null &&
                    ` ${l.engine_models.horsepower}HP`}
                  {l.note && (
                    <span className="ml-2 text-xs text-muted-foreground">({l.note})</span>
                  )}
                </td>
                <td className="py-2 text-right tabular-nums">{l.qty_requested} unit</td>
              </tr>
            ))}
            {/* eslint-enable @typescript-eslint/no-explicit-any */}
          </tbody>
        </table>

        {r.note && (
          <div className="border-b py-3 text-sm">
            <span className="text-xs uppercase text-muted-foreground">Note: </span>
            {r.note}
          </div>
        )}

        {/* Signatures */}
        <div className="mt-12 grid grid-cols-2 gap-12 text-sm">
          <div className="border-t pt-2 text-center text-muted-foreground">
            Requested by (signature / date)
          </div>
          <div className="border-t pt-2 text-center text-muted-foreground">
            Received by Admin (signature / date)
          </div>
        </div>
      </div>
    </div>
  );
}
