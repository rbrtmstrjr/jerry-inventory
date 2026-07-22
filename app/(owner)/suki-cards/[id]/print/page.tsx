import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Cog } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { PrintButton } from "@/components/shell/print-button";
import { CardBarcode } from "./card-barcode";

export const metadata: Metadata = { title: "Print Suki Card" };

/**
 * The physical suki card — CR80 credit-card size (85.6 × 54 mm). The @page
 * size is ROUTE-SCOPED (inline <style>, same isolation rule as the 58 mm
 * receipt) so it can never leak into the full-page documents. Print on
 * cardstock, cut, laminate.
 */
export default async function SukiCardPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [cardRes, settingsRes, business] = await Promise.all([
    supabase
      .from("discount_cards")
      .select("id, card_no, status, issued_at, customers(name)")
      .eq("id", id)
      .is("deleted_at", null)
      .single(),
    supabase
      .from("settings")
      .select("suki_engine_discount_pct, suki_part_discount_pct")
      .eq("id", 1)
      .single(),
    getBusinessIdentity(supabase),
  ]);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const card = cardRes.data as any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  if (!card) notFound();

  const enginePct = settingsRes.data?.suki_engine_discount_pct ?? 10;
  const partPct = settingsRes.data?.suki_part_discount_pct ?? 5;

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 p-6 print:m-0 print:max-w-none print:p-0">
      {/* Card-size print job — this route only. print-color-adjust forces the
          brand band's blue to PRINT even when the browser's "Background
          graphics" option is off (backgrounds are skipped by default). */}
      <style>{`
        @media print { @page { size: 85.6mm 54mm; margin: 0 } }
        .suki-card, .suki-card * {
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
      `}</style>

      <div className="flex w-full items-center justify-between print:hidden">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Suki Card</h1>
          <p className="text-sm text-muted-foreground">
            {card.customers?.name} · <span className="font-mono">{card.card_no}</span>
            {card.status !== "active" && " · INACTIVE — reissue before handing out"}
          </p>
        </div>
        <PrintButton label="Print card" />
      </div>

      {/* The card itself — 85.6 × 54 mm at print, scaled preview on screen. */}
      <div
        className="suki-card relative flex flex-col overflow-hidden rounded-xl border bg-white text-slate-900 shadow-md print:rounded-none print:border-0 print:shadow-none"
        style={{ width: "85.6mm", height: "54mm" }}
      >
        {/* Watermark — fills the empty corner, faint enough not to fight the
            barcode (which stays on clean white above it). */}
        <Cog
          aria-hidden
          className="pointer-events-none absolute -bottom-10 -right-8 size-36 opacity-[0.06]"
          style={{ color: "var(--blue-700)" }}
          strokeWidth={1}
        />

        {/* Brand band */}
        <div
          className="flex items-center gap-1.5 px-3.5 py-2 text-white"
          style={{ background: "var(--blue-700)" }}
        >
          <Cog className="size-4 shrink-0" />
          <span className="text-[11px] font-bold uppercase tracking-wider">
            {business.business_name}
          </span>
          <span className="ml-auto text-[9px] font-semibold uppercase tracking-[0.2em] opacity-90">
            Suki Card
          </span>
        </div>

        {/* Body — three zones spread across the card's height */}
        <div className="relative flex flex-1 flex-col justify-between px-3.5 pb-2 pt-1.5">
          {/* Member */}
          <div className="flex items-end justify-between gap-2">
            <div className="min-w-0">
              <div className="text-[7px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Member
              </div>
              <div className="truncate text-[15px] font-bold leading-tight">
                {card.customers?.name}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[7px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                Since
              </div>
              <div className="text-[10px] font-semibold leading-tight">
                {format(new Date(card.issued_at), "MMM yyyy")}
              </div>
            </div>
          </div>

          {/* Perks */}
          <div className="flex items-center gap-1.5">
            <span
              className="rounded border px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide"
              style={{ borderColor: "var(--blue-700)", color: "var(--blue-700)" }}
            >
              {enginePct}% off engines
            </span>
            <span
              className="rounded border px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide"
              style={{ borderColor: "var(--blue-700)", color: "var(--blue-700)" }}
            >
              {partPct}% off parts
            </span>
            <span className="text-[7.5px] text-slate-500">valid at any branch</span>
          </div>

          {/* Barcode */}
          <div className="flex flex-col items-center">
            <CardBarcode value={card.card_no} />
            <span className="mt-0.5 font-mono text-[9px] tracking-[0.3em]">
              {card.card_no}
            </span>
          </div>
        </div>

        {/* Footer strip */}
        <div
          className="flex items-center justify-between px-3.5 py-1 text-[7px] text-white"
          style={{ background: "var(--blue-700)" }}
        >
          <span>Present this card at checkout</span>
          <span>{business.phone ?? ""}</span>
        </div>
      </div>

      <p className="text-center text-xs text-muted-foreground print:hidden">
        Prints at credit-card size (85.6 × 54 mm) on this route only. Print on
        cardstock and laminate; the shops&apos; barcode scanners read it at
        Record Sale.
      </p>
    </div>
  );
}
