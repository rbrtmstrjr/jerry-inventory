import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { formatCentavos } from "@/lib/format";
import { PrintButton } from "./print-button";

export const metadata: Metadata = { title: "Delivery Note" };

export default async function DeliveryNotePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [deliveryRes, business] = await Promise.all([
    supabase
      .from("deliveries")
      .select(
        `id, delivered_at, note, status,
         shops!deliveries_shop_id_fkey(name, location),
         profiles!deliveries_created_by_fkey(full_name),
         delivery_lines(qty, qty_received,
           parts(name, unit, sku, cost_centavos, price_centavos),
           engines(serial_number, cost_centavos, price_centavos,
             engine_models(brand, model, horsepower)))`
      )
      .eq("id", id)
      .single(),
    getBusinessIdentity(supabase),
  ]);

  const delivery = deliveryRes.data;
  if (!delivery) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const d = delivery as any;
  const partLines = (d.delivery_lines ?? []).filter((l: any) => l.parts);
  const engineLines = (d.delivery_lines ?? []).filter((l: any) => l.engines);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const noteNo = `DN-${d.id.slice(0, 8).toUpperCase()}`;
  // Once the shop has confirmed, the note reflects what ACTUALLY landed
  // (qty_received) — anything short was returned to master or written off, so
  // it never reached the shop. Before confirmation it shows what was sent.
  const confirmed = d.status !== "in_transit";
  const landedQty = (l: { qty: number; qty_received: number | null }) =>
    confirmed ? (l.qty_received ?? 0) : l.qty;

  // Cost + selling are read LIVE from master (parts/engines). Totals use the
  // same quantity the note prints (landed once confirmed, sent before that).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const lineCost = (l: any) => l.parts?.cost_centavos ?? l.engines?.cost_centavos ?? 0;
  const linePrice = (l: any) => l.parts?.price_centavos ?? l.engines?.price_centavos ?? 0;
  const allLines = [...partLines, ...engineLines];
  const totalCost = allLines.reduce((s, l) => s + landedQty(l) * lineCost(l), 0);
  const totalSelling = allLines.reduce((s, l) => s + landedQty(l) * linePrice(l), 0);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton />
      </div>

      <div className="rounded-lg border bg-card p-8 print:rounded-none print:border-0 print:p-0">
        {/* Header */}
        <div className="flex items-start justify-between border-b pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground print:border print:bg-transparent print:text-foreground">
              <Anchor className="size-5" />
            </div>
            <div>
              <div className="text-lg font-bold">
                {business.business_name}
              </div>
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
            <div className="font-medium">{d.shops?.name}</div>
            {d.shops?.location && (
              <div className="text-muted-foreground">{d.shops.location}</div>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-muted-foreground">Date</div>
            <div className="font-medium">
              {format(new Date(d.delivered_at), "MMMM d, yyyy h:mm a")}
            </div>
            {d.profiles?.full_name && (
              <div className="text-muted-foreground">
                Prepared by {d.profiles.full_name}
              </div>
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
              <th className="py-2 text-right">Unit price</th>
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
                </td>
                <td className="py-2 text-right tabular-nums">
                  {landedQty(l)} {l.parts.unit}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCentavos(l.parts.cost_centavos ?? 0)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCentavos(l.parts.price_centavos ?? 0)}
                </td>
              </tr>
            ))}
            {engineLines.map((l: any, i: number) => (
              <tr key={`e-${i}`} className="border-b">
                <td className="py-2 text-muted-foreground">
                  {partLines.length + i + 1}
                </td>
                <td className="py-2">
                  Engine — {l.engines.engine_models?.brand}{" "}
                  {l.engines.engine_models?.model}
                  {l.engines.engine_models?.horsepower != null &&
                    ` ${l.engines.engine_models.horsepower}HP`}
                  <span className="ml-2 font-mono text-xs">
                    SN {l.engines.serial_number}
                  </span>
                </td>
                <td className="py-2 text-right tabular-nums">
                  {landedQty(l)} unit
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCentavos(l.engines.cost_centavos ?? 0)}
                </td>
                <td className="py-2 text-right tabular-nums">
                  {formatCentavos(l.engines.price_centavos ?? 0)}
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
