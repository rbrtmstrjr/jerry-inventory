import { format } from "date-fns";
import { Anchor, ShieldCheck } from "lucide-react";

import type { BusinessIdentity } from "@/lib/db-types";
import { PrintButton } from "@/components/shell/print-button";

/**
 * The warranty certificate document. Shared by the owner route
 * (/warranties/[id]/certificate) and the shop route
 * (/shop/warranties/[id]/certificate) so a reprint from either side is byte
 * -for-byte the same paper. Presentational only — the caller does the
 * fetching and, for shops, the ownership check.
 *
 * That byte-for-byte claim was not actually true until 0043: both callers read
 * the owner-only `settings` table, so the SHOP's copy came back null and
 * printed with a hardcoded name and no address. Both now read
 * `public_settings`, which is what makes the promise in this comment hold.
 */
export interface WarrantyCertificateData {
  id: string;
  serial_number: string;
  condition: string | null;
  brand: string | null;
  model: string | null;
  horsepower: number | null;
  stroke: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  shop_name: string | null;
  sold_on: string;
  months: number;
  expires_on: string;
}

export function WarrantyCertificate({
  data,
  business,
}: {
  data: WarrantyCertificateData;
  business: BusinessIdentity;
}) {
  const certNo = `WC-${data.id.slice(0, 8).toUpperCase()}`;

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
              <div className="text-lg font-bold">{business.business_name}</div>
              {business.address && (
                <div className="text-xs text-muted-foreground">{business.address}</div>
              )}
              {business.phone && (
                <div className="text-xs text-muted-foreground">{business.phone}</div>
              )}
              {business.business_email && (
                <div className="text-xs text-muted-foreground">
                  {business.business_email}
                </div>
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
            {data.brand} {data.model}
            {data.horsepower != null && ` — ${data.horsepower}HP`}
            {data.stroke && ` (${data.stroke})`}
          </div>
          <div className="mt-1 font-mono text-sm">Serial No: {data.serial_number}</div>
          <div className="text-sm text-muted-foreground">
            Condition at sale:{" "}
            {data.condition === "brand_new" ? "Brand new" : "Second hand"}
          </div>
        </div>

        {/* Customer + terms */}
        <div className="grid grid-cols-2 gap-4 border-b py-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Purchased by</div>
            <div className="font-medium">{data.customer_name}</div>
            {data.customer_phone && (
              <div className="text-muted-foreground">{data.customer_phone}</div>
            )}
            {data.customer_address && (
              <div className="text-muted-foreground">{data.customer_address}</div>
            )}
            {data.shop_name && (
              <div className="mt-1 text-muted-foreground">Sold at: {data.shop_name}</div>
            )}
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-muted-foreground">Coverage</div>
            <div className="font-medium">
              {format(new Date(data.sold_on), "MMMM d, yyyy")} —{" "}
              {format(new Date(data.expires_on), "MMMM d, yyyy")}
            </div>
            <div className="text-muted-foreground">
              {data.months} month{data.months === 1 ? "" : "s"} warranty
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
