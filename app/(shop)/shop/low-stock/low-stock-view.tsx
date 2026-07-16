"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { AlertTriangle, Loader2, Search, Send, Truck } from "lucide-react";
import { toast } from "sonner";

import type { ShopLowStockRow } from "@/lib/db-types";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createDeliveryRequest } from "../actions";

export interface MyRequestRow {
  id: string;
  status: "open" | "fulfilled" | "dismissed";
  note: string | null;
  owner_note: string | null;
  created_at: string;
  fulfilled_at: string | null;
  items: { qty: number; name: string }[];
}

const STATUS: Record<
  MyRequestRow["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  open: { label: "Waiting for Admin", variant: "secondary" },
  fulfilled: { label: "Delivered", variant: "default" },
  dismissed: { label: "Dismissed", variant: "destructive" },
};

const keyOf = (r: ShopLowStockRow) => `${r.kind}:${r.product_id}`;

export function ShopLowStockView({
  rows,
  requests,
}: {
  rows: ShopLowStockRow[];
  requests: MyRequestRow[];
}) {
  const router = useRouter();
  const [search, setSearch] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  // pre-checked from the low list, with a suggested qty
  const [picked, setPicked] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      rows.map((r) => [keyOf(r), String(Math.max(1, r.shortfall || 1))])
    )
  );
  const [checked, setChecked] = React.useState<Set<string>>(
    () => new Set(rows.map(keyOf))
  );

  const q = search.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  const selectedCount = rows.filter((r) => checked.has(keyOf(r))).length;

  function toggle(k: string) {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }

  async function submit() {
    const lines = rows
      .filter((r) => checked.has(keyOf(r)))
      .map((r) => {
        const qty = parseInt(picked[keyOf(r)] || "0", 10);
        return {
          part_id: r.kind === "part" ? r.product_id : null,
          engine_model_id: r.kind === "engine_model" ? r.product_id : null,
          qty_requested: qty,
        };
      });

    if (lines.length === 0) {
      toast.error("Tick at least one item to request");
      return;
    }
    if (lines.some((l) => !l.qty_requested || l.qty_requested <= 0)) {
      toast.error("Every ticked item needs a quantity");
      return;
    }

    setBusy(true);
    const res = await createDeliveryRequest({ lines, note: note.trim() || null });
    setBusy(false);
    if (res.ok) {
      toast.success("Request sent to Admin");
      setNote("");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Low Stock</h1>
        <p className="text-sm text-muted-foreground">
          Items at or below their reorder level. Ask Admin to deliver more —
          shops don&apos;t order from suppliers.
        </p>
      </div>

      <Tabs defaultValue="low">
        <TabsList>
          <TabsTrigger value="low">Low items ({rows.length})</TabsTrigger>
          <TabsTrigger value="requests">My requests ({requests.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="low" className="flex flex-col gap-3 pt-2">
          {rows.length === 0 ? (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              Nothing is low right now — your shop is well stocked.
            </p>
          ) : (
            <>
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search item…"
                  className="pl-8"
                  aria-label="Search low stock"
                />
              </div>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <AlertTriangle className="size-4" /> Request a delivery
                  </CardTitle>
                  <CardDescription>
                    Ticked items are sent to Admin as one request. Quantities
                    are pre-filled to cover the shortfall — change them if you
                    want more.
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  {shown.map((r) => {
                    const k = keyOf(r);
                    return (
                      <div
                        key={k}
                        className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2"
                      >
                        <Checkbox
                          checked={checked.has(k)}
                          onCheckedChange={() => toggle(k)}
                          aria-label={`Request ${r.name}`}
                        />
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <Badge variant="secondary">
                            {r.kind === "part" ? "Part" : "Engine"}
                          </Badge>
                          <span className="truncate text-sm font-medium">{r.name}</span>
                        </div>
                        <span className="text-xs text-muted-foreground">
                          <span className="font-semibold text-destructive tabular-nums">
                            {r.on_hand} {r.unit}
                          </span>{" "}
                          on hand · reorder at {r.threshold}
                        </span>
                        <div className="flex items-center gap-1.5">
                          <Label htmlFor={`qty-${k}`} className="text-xs">
                            Qty
                          </Label>
                          <Input
                            id={`qty-${k}`}
                            inputMode="numeric"
                            value={picked[k] ?? ""}
                            onChange={(e) =>
                              setPicked((p) => ({
                                ...p,
                                [k]: e.target.value.replace(/\D/g, ""),
                              }))
                            }
                            className="w-20 tabular-nums"
                          />
                        </div>
                      </div>
                    );
                  })}
                  {shown.length === 0 && (
                    <p className="py-6 text-center text-sm text-muted-foreground">
                      No matches.
                    </p>
                  )}

                  <div className="grid gap-2 pt-1">
                    <Label htmlFor="req-note">Note (optional)</Label>
                    <Textarea
                      id="req-note"
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="e.g. kailangan bago mag-weekend"
                    />
                  </div>

                  <Button
                    onClick={submit}
                    disabled={busy || selectedCount === 0}
                    className="self-end"
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Send className="size-4" />
                    )}
                    Request {selectedCount} item{selectedCount === 1 ? "" : "s"}
                  </Button>
                </CardContent>
              </Card>
            </>
          )}
        </TabsContent>

        <TabsContent value="requests" className="flex flex-col gap-3 pt-2">
          {requests.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No delivery requests yet.
            </p>
          )}
          {requests.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Truck className="size-4" />
                    {r.items.length} item{r.items.length === 1 ? "" : "s"}
                  </CardTitle>
                  <Badge variant={STATUS[r.status].variant}>
                    {STATUS[r.status].label}
                  </Badge>
                </div>
                <CardDescription>
                  {format(new Date(r.created_at), "MMM d, yyyy h:mm a")}
                  {r.fulfilled_at &&
                    ` · delivered ${format(new Date(r.fulfilled_at), "MMM d, h:mm a")}`}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 text-sm">
                {r.items.map((i, idx) => (
                  <div key={idx} className="flex justify-between">
                    <span className="truncate">{i.name}</span>
                    <span className="tabular-nums">× {i.qty}</span>
                  </div>
                ))}
                {r.note && (
                  <p className="mt-1 text-xs text-muted-foreground">Your note: {r.note}</p>
                )}
                {r.owner_note && (
                  <p className="mt-1 rounded-md bg-accent p-2 text-xs text-accent-foreground">
                    Admin: {r.owner_note}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
