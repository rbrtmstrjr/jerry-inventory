import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Stock Transfer Slip" };

/**
 * Stock Transfer Slip — travels with the goods, signed on both ends. Outside
 * every role group (like /receipt): the party-scoped `transfer_slip` view is
 * the gate — a non-party (or anon) session reads no row → notFound(). Reads
 * public_settings for the letterhead (never owner-only settings, or a shop
 * would print a blank header).
 */
export default async function TransferSlipPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [slipRes, linesRes, business] = await Promise.all([
    supabase.from("transfer_slip").select("*").eq("id", id).maybeSingle(),
    supabase.from("transfer_slip_lines").select("*").eq("delivery_id", id),
    getBusinessIdentity(supabase),
  ]);

  const slip = slipRes.data;
  if (!slip) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const s = slip as any;
  const lines = (linesRes.data ?? []) as any[];
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const ref = `TR-${s.id.slice(0, 8).toUpperCase()}`;
  const confirmed = !!s.confirmed_at; // received quantities are known
  const anyShort = lines.some((l) => (l.qty_outstanding ?? 0) > 0);

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
            <div className="text-lg font-bold">STOCK TRANSFER SLIP</div>
            <div className="font-mono text-sm">{ref}</div>
          </div>
        </div>

        {/* From → To */}
        <div className="grid grid-cols-2 gap-4 border-b py-4 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">From</div>
            <div className="font-medium">{s.from_shop_name}</div>
            {s.from_shop_location && (
              <div className="text-muted-foreground">{s.from_shop_location}</div>
            )}
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">To</div>
            <div className="font-medium">{s.to_shop_name}</div>
            {s.to_shop_location && (
              <div className="text-muted-foreground">{s.to_shop_location}</div>
            )}
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
                <div className="text-xs uppercase text-muted-foreground">Approved</div>
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
              <th className="py-2 text-right">Sent</th>
              {confirmed && <th className="py-2 text-right">Received</th>}
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const short = (l.qty_outstanding ?? 0) > 0;
              return (
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
                  <td className="py-2 text-right tabular-nums">
                    {l.qty_sent} {l.serial_number ? "unit" : l.unit}
                  </td>
                  {confirmed && (
                    <td className="py-2 text-right tabular-nums">
                      {l.qty_received ?? 0}
                      {short && (
                        <span className="ml-1 text-xs font-medium text-destructive">
                          ({l.qty_outstanding} short)
                        </span>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>

        {confirmed && anyShort && (
          <div className="border-b py-2 text-xs text-destructive">
            Shortfall recorded on arrival — held in transit for Admin&apos;s decision.
          </div>
        )}

        {s.note && (
          <div className="border-b py-3 text-sm">
            <span className="text-xs uppercase text-muted-foreground">Note: </span>
            {s.note}
          </div>
        )}

        {/* Signatures */}
        <div className="mt-12 grid grid-cols-2 gap-12 text-sm">
          <div className="border-t pt-2 text-center text-muted-foreground">
            Released / Sent by — {s.from_shop_name}
            <div className="text-xs">(signature / date)</div>
          </div>
          <div className="border-t pt-2 text-center text-muted-foreground">
            Received by — {s.to_shop_name}
            <div className="text-xs">(signature / date)</div>
          </div>
        </div>
      </div>
    </div>
  );
}
