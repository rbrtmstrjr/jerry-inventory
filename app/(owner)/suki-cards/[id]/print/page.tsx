import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Cog } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { getBusinessIdentity } from "@/lib/business-identity";
import { CardBarcode } from "./card-barcode";
import { PrintSideButtons } from "./print-side-buttons";

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
    <div className="mx-auto flex max-w-lg flex-col items-center gap-4 p-6 print:m-0 print:max-w-none print:gap-0 print:p-0">
      {/* Card-size print job — this route only. print-color-adjust forces the
          brand band's blue to PRINT even when the browser's "Background
          graphics" option is off (backgrounds are skipped by default). Front
          and back each take ONE page (break-after on the front), so duplex
          "flip on long edge" lines them up back-to-back. */}
      <style>{`
        @media print {
          @page { size: 85.6mm 54mm; margin: 0 }
          /* No side picked (plain Ctrl+P): both faces, one page each. */
          html:not([data-print-side]) .suki-front { break-after: page }
          /* "Print front" / "Print back": keep only that face — the physical
             flow is print one side, re-feed the sheet, print the other. */
          html[data-print-side="front"] .suki-back { display: none }
          html[data-print-side="back"] .suki-front { display: none }
        }
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
        <PrintSideButtons />
      </div>

      {/* FRONT — 85.6 × 54 mm at print, scaled preview on screen. The wrapper
          keeps the label aligned to the card's edge; print:contents removes it
          from the print flow so the page break sits on the card itself. */}
      <div className="flex flex-col gap-1.5 print:contents">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground print:hidden">
        Front
      </p>
      <div
        className="suki-card suki-front relative flex flex-col overflow-hidden rounded-xl border bg-white text-slate-900 shadow-md print:rounded-none print:border-0 print:shadow-none"
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

      </div>

      {/* BACK — terms of use, second page of the same job. Mirrors the front's
          frame: blue band top and bottom, benefits called out on their own
          strip, numbered terms with a hanging indent so wrapped lines align. */}
      <div className="mt-2 flex flex-col gap-1.5 print:contents">
      <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground print:hidden">
        Back
      </p>
      <div
        className="suki-card suki-back relative flex flex-col overflow-hidden rounded-xl border bg-white text-slate-900 shadow-md print:rounded-none print:border-0 print:shadow-none"
        style={{ width: "85.6mm", height: "54mm" }}
      >
        {/* Header band */}
        <div
          className="flex items-center justify-between px-3.5 py-1.5 text-white"
          style={{ background: "var(--blue-700)" }}
        >
          <span className="flex items-center gap-1.5">
            <Cog className="size-3.5" />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              {business.business_name}
            </span>
          </span>
          <span className="text-[8px] font-semibold uppercase tracking-[0.2em] opacity-90">
            Terms of use
          </span>
        </div>

        {/* Benefits strip — the entitlement, called out on its own line */}
        <div
          className="flex items-baseline justify-center gap-1.5 border-b px-3.5 py-1"
          style={{ background: "var(--blue-50)", borderColor: "var(--blue-200)" }}
        >
          <span
            className="text-[7px] font-bold uppercase tracking-[0.14em]"
            style={{ color: "var(--blue-700)" }}
          >
            Member benefits
          </span>
          <span className="text-[8.5px] font-semibold text-slate-800">
            {enginePct}% off engines · {partPct}% off parts · any branch
          </span>
        </div>

        {/* Terms — numbered, hanging indent so wrapped lines stay aligned */}
        <div className="flex flex-1 flex-col justify-center px-3.5">
          <ol className="flex flex-col gap-[3px] text-[7.5px] leading-[1.4] text-slate-600">
            {[
              `Valid only for the named member and non-transferable — the branch may ask to verify identity.`,
              `Discounts are not convertible to cash and cannot be combined with other promotions.`,
              `Report a lost or damaged card at any branch — it is deactivated and replaced with a new number.`,
              `This card remains the property of ${business.business_name} and may be revoked for misuse.`,
            ].map((term, i) => (
              <li key={i} className="flex gap-1.5">
                <span
                  className="w-2.5 shrink-0 text-right font-bold tabular-nums"
                  style={{ color: "var(--blue-700)" }}
                >
                  {i + 1}.
                </span>
                <span className="flex-1">{term}</span>
              </li>
            ))}
          </ol>
        </div>

        {/* Footer band — mirrors the front */}
        <div
          className="flex items-center justify-between gap-2 px-3.5 py-1 text-[7px] text-white"
          style={{ background: "var(--blue-700)" }}
        >
          <span className="truncate">{business.address ?? business.business_name}</span>
          <span className="shrink-0">{business.phone ?? ""}</span>
        </div>
      </div>
      </div>

      <p className="text-center text-xs text-muted-foreground print:hidden">
        Each button prints ONE face at credit-card size (85.6 × 54 mm):
        print the front, re-feed the same sheet flipped, then print the back.
        Cut and laminate; the shops&apos; barcode scanners read the front at
        Record Sale.
      </p>
    </div>
  );
}
