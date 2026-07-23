"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  AlertTriangle,
  Loader2,
  PackagePlus,
  Plus,
  Search,
  Send,
  Truck,
  X,
} from "lucide-react";
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
import { TabCountBadge } from "@/components/ui/tab-count-badge";
import { createDeliveryRequest } from "../actions";

export interface MyRequestRow {
  id: string;
  status: "open" | "fulfilled" | "dismissed";
  note: string | null;
  owner_note: string | null;
  created_at: string;
  fulfilled_at: string | null;
  items: { qty: number; name: string; is_custom?: boolean }[];
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
  const [tab, setTab] = React.useState("low");
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
  // custom / new products a customer asked for that the shop doesn't carry yet
  const nextCustomId = React.useRef(0);
  const [custom, setCustom] = React.useState<
    { id: number; name: string; qty: string }[]
  >([]);

  const q = search.trim().toLowerCase();
  const shown = q ? rows.filter((r) => r.name.toLowerCase().includes(q)) : rows;
  const selectedCount = rows.filter((r) => checked.has(keyOf(r))).length;
  const customFilled = custom.filter((c) => c.name.trim().length > 0);
  const totalToRequest = selectedCount + customFilled.length;

  function addCustom() {
    setCustom((c) => [
      ...c,
      { id: nextCustomId.current++, name: "", qty: "1" },
    ]);
  }
  function removeCustom(id: number) {
    setCustom((c) => c.filter((x) => x.id !== id));
  }
  function patchCustom(id: number, patch: Partial<{ name: string; qty: string }>) {
    setCustom((c) => c.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  }

  function toggle(k: string) {
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }

  async function submit() {
    const lowLines = rows
      .filter((r) => checked.has(keyOf(r)))
      .map((r) => {
        const qty = parseInt(picked[keyOf(r)] || "0", 10);
        return {
          part_id: r.kind === "part" ? r.product_id : null,
          engine_model_id: r.kind === "engine_model" ? r.product_id : null,
          custom_name: null as string | null,
          qty_requested: qty,
        };
      });
    // new products the shop doesn't carry — free-text name, no catalog id
    const customLines = customFilled.map((c) => ({
      part_id: null,
      engine_model_id: null,
      custom_name: c.name.trim(),
      qty_requested: parseInt(c.qty || "0", 10),
    }));
    const lines = [...lowLines, ...customLines];

    if (lines.length === 0) {
      toast.error("Tick an item or add a new product to request");
      return;
    }
    if (lines.some((l) => !l.qty_requested || l.qty_requested <= 0)) {
      toast.error("Every requested item needs a quantity");
      return;
    }

    setBusy(true);
    const res = await createDeliveryRequest({ lines, note: note.trim() || null });
    setBusy(false);
    if (res.ok) {
      toast.success("Request sent to Admin");
      setNote("");
      setCustom([]);
      setTab("requests"); // jump to My requests so they see it land
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="low">
            Low items<TabCountBadge count={rows.length} />
          </TabsTrigger>
          <TabsTrigger value="requests">
            My requests<TabCountBadge count={requests.length} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="low" className="flex flex-col gap-3 pt-2">
          {rows.length > 0 && (
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
          )}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="size-4" /> Request a delivery
              </CardTitle>
              <CardDescription>
                Ticked items are sent to Admin as one request. Quantities are
                pre-filled to cover the shortfall — change them if you want more.
                Need something you don&apos;t carry? Add it below.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {rows.length === 0 ? (
                <p className="rounded-md border border-dashed py-6 text-center text-sm text-muted-foreground">
                  Nothing is low right now — your shop is well stocked. You can
                  still request a new product below.
                </p>
              ) : (
                <>
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
                </>
              )}

              {/* New / custom products — a customer asked for something the shop
                  doesn't carry yet. Admin adds it (via Receiving) then delivers. */}
              <div className="mt-1 grid gap-2 rounded-md border border-dashed bg-muted/30 p-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <PackagePlus className="size-4" /> New product request
                  </div>
                  <Button variant="outline" size="sm" onClick={addCustom}>
                    <Plus className="size-3.5" /> Add product
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  For something a customer wants that isn&apos;t in your stock
                  yet — Admin adds it to the catalog, then delivers.
                </p>
                {custom.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <Input
                      value={c.name}
                      onChange={(e) => patchCustom(c.id, { name: e.target.value })}
                      placeholder="Product name (e.g. Yamaha 40HP water pump kit)"
                      className="flex-1"
                      aria-label="New product name"
                    />
                    <Input
                      value={c.qty}
                      inputMode="numeric"
                      onChange={(e) =>
                        patchCustom(c.id, { qty: e.target.value.replace(/\D/g, "") })
                      }
                      className="w-20 tabular-nums"
                      aria-label="Quantity"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCustom(c.id)}
                      aria-label="Remove"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>

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
                disabled={busy || totalToRequest === 0}
                className="self-end"
              >
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                Request {totalToRequest} item{totalToRequest === 1 ? "" : "s"}
              </Button>
            </CardContent>
          </Card>
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
                  <div key={idx} className="flex justify-between gap-2">
                    <span className="truncate">
                      {i.is_custom && (
                        <Badge
                          variant="outline"
                          className="mr-1 border-primary text-primary"
                        >
                          New
                        </Badge>
                      )}
                      {i.name}
                    </span>
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
