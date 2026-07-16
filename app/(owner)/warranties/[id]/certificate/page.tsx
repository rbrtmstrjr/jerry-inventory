import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import {
  WarrantyCertificate,
  type WarrantyCertificateData,
} from "@/components/warranty-certificate";

export const metadata: Metadata = { title: "Warranty Certificate" };

/** Owner copy — reads the base tables (owner-only via RLS + route group). */
export default async function WarrantyCertificatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // Same identity source as the shop's copy of this document, so the two are
  // genuinely the same paper rather than only claiming to be.
  const [warrantyRes, business] = await Promise.all([
    supabase
      .from("warranties")
      .select(
        `id, sold_on, months, expires_on,
         engines(serial_number, condition, engine_models(brand, model, horsepower, stroke)),
         customers(name, phone, address),
         sales(shops(name))`
      )
      .eq("id", id)
      .is("deleted_at", null)
      .single(),
    getBusinessIdentity(supabase),
  ]);

  if (!warrantyRes.data) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const w = warrantyRes.data as any;
  const model = w.engines?.engine_models;
  const data: WarrantyCertificateData = {
    id: w.id,
    serial_number: w.engines?.serial_number ?? "?",
    condition: w.engines?.condition ?? null,
    brand: model?.brand ?? null,
    model: model?.model ?? null,
    horsepower: model?.horsepower ?? null,
    stroke: model?.stroke ?? null,
    customer_name: w.customers?.name ?? null,
    customer_phone: w.customers?.phone ?? null,
    customer_address: w.customers?.address ?? null,
    shop_name: w.sales?.shops?.name ?? null,
    sold_on: w.sold_on,
    months: w.months,
    expires_on: w.expires_on,
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return <WarrantyCertificate data={data} business={business} />;
}
