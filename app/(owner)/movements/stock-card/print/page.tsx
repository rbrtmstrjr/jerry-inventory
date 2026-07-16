import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Anchor, BookOpen } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { ph_today } from "@/lib/ph-date";
import { PrintButton } from "@/components/shell/print-button";
import type { StockCardRow } from "../../types";

export const metadata: Metadata = { title: "Stock Card" };

const phDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila", year: "numeric", month: "short", day: "2-digit",
  });

/**
 * The filed ledger page: business header, one product at one location, opening
 * balance, every movement, closing balance, and a line to sign.
 *
 * Same shape as the delivery note / count sheet / warranty certificate — and
 * the same identity source (`public_settings` via getBusinessIdentity), so this
 * document carries the same letterhead as every other one.
 */
export default async function StockCardPrintPage({
  searchParams,
}: {
  searchParams: Promise<{ part?: string; shop?: string; from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const isDate = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!sp.part) notFound();

  const today = ph_today();
  const to = isDate(sp.to) ? sp.to! : today;
  const from = isDate(sp.from) ? sp.from! : `${to.slice(0, 7)}-01`;
  const shopId = sp.shop && sp.shop !== "master" ? sp.shop : null;

  const supabase = await createClient();
  const [partRes, shopRes, cardRes, business] = await Promise.all([
    supabase.from("parts").select("name, sku, unit").eq("id", sp.part).maybeSingle(),
    shopId
      ? supabase.from("shops").select("name").eq("id", shopId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.rpc("fn_stock_card", {
      p_part_id: sp.part, p_shop_id: shopId, p_from: from, p_to: to,
    }),
    getBusinessIdentity(supabase),
  ]);

  if (!partRes.data) notFound();
  const part = partRes.data;
  const rows = (cardRes.data ?? []) as StockCardRow[];
  const opening = rows.find((r) => r.kind === "opening");
  const moves = rows.filter((r) => r.kind === "movement");
  const closing = moves.length ? moves[moves.length - 1].balance : (opening?.balance ?? 0);
  const locationName = shopId ? (shopRes.data?.name ?? "Shop") : "Master";

  return (
    <div className="mx-auto max-w-3xl p-4">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print stock card" />
      </div>

      <div className="rounded-lg border bg-card p-8 text-card-foreground print:rounded-none print:border-0 print:p-0">
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
            </div>
          </div>
          <div className="text-right">
            <div className="flex items-center justify-end gap-1 text-lg font-bold">
              <BookOpen className="size-5" /> STOCK CARD
            </div>
            <div className="text-sm text-muted-foreground">
              {from} to {to}
            </div>
          </div>
        </div>

        {/* Product + location */}
        <div className="grid grid-cols-2 gap-4 border-b py-3 text-sm">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Item</div>
            <div className="font-medium">{part.name}</div>
            {part.sku && <div className="font-mono text-xs text-muted-foreground">{part.sku}</div>}
          </div>
          <div className="text-right">
            <div className="text-xs uppercase text-muted-foreground">Location</div>
            <div className="font-medium">{locationName}</div>
            <div className="text-xs text-muted-foreground">Unit: {part.unit}</div>
          </div>
        </div>

        {/* The book */}
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2">Date</th>
              <th className="py-2">Reference</th>
              <th className="py-2">Particulars</th>
              <th className="py-2 text-right">In</th>
              <th className="py-2 text-right">Out</th>
              <th className="py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b font-medium">
              <td className="py-2" colSpan={3}>Opening balance</td>
              <td /><td />
              <td className="py-2 text-right tabular-nums">{opening?.balance ?? 0}</td>
            </tr>
            {moves.map((r) => (
              <tr key={r.movement_id} className="border-b break-inside-avoid">
                <td className="whitespace-nowrap py-2">{phDate(r.created_at)}</td>
                <td className="py-2 font-mono text-xs">{r.reference ?? ""}</td>
                <td className="py-2">{r.particulars}</td>
                <td className="py-2 text-right tabular-nums">{r.qty_in ? r.qty_in : ""}</td>
                <td className="py-2 text-right tabular-nums">{r.qty_out ? r.qty_out : ""}</td>
                <td className="py-2 text-right tabular-nums">{r.balance}</td>
              </tr>
            ))}
            {moves.length === 0 && (
              <tr className="border-b">
                <td colSpan={6} className="py-6 text-center text-muted-foreground">
                  No movements in this period.
                </td>
              </tr>
            )}
            <tr className="border-t-2 font-bold">
              <td className="py-2" colSpan={3}>Closing balance</td>
              <td /><td />
              <td className="py-2 text-right text-base tabular-nums">{closing}</td>
            </tr>
          </tbody>
        </table>

        <p className="mt-4 text-[10px] text-muted-foreground">
          Every line is a recorded movement; this card is generated from the
          append-only ledger and cannot be edited. Stock lost in transit never
          reached this location and is not shown here.
        </p>

        {/* Somewhere to argue with a shop about a count. */}
        <div className="mt-6">
          <div className="text-xs uppercase text-muted-foreground">Notes</div>
          <div className="mt-1 h-16 rounded-md border border-dashed" />
        </div>
        <div className="mt-8 grid grid-cols-2 gap-12 text-sm">
          <div className="border-t pt-2 text-center text-muted-foreground">Checked by</div>
          <div className="border-t pt-2 text-center text-muted-foreground">Date</div>
        </div>
      </div>
    </div>
  );
}
