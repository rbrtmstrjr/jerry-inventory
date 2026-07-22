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
 * Point-of-sale warranty certificate — printable the moment an engine sale is
 * recorded, BEFORE Admin approves (0055). It's the customer's copy, rendered
 * from the sale itself, not the official warranty record (which only exists
 * after approval). One page per engine on the sale.
 *
 * Access + void are both handled by `fn_shop_warranty_preview`: it re-checks
 * the sale belongs to the caller's shop, and returns nothing for a
 * cancelled/deleted sale — so a voided sale 404s here exactly like its receipt.
 */
export default async function WarrantyPreviewPage({
  params,
}: {
  params: Promise<{ saleId: string }>;
}) {
  const { saleId } = await params;
  const supabase = await createClient();

  const [previewRes, business] = await Promise.all([
    supabase.rpc("fn_shop_warranty_preview", { p_sale_id: saleId }),
    getBusinessIdentity(supabase),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const rows = (previewRes.data ?? []) as any[];
  if (rows.length === 0) notFound();

  return (
    <div className="flex flex-col gap-8">
      {rows.map((w, i) => {
        const data: WarrantyCertificateData = {
          id: w.engine_id,
          serial_number: w.serial_number,
          condition: w.condition,
          brand: w.brand,
          model: w.model,
          horsepower: w.horsepower != null ? Number(w.horsepower) : null,
          stroke: w.stroke,
          customer_name: w.customer_name,
          customer_phone: w.customer_phone,
          customer_address: w.customer_address,
          shop_name: w.shop_name,
          shop_location: w.shop_location ?? null,
          shop_logo_path: w.shop_logo_path ?? null,
          sold_on: w.sold_on,
          months: w.months,
          expires_on: w.expires_on,
        };
        return (
          <div
            key={w.engine_id}
            className={i < rows.length - 1 ? "print:break-after-page" : ""}
          >
            <WarrantyCertificate data={data} business={business} />
          </div>
        );
      })}
    </div>
  );
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
