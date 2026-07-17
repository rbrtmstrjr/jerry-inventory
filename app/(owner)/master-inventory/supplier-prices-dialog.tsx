"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import { BadgeCheck, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { setPreferredSupplier } from "./actions";

/** One row of supplier_price_comparison for a single product. */
export interface ComparisonRow {
  supplier_id: string;
  supplier_name: string;
  part_id: string | null;
  engine_model_id: string | null;
  last_paid_centavos: number | null;
  last_paid_at: string | null;
  receiving_id: string | null;
  quote_centavos: number | null;
  quoted_at: string | null;
  quote_stale: boolean;
  effective_centavos: number | null;
  effective_source: "paid" | "quote" | "stale_quote";
  effective_as_of: string | null;
  is_preferred: boolean;
  is_cheapest: boolean;
}

/** Provenance rule: every price carries its source + date — never a bare number. */
export function provenanceLabel(r: ComparisonRow): string {
  const d = r.effective_as_of
    ? format(new Date(r.effective_as_of), "MMM d, yyyy")
    : "?";
  switch (r.effective_source) {
    case "paid":
      return `Paid · ${d}`;
    case "quote":
      return `Quoted · ${d}`;
    case "stale_quote":
      return `Quoted · ${d} (stale)`;
  }
}

/**
 * Every supplier this product has been bought from (or quoted by): last-paid
 * with date + receiving link, quotes with stale flags, cheapest marked, and
 * the preferred supplier changeable in place.
 */
export function SupplierPricesDialog({
  open,
  productName,
  partId,
  rows,
  onClose,
}: {
  open: boolean;
  productName: string;
  partId: string | null;
  rows: ComparisonRow[];
  onClose: () => void;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);

  async function makePreferred(supplierId: string) {
    if (!partId) return;
    setBusy(supplierId);
    const res = await setPreferredSupplier(partId, supplierId);
    setBusy(null);
    if (res.ok) toast.success("Preferred supplier updated");
    else toast.error(res.error);
  }

  const sorted = [...rows].sort(
    (a, b) => (a.effective_centavos ?? Infinity) - (b.effective_centavos ?? Infinity)
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Suppliers &amp; Prices — {productName}</DialogTitle>
          <DialogDescription>
            Same product, different suppliers. Every price shows where it came
            from and when — a paid price and a quote are not the same thing.
          </DialogDescription>
        </DialogHeader>

        {sorted.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No purchases or quotes for this product yet — prices appear here
            after the first receiving, or record a quote on{" "}
            <Link className="underline" href="/suppliers?tab=comparison">
              Suppliers → Price Comparison
            </Link>
            .
          </p>
        ) : (
          <div className="thin-scrollbar max-h-[55vh] overflow-auto rounded-md border">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>Supplier</TableHead>
                  <TableHead className="text-right">Price</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Last paid</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r) => (
                  <TableRow key={r.supplier_id}>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{r.supplier_name}</span>
                        {r.is_cheapest && <Badge>Cheapest</Badge>}
                        {r.is_preferred && (
                          <Badge variant="secondary">
                            <BadgeCheck className="size-3" /> Preferred
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-medium tabular-nums">
                      {r.effective_centavos != null
                        ? formatCentavos(r.effective_centavos)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {provenanceLabel(r)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {r.last_paid_centavos != null && r.last_paid_at ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="tabular-nums">
                            {formatCentavos(r.last_paid_centavos)}
                          </span>{" "}
                          · {format(new Date(r.last_paid_at), "MMM d, yyyy")}
                          {r.receiving_id && (
                            <Link
                              href={`/suppliers?tab=receiving&view=${r.receiving_id}`}
                              className="text-muted-foreground hover:text-foreground"
                              aria-label="Open the receiving"
                            >
                              <ExternalLink className="size-3.5" />
                            </Link>
                          )}
                        </span>
                      ) : (
                        "never"
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!r.is_preferred && partId && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => makePreferred(r.supplier_id)}
                        >
                          {busy === r.supplier_id && (
                            <Loader2 className="size-4 animate-spin" />
                          )}
                          Make preferred
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
