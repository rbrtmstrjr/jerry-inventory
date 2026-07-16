import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import {
  WarrantyCertificate,
  type WarrantyCertificateData,
} from "@/components/warranty-certificate";

export const metadata: Metadata = { title: "Warranty Certificate" };

/**
 * Shop copy — identical document, reprintable.
 *
 * Ownership is re-checked SERVER-SIDE: we read through `shop_warranties`,
 * which only returns rows whose originating sale belongs to the caller's shop.
 * Guessing another shop's warranty id therefore returns no row → notFound().
 * There is no client-side check to bypass.
 */
export default async function ShopWarrantyCertificatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // `public_settings`, not `settings` — the latter is owner-only, so this page
  // (a shop's own reprint) used to render the letterhead blank.
  const [wRes, business] = await Promise.all([
    supabase.from("shop_warranties").select("*").eq("id", id).maybeSingle(),
    getBusinessIdentity(supabase),
  ]);

  if (!wRes.data) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const w = wRes.data as any;
  const data: WarrantyCertificateData = {
    id: w.id,
    serial_number: w.serial_number,
    condition: w.condition,
    brand: w.brand,
    model: w.model,
    horsepower: w.horsepower,
    stroke: w.stroke,
    customer_name: w.customer_name,
    customer_phone: w.customer_phone,
    customer_address: w.customer_address,
    shop_name: w.shop_name,
    sold_on: w.sold_on,
    months: w.months,
    expires_on: w.expires_on,
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return <WarrantyCertificate data={data} business={business} />;
}
