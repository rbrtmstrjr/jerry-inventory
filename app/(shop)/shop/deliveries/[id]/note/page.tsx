import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { formatCentavos } from "@/lib/format";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Delivery Note" };

/**
 * The SHOP's copy of the delivery note — its receipt of what actually arrived.
 * Reads the shop-safe views (RLS-scoped to the caller's own shop, no cost
 * exposed), so a shop can print/keep the same document the owner has. Once the
 * delivery is confirmed the Qty reflects what LANDED (qty_received); anything
 * short was returned to master or written off, so it never reached the shop.
 */
export default async function ShopDeliveryNotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [delRes, lineRes, business] = await Promise.all([
    supabase.from("shop_incoming_deliveries").select("*").eq("id", id).maybeSingle(),
    supabase.from("shop_incoming_delivery_lines").select("*").eq("delivery_id", id),
    getBusinessIdentity(supabase),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const d = delRes.data as any;
  if (!d) notFound();
  const lines = (lineRes.data ?? []) as any[];
  const partLines = lines.filter((l) => !l.engine_id);
  const engineLines = lines.filter((l) => l.engine_id);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // the shop's own row (readable via shops_select) for the "Deliver to" block
  const { data: shop } = await supabase
    .from("shops")
    .select("name, location")
    .eq("id", d.shop_id)
    .maybeSingle();

  const noteNo = `DN-${d.id.slice(0, 8).toUpperCase()}`;
  const confirmed = d.status !== "in_transit";
  const from = d.from_shop_name ?? "Admin / Master";
  const qtyOf = (l: { qty_sent: number; qty_received: number | null }) =>
    confirmed ? (l.qty_received ?? 0) : l.qty_sent;

  // cost + selling come straight off the safe view (0064), read live from master
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const totalCost = lines.reduce(
    (s: number, l: any) => s + qtyOf(l) * (l.cost_centavos ?? 0),
    0
  );
  const totalSelling = lines.reduce(
    (s: number, l: any) => s + qtyOf(l) * (l.price_centavos ?? 0),
    0
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <div className="mx-auto max-w-2xl p-4">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print / Save PDF" />
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
            <div className="text-lg font-bold">DELIVERY NOTE</div>
            <div className="font-mono text-sm">{noteNo}</div>
          </div>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-2 gap-4 border-b py-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Deliver to</div>
            <div className="font-medium">{shop?.name}</div>
            {shop?.location && (
              <div className="text-muted-foreground">{shop.location}</div>
            )}
            <div className="mt-1 text-xs text-muted-foreground">From {from}</div>
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-muted-foreground">Date</div>
            <div className="font-medium">
              {format(new Date(d.delivered_at), "MMMM d, yyyy h:mm a")}
            </div>
            <div className="text-muted-foreground capitalize">
              {confirmed ? "Received" : "In transit"}
            </div>
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
              <th className="py-2 text-right">Unit price</th>
            </tr>
          </thead>
          <tbody>
            {/* eslint-disable @typescript-eslint/no-explicit-any */}
            {partLines.map((l: any, i: number) => (
              <tr key={`p-${i}`} className="border-b">
                <td className="py-2 text-muted-foreground">{i + 1}</td>
                <td className="py-2">{l.name}</td>
                <td className="py-2 text-right tabular-nums">
                  {qtyOf(l)} {l.unit}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCentavos(l.cost_centavos ?? 0)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCentavos(l.price_centavos ?? 0)}
                </td>
              </tr>
            ))}
            {engineLines.map((l: any, i: number) => (
              <tr key={`e-${i}`} className="border-b">
                <td className="py-2 text-muted-foreground">{partLines.length + i + 1}</td>
                <td className="py-2">
                  {l.name}
                  <span className="ml-2 font-mono text-xs">SN {l.serial_number}</span>
                </td>
                <td className="py-2 text-right tabular-nums">{qtyOf(l)} unit</td>
                <td className="py-2 text-right tabular-nums">
                  {formatCentavos(l.cost_centavos ?? 0)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCentavos(l.price_centavos ?? 0)}
                </td>
              </tr>
            ))}
            {/* eslint-enable @typescript-eslint/no-explicit-any */}
          </tbody>
        </table>

        {/* Totals — value of the delivery at cost and at selling price */}
        <div className="ml-auto mt-3 w-full max-w-xs text-sm">
          <div className="flex justify-between border-b py-1.5">
            <span className="text-muted-foreground">Total at cost</span>
            <span className="font-medium tabular-nums">{formatCentavos(totalCost)}</span>
          </div>
          <div className="flex justify-between py-1.5">
            <span className="text-muted-foreground">Total at selling</span>
            <span className="font-semibold tabular-nums">
              {formatCentavos(totalSelling)}
            </span>
          </div>
        </div>

        {d.note && (
          <div className="border-b py-3 text-sm">
            <span className="text-xs uppercase text-muted-foreground">Note: </span>
            {d.note}
          </div>
        )}

        {/* Signatures */}
        <div className="mt-12 grid grid-cols-2 gap-12 text-sm">
          <div className="border-t pt-2 text-center text-muted-foreground">
            Delivered by (signature / date)
          </div>
          <div className="border-t pt-2 text-center text-muted-foreground">
            Received by (signature / date)
          </div>
        </div>
      </div>
    </div>
  );
}
