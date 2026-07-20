"use client";

import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Printer } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/date-picker";
import { ShopBadge } from "@/components/shop-badge";
import type { StockCardRow } from "./types";

const phDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila", year: "numeric", month: "short", day: "2-digit",
  });

export function StockCardView({
  from, to, partId, shopParam, parts, shops, rows, liveQty, today,
}: {
  from: string;
  to: string;
  partId: string | null;
  shopParam: string | null;
  parts: { id: string; name: string; sku: string | null; unit: string }[];
  shops: { id: string; name: string; color_key: string | null; closed: boolean }[];
  rows: StockCardRow[];
  liveQty: number | null;
  today: string;
}) {
  const router = useRouter();

  function apply(next: { part?: string; shop?: string; from?: string; to?: string }) {
    const p = new URLSearchParams({ tab: "ledger" });
    p.set("from", next.from ?? from);
    p.set("to", next.to ?? to);
    const part = next.part ?? partId;
    const shop = next.shop ?? shopParam ?? "master";
    if (part) p.set("part", part);
    p.set("shop", shop);
    router.push(`/movements?${p.toString()}`);
  }

  const part = parts.find((p) => p.id === partId) ?? null;
  const locShop =
    shopParam && shopParam !== "master"
      ? shops.find((s) => s.id === shopParam) ?? null
      : null;
  const opening = rows.find((r) => r.kind === "opening") ?? null;
  const moves = rows.filter((r) => r.kind === "movement");
  const closing = moves.length ? moves[moves.length - 1].balance : (opening?.balance ?? 0);

  // The card's closing balance is only meant to equal live stock when the
  // period runs to today. Say which case the reader is looking at rather than
  // showing a red flag for a historical card that is perfectly correct.
  const endsToday = to >= today;
  const reconciles = liveQty !== null && Number(closing) === Number(liveQty);

  return (
    <div className="flex flex-col gap-4">
      <Card className="print:hidden">
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-2 lg:grid-cols-4">
          <div className="grid gap-1">
            <Label className="text-xs">Product</Label>
            <Select value={partId ?? ""} onValueChange={(v) => apply({ part: v })}>
              <SelectTrigger><SelectValue placeholder="Pick a product" /></SelectTrigger>
              <SelectContent>
                {parts.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}{p.sku ? ` · ${p.sku}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Location</Label>
            <Select value={shopParam ?? "master"} onValueChange={(v) => apply({ shop: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="master">Master</SelectItem>
                {shops.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}{s.closed ? " (closed)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="sc-from" className="text-xs">From</Label>
            <DatePicker id="sc-from" value={from} onChange={(v) => apply({ from: v })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="sc-to" className="text-xs">To</Label>
            <DatePicker id="sc-to" value={to} onChange={(v) => apply({ to: v })} />
          </div>
        </CardContent>
      </Card>

      {!partId ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Pick a product to see its stock card.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="flex-row items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">
                {part?.name}
                {part?.sku && (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{part.sku}</span>
                )}
              </CardTitle>
              <CardDescription>
                {shopParam && shopParam !== "master" ? (
                  locShop && <ShopBadge variant="text" shop={locShop} />
                ) : (
                  "Master"
                )}{" "}
                · {from} to {to}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/movements/stock-card/print?part=${partId}&shop=${shopParam ?? "master"}&from=${from}&to=${to}`}
                target="_blank"
                rel="noreferrer"
              >
                <Printer className="size-4" /> Print
              </a>
            </Button>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                    <th className="py-2 font-medium">Date</th>
                    <th className="py-2 font-medium">Reference</th>
                    <th className="py-2 font-medium">Particulars</th>
                    <th className="py-2 text-right font-medium">In</th>
                    <th className="py-2 text-right font-medium">Out</th>
                    <th className="py-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Without this row a filtered card starts from a lie. */}
                  <tr className="border-b bg-muted/40 font-medium">
                    <td className="py-2.5" colSpan={3}>Opening balance</td>
                    <td /><td />
                    <td className="py-2.5 text-right tabular-nums">{opening?.balance ?? 0}</td>
                  </tr>

                  {moves.map((r) => (
                    <tr key={r.movement_id} className="border-b">
                      <td className="whitespace-nowrap py-2.5 text-muted-foreground">
                        {phDate(r.created_at)}
                      </td>
                      <td className="py-2.5 font-mono text-xs">{r.reference ?? "—"}</td>
                      <td className="py-2.5">{r.particulars}</td>
                      <td className="py-2.5 text-right tabular-nums">
                        {r.qty_in ? r.qty_in : ""}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">
                        {r.qty_out ? r.qty_out : ""}
                      </td>
                      <td className="py-2.5 text-right font-medium tabular-nums">{r.balance}</td>
                    </tr>
                  ))}

                  {moves.length === 0 && (
                    <tr className="border-b">
                      <td colSpan={6} className="py-8 text-center text-muted-foreground">
                        No movements in this period. The opening balance carried straight through.
                      </td>
                    </tr>
                  )}

                  <tr className="border-t-2 font-semibold">
                    <td className="py-2.5" colSpan={3}>Closing balance</td>
                    <td /><td />
                    <td className="py-2.5 text-right text-lg tabular-nums">{closing}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {liveQty !== null && (
              endsToday ? (
                reconciles ? (
                  <Alert className="mt-4">
                    <Check className="size-4" />
                    <AlertDescription>
                      Closing balance matches on-hand stock ({liveQty} {part?.unit ?? "unit"}
                      {liveQty === 1 ? "" : "s"}). The book agrees with the shelf.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <Alert variant="destructive" className="mt-4">
                    <AlertTriangle className="size-4" />
                    <AlertDescription>
                      Closing balance is {closing} but on-hand stock says {liveQty}. Every
                      movement is recorded through the ledger, so these should never
                      differ — treat this as a bug, not a counting error.
                    </AlertDescription>
                  </Alert>
                )
              ) : (
                <p className="mt-4 text-xs text-muted-foreground">
                  This period ends in the past, so the closing balance is the balance
                  as of {to} — not today&apos;s stock (currently {liveQty}).
                </p>
              )
            )}

            <p className="mt-3 text-xs text-muted-foreground">
              Stock lost in transit never reached this location, so it is not on this
              card. It appears in the Journal under &quot;In transit&quot;.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
