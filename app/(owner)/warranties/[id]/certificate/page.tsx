import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor, ShieldCheck } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Warranty Certificate" };

export default async function WarrantyCertificatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [warrantyRes, settingsRes] = await Promise.all([
    supabase
      .from("warranties")
      .select(
        `id, sold_on, months, expires_on,
         engines(serial_number, condition, engine_models(brand, model, horsepower, stroke)),
         customers(name, phone, address),
         sales(shops(name, location))`
      )
      .eq("id", id)
      .single(),
    supabase
      .from("settings")
      .select("business_name, address, phone")
      .eq("id", 1)
      .single(),
  ]);

  const w = warrantyRes.data;
  if (!w) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const d = w as any;
  const settings = settingsRes.data;
  const model = d.engines?.engine_models;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const certNo = `WC-${d.id.slice(0, 8).toUpperCase()}`;

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print certificate" />
      </div>

      <div className="rounded-lg border-2 bg-card p-8 print:rounded-none print:p-2">
        {/* Header */}
        <div className="flex items-start justify-between border-b-2 pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground print:border print:bg-transparent print:text-foreground">
              <Anchor className="size-5" />
            </div>
            <div>
              <div className="text-lg font-bold">
                {settings?.business_name ?? "Jerry's Marine"}
              </div>
              {settings?.address && (
                <div className="text-xs text-muted-foreground">{settings.address}</div>
              )}
              {settings?.phone && (
                <div className="text-xs text-muted-foreground">{settings.phone}</div>
              )}
            </div>
          </div>
          <div className="text-right">
            <div className="flex items-center justify-end gap-1 text-lg font-bold">
              <ShieldCheck className="size-5" /> WARRANTY
            </div>
            <div className="font-mono text-sm">{certNo}</div>
          </div>
        </div>

        {/* Engine */}
        <div className="border-b py-4">
          <div className="text-xs uppercase text-muted-foreground">Engine</div>
          <div className="text-xl font-semibold">
            {model?.brand} {model?.model}
            {model?.horsepower != null && ` — ${model.horsepower}HP`}
            {model?.stroke && ` (${model.stroke})`}
          </div>
          <div className="mt-1 font-mono text-sm">
            Serial No: {d.engines?.serial_number}
          </div>
          <div className="text-sm text-muted-foreground">
            Condition at sale:{" "}
            {d.engines?.condition === "brand_new" ? "Brand new" : "Second hand"}
          </div>
        </div>

        {/* Customer + terms */}
        <div className="grid grid-cols-2 gap-4 border-b py-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Purchased by</div>
            <div className="font-medium">{d.customers?.name}</div>
            {d.customers?.phone && (
              <div className="text-muted-foreground">{d.customers.phone}</div>
            )}
            {d.customers?.address && (
              <div className="text-muted-foreground">{d.customers.address}</div>
            )}
            {d.sales?.shops?.name && (
              <div className="mt-1 text-muted-foreground">
                Sold at: {d.sales.shops.name}
              </div>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-muted-foreground">Coverage</div>
            <div className="font-medium">
              {format(new Date(d.sold_on), "MMMM d, yyyy")} —{" "}
              {format(new Date(d.expires_on), "MMMM d, yyyy")}
            </div>
            <div className="text-muted-foreground">
              {d.months} month{d.months === 1 ? "" : "s"} warranty
            </div>
          </div>
        </div>

        {/* Terms */}
        <div className="py-4 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Terms</p>
          <p>
            This warranty covers manufacturing defects under normal use from the
            date of sale until the expiry date above. It does not cover damage
            from misuse, improper fuel or oil mixture, lack of maintenance,
            submersion, or unauthorized repair. Present this certificate and the
            engine serial number for any claim at the shop of purchase.
          </p>
        </div>

        {/* Signatures */}
        <div className="mt-10 grid grid-cols-2 gap-12 text-sm">
          <div className="border-t pt-2 text-center text-muted-foreground">
            Authorized signature
          </div>
          <div className="border-t pt-2 text-center text-muted-foreground">
            Customer signature
          </div>
        </div>
      </div>
    </div>
  );
}
