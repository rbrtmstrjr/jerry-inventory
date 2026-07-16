import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
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
        `id, delivered_at, note, shops(name, location),
         profiles!deliveries_created_by_fkey(full_name),
         delivery_lines(qty, parts(name, unit, sku),
           engines(serial_number, engine_models(brand, model, horsepower)))`
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
                  {l.qty} {l.parts.unit}
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
                <td className="py-2 text-right tabular-nums">1 unit</td>
              </tr>
            ))}
            {/* eslint-enable @typescript-eslint/no-explicit-any */}
          </tbody>
        </table>

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
