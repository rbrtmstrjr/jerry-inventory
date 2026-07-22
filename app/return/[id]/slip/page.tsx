import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Return Slip" };

const STATUS_LABEL: Record<string, string> = {
  requested: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

/**
 * Return Slip — the document a shop→master return travels with, signed on both
 * ends. Outside every role group (like /receipt and /transfer/[id]/slip): the
 * party-scoped `return_slip` view is the gate — a non-party (or anon) session
 * reads no row → notFound(). Reads public_settings for the letterhead.
 */
export default async function ReturnSlipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [slipRes, linesRes, business] = await Promise.all([
    supabase.from("return_slip").select("*").eq("id", id).maybeSingle(),
    supabase.from("return_slip_lines").select("*").eq("return_id", id),
    getBusinessIdentity(supabase),
  ]);

  const slip = slipRes.data;
  if (!slip) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const s = slip as any;
  const lines = (linesRes.data ?? []) as any[];
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const ref = `RT-${s.id.slice(0, 8).toUpperCase()}`;
  const anyDamaged = lines.some((l) => (l.qty_damaged ?? 0) > 0);

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print slip" />
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
            <div className="text-lg font-bold">RETURN SLIP</div>
            <div className="font-mono text-sm">{ref}</div>
            <div className="text-xs text-muted-foreground">
              {STATUS_LABEL[s.status] ?? s.status}
            </div>
          </div>
        </div>

        {/* From → To */}
        <div className="grid grid-cols-2 gap-4 border-b py-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Returned by</div>
            <div className="font-medium">{s.shop_name}</div>
            {s.shop_location && (
              <div className="text-muted-foreground">{s.shop_location}</div>
            )}
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">Returned to</div>
            <div className="font-medium">{business.business_name} — Admin</div>
            <div className="text-muted-foreground">Master Inventory</div>
          </div>
        </div>

        {/* Meta */}
        <div className="grid grid-cols-2 gap-4 border-b py-3 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Requested</div>
            <div>{format(new Date(s.requested_at), "MMMM d, yyyy h:mm a")}</div>
            {s.requested_by_name && (
              <div className="text-muted-foreground">by {s.requested_by_name}</div>
            )}
          </div>
          <div className="text-right">
            {s.approved_at && (
              <>
                <div className="text-xs uppercase text-muted-foreground">
                  {s.status === "rejected" ? "Rejected" : "Approved"}
                </div>
                <div>{format(new Date(s.approved_at), "MMMM d, yyyy h:mm a")}</div>
                {s.approved_by_name && (
                  <div className="text-muted-foreground">by {s.approved_by_name}</div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Lines */}
        <table className="w-full py-2 text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2">#</th>
              <th className="py-2">Item</th>
              <th className="py-2 text-right">Good</th>
              {anyDamaged && <th className="py-2 text-right">Damaged</th>}
              <th className="py-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.id} className="border-b">
                <td className="py-2 text-muted-foreground">{i + 1}</td>
                <td className="py-2">
                  {l.name}
                  {l.serial_number && (
                    <span className="ml-2 font-mono text-xs">SN {l.serial_number}</span>
                  )}
                  {l.sku && !l.serial_number && (
                    <span className="ml-2 text-xs text-muted-foreground">SKU {l.sku}</span>
                  )}
                </td>
                <td className="py-2 text-right tabular-nums">{l.qty_good}</td>
                {anyDamaged && (
                  <td className="py-2 text-right tabular-nums">
                    {(l.qty_damaged ?? 0) > 0 ? (
                      <span className="font-medium text-destructive">{l.qty_damaged}</span>
                    ) : (
                      0
                    )}
                  </td>
                )}
                <td className="py-2 text-right tabular-nums">
                  {l.qty} {l.serial_number ? "unit" : l.unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {anyDamaged && (
          <div className="border-b py-2 text-xs text-destructive">
            Damaged units are written off as shrinkage on approval — they do not
            re-enter sellable stock.
          </div>
        )}

        {s.reason && (
          <div className="border-b py-3 text-sm">
            <span className="text-xs uppercase text-muted-foreground">Reason: </span>
            {s.reason}
          </div>
        )}

        {s.status === "rejected" && s.review_note && (
          <div className="border-b py-3 text-sm">
            <span className="text-xs uppercase text-muted-foreground">
              Admin note:{" "}
            </span>
            {s.review_note}
          </div>
        )}

        {/* Signatures */}
        <div className="mt-12 grid grid-cols-2 gap-12 text-sm">
          <div className="border-t pt-2 text-center text-muted-foreground">
            Released / Returned by — {s.shop_name}
            <div className="text-xs">(signature / date)</div>
          </div>
          <div className="border-t pt-2 text-center text-muted-foreground">
            Received by — Admin
            <div className="text-xs">(signature / date)</div>
          </div>
        </div>
      </div>
    </div>
  );
}
