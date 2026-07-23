"use client";

import * as React from "react";
import JsBarcode from "jsbarcode";
import { Check, Printer, X } from "lucide-react";

import { formatCentavos } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Max label copies per item — a bigger count renders thousands of barcode
 *  previews and freezes the browser. */
const MAX_COPIES = 20;

interface LabelPart {
  id: string;
  name: string;
  barcode: string | null;
  price_centavos: number;
}

function BarcodeSvg({ value }: { value: string }) {
  const ref = React.useRef<SVGSVGElement>(null);
  React.useEffect(() => {
    if (ref.current) {
      try {
        JsBarcode(ref.current, value, {
          format: "CODE128",
          width: 1.5,
          height: 36,
          fontSize: 11,
          margin: 0,
          displayValue: true,
        });
      } catch {
        // invalid barcode chars — leave blank
      }
    }
  }, [value]);
  return <svg ref={ref} />;
}

export function LabelPrinter({
  parts,
  preselected,
}: {
  parts: LabelPart[];
  preselected: string[];
}) {
  const [selected, setSelected] = React.useState<Set<string>>(
    () => new Set(preselected)
  );
  const [copies, setCopies] = React.useState<Record<string, number>>({});
  const [search, setSearch] = React.useState("");

  const filtered = parts.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.barcode ?? "").toLowerCase().includes(search.toLowerCase())
  );

  const labels: LabelPart[] = [];
  for (const p of parts) {
    if (!selected.has(p.id)) continue;
    const n = Math.min(MAX_COPIES, Math.max(1, copies[p.id] ?? 1));
    for (let i = 0; i < n; i++) labels.push(p);
  }

  function toggle(id: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-2 print:block">
        <Card className="print:hidden">
          <CardHeader>
            <CardTitle>Pick items</CardTitle>
            <CardDescription>
              Only items with a barcode appear here. Generate internal barcodes
              from the Products tab first.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input
              placeholder="Search…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={filtered.length === 0}
                onClick={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    for (const p of filtered) next.add(p.id);
                    return next;
                  })
                }
              >
                <Check className="size-4" />
                Select all{search.trim() ? " (filtered)" : ""}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={selected.size === 0}
                onClick={() => setSelected(new Set())}
              >
                <X className="size-4" />
                Unselect all
              </Button>
              <span className="ml-auto text-xs text-muted-foreground tabular-nums">
                {selected.size} selected
              </span>
            </div>
            <div className="thin-scrollbar max-h-96 overflow-auto rounded-md border">
              {filtered.length === 0 && (
                <p className="p-4 text-sm text-muted-foreground">
                  No barcoded items found.
                </p>
              )}
              {filtered.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-3 border-b px-3 py-2 last:border-b-0"
                >
                  <Checkbox
                    id={`sel-${p.id}`}
                    checked={selected.has(p.id)}
                    onCheckedChange={(v) => toggle(p.id, v === true)}
                  />
                  <Label htmlFor={`sel-${p.id}`} className="flex-1 cursor-pointer">
                    <span className="block text-sm">{p.name}</span>
                    <span className="block font-mono text-xs text-muted-foreground">
                      {p.barcode}
                    </span>
                  </Label>
                  {selected.has(p.id) && (
                    <Input
                      type="number"
                      min={1}
                      max={MAX_COPIES}
                      className="w-20"
                      value={copies[p.id] ?? 1}
                      onChange={(e) => {
                        // Clamp to 1–20: `max` alone doesn't stop typing, and a
                        // huge count renders thousands of barcode previews and
                        // freezes the browser.
                        const raw = parseInt(e.target.value, 10);
                        const n = Number.isNaN(raw)
                          ? 1
                          : Math.min(MAX_COPIES, Math.max(1, raw));
                        setCopies((c) => ({ ...c, [p.id]: n }));
                      }}
                      aria-label={`Copies of ${p.name} (max ${MAX_COPIES})`}
                    />
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="print:border-0 print:shadow-none">
          <CardHeader className="print:hidden">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-col gap-1.5">
                <CardTitle>Preview ({labels.length} labels)</CardTitle>
                <CardDescription>
                  Code128 — barcode, name, price. Print on label sheets or
                  plain paper.
                </CardDescription>
              </div>
              <Button
                onClick={() => window.print()}
                disabled={labels.length === 0}
              >
                <Printer className="size-4" /> Print {labels.length} label(s)
              </Button>
            </div>
          </CardHeader>
          <CardContent className="print:p-0">
            {labels.length === 0 ? (
              <p className="rounded-md border border-dashed py-10 text-center text-sm text-muted-foreground print:hidden">
                Tick items on the left to preview their labels here.
              </p>
            ) : (
              /* Label sheet — what actually prints */
              <div className="thin-scrollbar grid max-h-[60vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3 print:max-h-none print:grid-cols-3 print:gap-2 print:overflow-visible">
                {labels.map((p, i) => (
                  <div
                    key={`${p.id}-${i}`}
                    className="flex flex-col items-center gap-1 rounded border border-dashed p-3 text-center print:break-inside-avoid print:rounded-none print:border-solid"
                  >
                    <BarcodeSvg value={p.barcode!} />
                    <div className="w-full truncate text-xs font-medium">
                      {p.name}
                    </div>
                    <div className="text-sm font-semibold tabular-nums">
                      {formatCentavos(p.price_centavos)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
