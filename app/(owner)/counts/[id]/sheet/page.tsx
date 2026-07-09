import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { format } from "date-fns";
import { Anchor } from "lucide-react";

import { createClient } from "@/lib/supabase/server";
import { PrintButton } from "@/components/shell/print-button";

export const metadata: Metadata = { title: "Count Sheet" };

export default async function CountSheetPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ blind?: string }>;
}) {
  const { id } = await params;
  const { blind } = await searchParams;
  const isBlind = blind === "1";
  const supabase = await createClient();

  const { data: snap } = await supabase
    .from("count_snapshots")
    .select(
      `id, snapshot_date, note, shop_id, shops(name, location),
       count_snapshot_lines(id, expected_qty, parts(name, unit, barcode))`
    )
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (!snap) notFound();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const s = snap as any;

  // engines currently at the shop — checklist section
  const { data: engines } = await supabase
    .from("engines")
    .select("serial_number, engine_models(brand, model, horsepower)")
    .eq("shop_id", s.shop_id)
    .eq("status", "delivered")
    .is("deleted_at", null)
    .order("serial_number");

  const lines = (s.count_snapshot_lines ?? [])
    .map((l: any) => ({
      name: l.parts?.name ?? "?",
      unit: l.parts?.unit ?? "pc",
      barcode: l.parts?.barcode ?? null,
      expected: l.expected_qty,
    }))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 flex justify-end print:hidden">
        <PrintButton label="Print count sheet" />
      </div>

      <div className="rounded-lg border bg-card p-8 print:rounded-none print:border-0 print:p-0">
        <div className="flex items-start justify-between border-b pb-4">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-md bg-primary text-primary-foreground print:border print:bg-transparent print:text-foreground">
              <Anchor className="size-5" />
            </div>
            <div>
              <div className="text-lg font-bold">Physical Count Sheet</div>
              <div className="text-sm text-muted-foreground">
                {s.shops?.name}
                {s.shops?.location && ` — ${s.shops.location}`}
              </div>
            </div>
          </div>
          <div className="text-right text-sm">
            <div className="font-medium">
              {format(new Date(s.snapshot_date), "MMMM d, yyyy")}
            </div>
            {s.note && <div className="text-muted-foreground">{s.note}</div>}
            {isBlind && (
              <div className="mt-1 font-medium">BLIND COUNT — expected hidden</div>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 py-3 text-sm text-muted-foreground">
          <div>Counted by: ______________________</div>
          <div>Date/time: ______________________</div>
        </div>

        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-muted-foreground">
              <th className="py-2">#</th>
              <th className="py-2">Item</th>
              <th className="py-2">Barcode</th>
              {!isBlind && <th className="py-2 text-right">Expected</th>}
              <th className="py-2 text-right">Counted</th>
              <th className="py-2 text-right">Remarks</th>
            </tr>
          </thead>
          <tbody>
            {/* eslint-disable @typescript-eslint/no-explicit-any */}
            {lines.map((l: any, i: number) => (
              <tr key={i} className="border-b">
                <td className="py-2.5 text-muted-foreground">{i + 1}</td>
                <td className="py-2.5">{l.name}</td>
                <td className="py-2.5 font-mono text-xs">{l.barcode ?? ""}</td>
                {!isBlind && (
                  <td className="py-2.5 text-right tabular-nums">
                    {l.expected} {l.unit}
                  </td>
                )}
                <td className="py-2.5 text-right">
                  <span className="inline-block w-20 border-b border-foreground/40">
                    &nbsp;
                  </span>
                </td>
                <td className="py-2.5 text-right">
                  <span className="inline-block w-24 border-b border-foreground/40">
                    &nbsp;
                  </span>
                </td>
              </tr>
            ))}
            {/* eslint-enable @typescript-eslint/no-explicit-any */}
          </tbody>
        </table>

        {(engines ?? []).length > 0 && (
          <>
            <h2 className="mt-6 border-b pb-1 text-sm font-semibold uppercase text-muted-foreground">
              Engines on hand — tick if present
            </h2>
            <table className="w-full text-sm">
              <tbody>
                {/* eslint-disable @typescript-eslint/no-explicit-any */}
                {(engines ?? []).map((e: any, i: number) => (
                  <tr key={i} className="border-b">
                    <td className="w-8 py-2.5">
                      <span className="inline-block size-4 border border-foreground/60" />
                    </td>
                    <td className="py-2.5 font-mono text-xs">{e.serial_number}</td>
                    <td className="py-2.5">
                      {e.engine_models?.brand} {e.engine_models?.model}
                      {e.engine_models?.horsepower != null &&
                        ` — ${e.engine_models.horsepower}HP`}
                    </td>
                  </tr>
                ))}
                {/* eslint-enable @typescript-eslint/no-explicit-any */}
              </tbody>
            </table>
          </>
        )}

        <p className="mt-6 text-xs text-muted-foreground">
          After counting, enter results in Monthly Count → this sheet. Any
          shortage is submitted as a reason-coded loss for approval.
        </p>
      </div>
    </div>
  );
}
