"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Search } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/date-picker";
import type { JournalRow } from "./types";

const TYPES = [
  "received", "delivery", "return", "sale", "loss",
  "transit_return", "transit_writeoff", "correction",
] as const;

const TYPE_LABEL: Record<string, string> = {
  received: "Received",
  delivery: "Delivery",
  return: "Return",
  sale: "Sale",
  loss: "Loss",
  transit_return: "Transit return",
  transit_writeoff: "Transit write-off",
  correction: "Correction",
};

/** In and out read differently; the badge shouldn't have to be read twice. */
function typeVariant(t: string): "default" | "secondary" | "destructive" | "outline" {
  if (t === "sale" || t === "loss" || t === "transit_writeoff") return "destructive";
  if (t === "received" || t === "transit_return") return "default";
  return "secondary";
}

const phDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    dateStyle: "medium",
    timeStyle: "short",
  });

/** Where the movement came from. Every row is traceable to a document. */
function sourceLink(r: JournalRow): { href: string; label: string } | null {
  if (r.sale_id) return { href: `/approvals?item=sale:${r.sale_id}`, label: r.receipt_no ?? "Sale" };
  if (r.loss_id) return { href: `/approvals?item=loss:${r.loss_id}`, label: "Loss" };
  if (r.delivery_id) return { href: `/deliveries/${r.delivery_id}/note`, label: "Delivery note" };
  if (r.receiving_id) return { href: `/master-inventory/receiving`, label: "Receiving" };
  if (r.return_id) return { href: `/deliveries?tab=return`, label: "Return" };
  return null;
}

export function JournalView({
  rows, total, page, pageSize, filters, shops, parts, actors,
}: {
  rows: JournalRow[];
  total: number;
  page: number;
  pageSize: number;
  filters: {
    from: string; to: string; location: string; type: string;
    product: string; actor: string; q: string;
  };
  shops: { id: string; name: string }[];
  parts: { id: string; name: string }[];
  actors: { id: string; full_name: string | null }[];
}) {
  const router = useRouter();
  const [q, setQ] = React.useState(filters.q);

  /** Any filter change resets to page 1 — page 3 of a new filter is nonsense. */
  function apply(next: Partial<typeof filters> & { page?: number }) {
    const merged = { ...filters, ...next };
    const p = new URLSearchParams({ tab: "journal" });
    p.set("from", merged.from);
    p.set("to", merged.to);
    if (merged.location !== "all") p.set("location", merged.location);
    if (merged.type !== "all") p.set("type", merged.type);
    if (merged.product) p.set("product", merged.product);
    if (merged.actor !== "all") p.set("actor", merged.actor);
    if (merged.q) p.set("q", merged.q);
    if (next.page && next.page > 1) p.set("page", String(next.page));
    router.push(`/movements?${p.toString()}`);
  }

  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const firstRow = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1">
            <Label htmlFor="mv-from" className="text-xs">From</Label>
            <DatePicker id="mv-from" value={filters.from} onChange={(v) => apply({ from: v })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="mv-to" className="text-xs">To</Label>
            <DatePicker id="mv-to" value={filters.to} onChange={(v) => apply({ to: v })} />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Location</Label>
            <Select value={filters.location} onValueChange={(v) => apply({ location: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All locations</SelectItem>
                <SelectItem value="master">Master</SelectItem>
                {shops.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
                <SelectItem value="transit">In transit</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Type</Label>
            <Select value={filters.type} onValueChange={(v) => apply({ type: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{TYPE_LABEL[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Product</Label>
            <Select value={filters.product || "all"} onValueChange={(v) => apply({ product: v === "all" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="All products" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All products</SelectItem>
                {parts.map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Actor</Label>
            <Select value={filters.actor} onValueChange={(v) => apply({ actor: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Anyone</SelectItem>
                {actors.map((a) => (
                  <SelectItem key={a.id} value={a.id}>{a.full_name ?? "—"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1 sm:col-span-2">
            <Label htmlFor="mv-q" className="text-xs">Search</Label>
            <form
              onSubmit={(e) => { e.preventDefault(); apply({ q }); }}
              className="flex gap-2"
            >
              <Input
                id="mv-q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Product, serial, receipt no, note…"
              />
              <Button type="submit" variant="outline" size="icon">
                <Search className="size-4" />
              </Button>
            </form>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="py-2 font-medium">When</th>
                  <th className="py-2 font-medium">Location</th>
                  <th className="py-2 font-medium">Product</th>
                  <th className="py-2 font-medium">Type</th>
                  <th className="py-2 text-right font-medium">In</th>
                  <th className="py-2 text-right font-medium">Out</th>
                  <th className="py-2 font-medium">Reference</th>
                  <th className="py-2 font-medium">Actor</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-10 text-center text-muted-foreground">
                      No movements match these filters.
                    </td>
                  </tr>
                )}
                {rows.map((r) => {
                  const src = sourceLink(r);
                  return (
                    <tr key={r.id} className="border-b">
                      <td className="whitespace-nowrap py-2.5 text-muted-foreground">
                        {phDateTime(r.created_at)}
                      </td>
                      <td className="py-2.5">
                        {r.location_label}
                        {r.location_kind === "transit" && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            (never reached a shop)
                          </span>
                        )}
                      </td>
                      <td className="py-2.5">
                        {r.serial_number ? (
                          <Link
                            href={`/movements?tab=engines&serial=${encodeURIComponent(r.serial_number)}`}
                            className="font-mono text-xs underline-offset-4 hover:underline"
                          >
                            {r.serial_number}
                          </Link>
                        ) : (
                          <Link
                            href={`/movements?tab=ledger&part=${r.part_id}&shop=${r.shop_id ?? "master"}`}
                            className="underline-offset-4 hover:underline"
                          >
                            {r.product_name}
                          </Link>
                        )}
                        {r.reason && (
                          <span className="ml-2 text-xs text-muted-foreground">{r.reason}</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <Badge variant={typeVariant(r.movement_type)}>
                          {TYPE_LABEL[r.movement_type] ?? r.movement_type}
                        </Badge>
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {r.qty_in > 0 ? r.qty_in : ""}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {r.qty_out > 0 ? r.qty_out : ""}
                      </td>
                      <td className="py-2.5">
                        {src ? (
                          <Link href={src.href} className="text-xs underline-offset-4 hover:underline">
                            {src.label}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="py-2.5 text-xs text-muted-foreground">
                        {r.actor_name ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Server-side paging: the ledger is append-only and unbounded. */}
          <div className="mt-4 flex items-center justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              {total === 0 ? "No rows" : `${firstRow}–${lastRow} of ${total}`}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline" size="sm"
                disabled={page <= 1}
                onClick={() => apply({ page: page - 1 })}
              >
                <ChevronLeft className="size-4" /> Previous
              </Button>
              <span className="text-xs text-muted-foreground">
                Page {page} of {lastPage}
              </span>
              <Button
                variant="outline" size="sm"
                disabled={page >= lastPage}
                onClick={() => apply({ page: page + 1 })}
              >
                Next <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
