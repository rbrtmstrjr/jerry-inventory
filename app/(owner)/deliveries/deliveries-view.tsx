"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronsUpDown,
  FileText,
  Loader2,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { TabCountBadge } from "@/components/ui/tab-count-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable } from "@/components/data-table/data-table";
import { ShopBadge } from "@/components/shop-badge";
import type {
  DeliveryPrefill,
  DiscrepancyRow,
  EngineOption,
  MasterPartOption,
  TransferHistoryRow,
  TransferRow,
} from "./page";
import { deliverStock, returnStock } from "./actions";
import { TransitBanner, TransitPanel } from "./transit-panel";
// Delivery requests moved to Stock Alerts; fulfilling one still creates a
// delivery here, so the action stays reachable.
import { fulfillDeliveryRequest } from "../stock-alerts/request-actions";
import { TransfersPanel, type ReturnRequestRow } from "./transfers-panel";

const TAB_VALUES = ["delivery", "transit", "transfers"] as const;
type TabValue = (typeof TAB_VALUES)[number];

const DELIVERY_STATUS: Record<
  NonNullable<TransferHistoryRow["status"]>,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  in_transit: { label: "In transit", variant: "secondary" },
  confirmed: { label: "Confirmed", variant: "default" },
  discrepancy: { label: "Discrepancy", variant: "destructive" },
  resolved: { label: "Resolved", variant: "outline" },
};

interface PartLine {
  part_id: string;
  qty: string;
  // return mode only: how many of the returned units are damaged (written off)
  damaged?: string;
}

interface ItemOption {
  part_id: string;
  name: string;
  unit: string;
  available: number;
  hint?: string;
}

function ItemCombobox({
  options,
  value,
  onChange,
  placeholder = "Pick item…",
}: {
  options: ItemOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = options.find((o) => o.part_id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">{selected ? selected.name : placeholder}</span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>Nothing available.</CommandEmpty>
            <CommandGroup>
              {options.map((o) => (
                <CommandItem
                  key={o.part_id}
                  value={`${o.name} ${o.hint ?? ""}`}
                  onSelect={() => {
                    onChange(o.part_id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "size-4",
                      o.part_id === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex-1">
                    <div className="text-sm">{o.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {o.available} {o.unit} available
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function EnginePicker({
  engines,
  selected,
  onToggle,
}: {
  engines: EngineOption[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" className="justify-between font-normal">
          {selected.size > 0
            ? `${selected.size} engine(s) selected`
            : "Pick engines…"}
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search serial or model…" />
          <CommandList>
            <CommandEmpty>No engines available.</CommandEmpty>
            <CommandGroup>
              {engines.map((e) => (
                <CommandItem
                  key={e.id}
                  value={e.label}
                  onSelect={() => onToggle(e.id)}
                >
                  <Check
                    className={cn(
                      "size-4",
                      selected.has(e.id) ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="font-mono text-xs">{e.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function TransferForm({
  kind,
  shops,
  partOptionsForShop,
  engineOptionsForShop,
  onDone,
  prefill,
}: {
  kind: "delivery" | "return";
  shops: { id: string; name: string }[];
  partOptionsForShop: (shopId: string) => ItemOption[];
  engineOptionsForShop: (shopId: string) => EngineOption[];
  onDone: (id?: string) => void;
  /** set when converting a shop's delivery request */
  prefill?: DeliveryPrefill | null;
}) {
  const [shopId, setShopId] = React.useState(prefill?.shopId ?? "");
  const [note, setNote] = React.useState(prefill?.note ?? "");
  const [partLines, setPartLines] = React.useState<PartLine[]>(
    prefill?.availableParts.map((p) => ({ part_id: p.part_id, qty: p.qty })) ?? []
  );
  const [engineIds, setEngineIds] = React.useState<Set<string>>(
    () => new Set(prefill?.engineIds ?? [])
  );
  const [submitting, setSubmitting] = React.useState(false);

  const partOptions = shopId ? partOptionsForShop(shopId) : [];
  const engineOptions = shopId ? engineOptionsForShop(shopId) : [];
  // when converting a request, is there anything master can actually fulfill?
  const nothingToDeliver =
    kind === "delivery" && partLines.length === 0 && engineIds.size === 0;
  const cappedParts = (prefill?.availableParts ?? []).filter(
    (p) => p.available < p.requested
  );

  function updateLine(i: number, patch: Partial<PartLine>) {
    setPartLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function onSubmit() {
    if (!shopId) {
      toast.error("Pick a shop first");
      return;
    }

    setSubmitting(true);
    let res;
    if (kind === "delivery") {
      const parts = [];
      for (const [i, l] of partLines.entries()) {
        if (!l.part_id) { toast.error(`Line ${i + 1}: pick an item`); setSubmitting(false); return; }
        const qty = parseInt(l.qty || "0", 10);
        const opt = partOptions.find((o) => o.part_id === l.part_id);
        if (isNaN(qty) || qty <= 0) { toast.error(`Line ${i + 1}: qty must be positive`); setSubmitting(false); return; }
        if (opt && qty > opt.available) {
          toast.error(`Line ${i + 1}: only ${opt.available} ${opt.unit} available`); setSubmitting(false); return;
        }
        parts.push({ part_id: l.part_id, qty });
      }
      if (parts.length + engineIds.size === 0) { toast.error("Add at least one line"); setSubmitting(false); return; }
      res = await deliverStock({ shop_id: shopId, note: note || null, parts, engine_ids: [...engineIds] });
    } else {
      // return: each part splits good vs damaged; good + damaged ≤ on-hand
      const parts = [];
      for (const [i, l] of partLines.entries()) {
        if (!l.part_id) { toast.error(`Line ${i + 1}: pick an item`); setSubmitting(false); return; }
        const good = parseInt(l.qty || "0", 10) || 0;
        const damaged = parseInt(l.damaged || "0", 10) || 0;
        const opt = partOptions.find((o) => o.part_id === l.part_id);
        if (good + damaged <= 0) { toast.error(`Line ${i + 1}: enter a good or damaged qty`); setSubmitting(false); return; }
        if (opt && good + damaged > opt.available) {
          toast.error(`Line ${i + 1}: only ${opt.available} ${opt.unit} on hand`); setSubmitting(false); return;
        }
        parts.push({ part_id: l.part_id, qty_good: good, qty_damaged: damaged });
      }
      const engines = [...engineIds].map((id) => ({ engine_id: id, condition: "good" as const }));
      if (parts.length + engines.length === 0) { toast.error("Add at least one line"); setSubmitting(false); return; }
      res = await returnStock({ shop_id: shopId, note: note || null, parts, engines });
    }
    setSubmitting(false);

    if (res.ok) {
      if (kind === "delivery") {
        toast.success("Sent — in transit until the shop confirms what arrived");
      } else {
        const g = partLines.reduce((s, l) => s + (parseInt(l.qty || "0", 10) || 0), 0);
        const d = partLines.reduce((s, l) => s + (parseInt(l.damaged || "0", 10) || 0), 0);
        toast.success(
          d > 0
            ? `${g} good back in master · ${d} damaged written off`
            : "Returned — stock is back in master"
        );
      }
      // Converting a request: link it to this delivery and close it out. The
      // stock itself moved through the normal delivery flow above.
      if (kind === "delivery" && prefill?.requestId && res.id) {
        const link = await fulfillDeliveryRequest(prefill.requestId, res.id);
        if (link.ok) toast.success("Request marked fulfilled — the shop was told");
        else toast.error(`Delivered, but linking the request failed: ${link.error}`);
      }
      setShopId("");
      setNote("");
      setPartLines([]);
      setEngineIds(new Set());
      onDone(res.id);
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label>{kind === "delivery" ? "Deliver to shop" : "Return from shop"}</Label>
          <Select
            value={shopId}
            onValueChange={(v) => {
              setShopId(v);
              setPartLines([]);
              setEngineIds(new Set());
            }}
          >
            <SelectTrigger className="w-full max-w-full [&>span]:truncate">
              <SelectValue placeholder="Pick a shop" />
            </SelectTrigger>
            <SelectContent>
              {shops.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid min-w-0 gap-2">
          <Label htmlFor={`${kind}-note`}>
            {kind === "delivery" ? "Note (shows on delivery note)" : "Reason"}
          </Label>
          <Input
            id={`${kind}-note`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              kind === "delivery" ? "e.g. weekly restock" : "e.g. slow-mover, redistribute"
            }
          />
        </div>
      </div>

      {!shopId ? (
        <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
          Pick a shop above to start adding items.
        </p>
      ) : (
        <>
          {/* Parts */}
          <div className="rounded-lg border">
            <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
              <div>
                <h3 className="text-sm font-semibold">Parts</h3>
                <p className="text-xs text-muted-foreground">
                  {kind === "delivery"
                    ? "From master stock"
                    : "From this shop's stock"}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  setPartLines((ls) => [...ls, { part_id: "", qty: "1" }])
                }
              >
                <Plus className="size-4" /> Add part
              </Button>
            </div>

            {partLines.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No part lines yet — click “Add part”.
              </p>
            ) : (
              <div className="thin-scrollbar overflow-x-auto p-4">
                <div
                  className={cn(
                    "grid min-w-[32rem] items-center gap-x-2 gap-y-2",
                    kind === "return"
                      ? "grid-cols-[minmax(12rem,1fr)_5rem_5rem_6rem_2.25rem]"
                      : "grid-cols-[minmax(14rem,1fr)_6rem_7rem_2.25rem]"
                  )}
                >
                  <span className="text-xs font-medium text-muted-foreground">Item</span>
                  <span className="text-xs font-medium text-muted-foreground">
                    {kind === "return" ? "Good" : "Qty"}
                  </span>
                  {kind === "return" && (
                    <span className="text-xs font-medium text-muted-foreground">Damaged</span>
                  )}
                  <span className="text-xs font-medium text-muted-foreground">Available</span>
                  <span />
                  {partLines.map((l, i) => {
                    const opt = partOptions.find((o) => o.part_id === l.part_id);
                    return (
                      <React.Fragment key={i}>
                        <ItemCombobox
                          options={partOptions}
                          value={l.part_id}
                          onChange={(id) => {
                            // re-clamp qty against the newly picked item's stock
                            const next = partOptions.find((o) => o.part_id === id);
                            const q = parseInt(l.qty || "1", 10);
                            updateLine(i, {
                              part_id: id,
                              qty: String(
                                Math.max(
                                  1,
                                  Math.min(
                                    isNaN(q) ? 1 : q,
                                    next?.available ?? 1
                                  )
                                )
                              ),
                            });
                          }}
                        />
                        <Input
                          inputMode="numeric"
                          min={1}
                          max={opt?.available}
                          value={l.qty}
                          onChange={(e) => {
                            // digits only, hard-capped at what's actually available
                            const raw = e.target.value.replace(/\D/g, "");
                            if (raw === "") {
                              updateLine(i, { qty: "" });
                              return;
                            }
                            let n = parseInt(raw, 10);
                            if (opt && n > opt.available) n = opt.available;
                            updateLine(i, { qty: String(n) });
                          }}
                          onBlur={() => {
                            const n = parseInt(l.qty || "0", 10);
                            if (isNaN(n) || n < 0) updateLine(i, { qty: "0" });
                          }}
                          aria-label={kind === "return" ? "Good qty" : "Quantity"}
                        />
                        {kind === "return" && (
                          <Input
                            inputMode="numeric"
                            value={l.damaged ?? ""}
                            placeholder="0"
                            onChange={(e) => {
                              const raw = e.target.value.replace(/\D/g, "");
                              let n = parseInt(raw || "0", 10) || 0;
                              if (opt && n > opt.available) n = opt.available;
                              updateLine(i, { damaged: raw === "" ? "" : String(n) });
                            }}
                            aria-label="Damaged qty"
                            className={cn(
                              "tabular-nums",
                              (parseInt(l.damaged || "0", 10) || 0) > 0 && "border-warning"
                            )}
                          />
                        )}
                        <span className="text-sm text-muted-foreground tabular-nums">
                          {opt ? `${opt.available} ${opt.unit}` : "—"}
                        </span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove line"
                          onClick={() =>
                            setPartLines((ls) => ls.filter((_, j) => j !== i))
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Converting a request: what master can't fulfill right now */}
            {prefill && cappedParts.length > 0 && (
              <p className="border-t px-4 py-2 text-xs text-warning-foreground">
                Capped to master stock:{" "}
                {cappedParts
                  .map((p) => {
                    const opt = partOptions.find((o) => o.part_id === p.part_id);
                    return `${opt?.name ?? "item"} (requested ${p.requested}, only ${p.available} available)`;
                  })
                  .join(", ")}
                .
              </p>
            )}
            {prefill && prefill.noStockParts.length > 0 && (
              <div className="border-t px-4 py-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  No master stock — buy from a supplier first
                </p>
                <div className="flex flex-col gap-1.5">
                  {prefill.noStockParts.map((p) => (
                    <div
                      key={p.part_id}
                      className="flex items-center justify-between gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm opacity-70"
                    >
                      <span className="truncate">
                        {p.name}
                        {p.sku && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            SKU {p.sku}
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        requested {p.qty_requested}
                      </span>
                    </div>
                  ))}
                </div>
                <Button asChild variant="link" size="sm" className="mt-1 h-auto px-0">
                  <Link href="/stock-alerts/purchase-list" target="_blank">
                    Open purchase list →
                  </Link>
                </Button>
              </div>
            )}
          </div>

          {/* Engines */}
          <div className="rounded-lg border">
            <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
              <div>
                <h3 className="text-sm font-semibold">Engines</h3>
                <p className="text-xs text-muted-foreground">
                  {kind === "delivery"
                    ? "Serials in master stock"
                    : "Serials at this shop"}
                </p>
              </div>
              <EnginePicker
                engines={engineOptions}
                selected={engineIds}
                onToggle={(id) =>
                  setEngineIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(id)) next.delete(id);
                    else next.add(id);
                    return next;
                  })
                }
              />
            </div>

            {engineIds.size === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No engines selected — use “Pick engines”.
              </p>
            ) : (
              <div className="flex flex-col gap-2 p-4">
                {[...engineIds].map((id) => {
                  const e = engineOptions.find((x) => x.id === id);
                  if (!e) return null;
                  return (
                    <div
                      key={id}
                      className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                    >
                      <span className="font-mono text-sm">{e.label}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${e.serial_number}`}
                        onClick={() =>
                          setEngineIds((prev) => {
                            const next = new Set(prev);
                            next.delete(id);
                            return next;
                          })
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Converting a request: engine models master can't fulfill yet */}
            {prefill && prefill.shortEngines.length > 0 && (
              <p className="border-t px-4 py-2 text-xs text-warning-foreground">
                {prefill.shortEngines
                  .map((e) => `${e.name}: only ${e.matched} of ${e.requested} in master`)
                  .join(", ")}
                .
              </p>
            )}
            {prefill && prefill.noStockEngines.length > 0 && (
              <div className="border-t px-4 py-3">
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  No master stock
                </p>
                <div className="flex flex-col gap-1.5">
                  {prefill.noStockEngines.map((e, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm opacity-70"
                    >
                      <span className="truncate">{e.name} — none in master</span>
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        requested {e.qty_requested}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {prefill && nothingToDeliver && (
            <p className="rounded-md bg-warning/10 px-3 py-2 text-xs text-warning-foreground">
              Nothing in master to deliver yet — these items must be bought from a
              supplier first. Once master is restocked, the shop can re-request.
            </p>
          )}
          <div className="flex justify-end">
            <Button onClick={onSubmit} disabled={submitting || nothingToDeliver}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {kind === "delivery" ? "Deliver (into transit)" : "Process return"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

export function DeliveriesView({
  shops,
  masterParts,
  engines,
  history,
  transit = [],
  prefill = null,
  transfers = [],
  returns = [],
  initialTab,
}: {
  shops: { id: string; name: string }[];
  masterParts: MasterPartOption[];
  engines: EngineOption[];
  history: TransferHistoryRow[];
  transit?: DiscrepancyRow[];
  prefill?: DeliveryPrefill | null;
  transfers?: TransferRow[];
  /** Shop-requested returns awaiting approval (0065) */
  returns?: ReturnRequestRow[];
  /** Deep link (?tab=transfers|transit) */
  initialTab?: string;
}) {
  const pendingTransfers = transfers.filter((t) => t.status === "requested").length;
  const pendingReturns = returns;

  const [tab, setTab] = React.useState<TabValue>(() => {
    // A request is converted on Stock Alerts by pushing here with ?request=<id>;
    // the server returns the prefill, and we land on New Delivery.
    if (prefill) return "delivery";
    if (initialTab && TAB_VALUES.includes(initialTab as TabValue)) {
      return initialTab as TabValue;
    }
    if (transit.some((t) => t.status === "discrepancy")) return "transit";
    return "delivery";
  });

  const sortedHistory = [...history].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
  );

  const columns: ColumnDef<TransferHistoryRow>[] = [
    {
      accessorKey: "kind",
      header: "Type",
      cell: ({ row }) =>
        row.original.kind === "delivery" ? (
          <Badge className="gap-1">
            <ArrowUpRight className="size-3" /> Delivery
          </Badge>
        ) : (
          <Badge variant="secondary" className="gap-1">
            <ArrowDownLeft className="size-3" /> Return
          </Badge>
        ),
    },
    {
      accessorKey: "at",
      header: "Date",
      cell: ({ getValue }) =>
        format(new Date(getValue<string>()), "MMM d, yyyy h:mm a"),
    },
    {
      accessorKey: "shop_name",
      header: "Shop",
      cell: ({ row }) => (
        <ShopBadge
          shop={{
            name: row.original.shop_name,
            color_key: row.original.shop_color_key,
          }}
        />
      ),
    },
    {
      id: "lines",
      header: "Lines",
      cell: ({ row }) => (
        <div className="flex gap-1">
          {row.original.part_lines > 0 && (
            <Badge variant="outline">{row.original.part_lines} parts</Badge>
          )}
          {row.original.engine_lines > 0 && (
            <Badge variant="outline">{row.original.engine_lines} engines</Badge>
          )}
        </div>
      ),
    },
    {
      accessorKey: "total_qty",
      header: "Qty",
      cell: ({ getValue }) => (
        <span className="tabular-nums">{getValue<number>()}</span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const s = row.original.status;
        const meta = s ? DELIVERY_STATUS[s] : null;
        if (!meta) return <span className="text-xs text-muted-foreground">—</span>;
        return (
          <span className="flex items-center gap-1.5">
            <Badge variant={meta.variant}>{meta.label}</Badge>
            {row.original.qty_outstanding > 0 && (
              <span className="text-xs font-medium text-warning-foreground tabular-nums">
                {row.original.qty_outstanding} out
              </span>
            )}
          </span>
        );
      },
    },
    {
      accessorKey: "note",
      header: "Note",
      cell: ({ getValue }) => (
        <span className="line-clamp-1 max-w-xs text-muted-foreground">
          {getValue<string | null>() ?? "—"}
        </span>
      ),
    },
    {
      id: "doc",
      header: "",
      cell: ({ row }) =>
        row.original.kind === "delivery" ? (
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/deliveries/${row.original.id}/note`}>
              <FileText className="size-4" /> Note
            </Link>
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Deliveries &amp; Returns
        </h1>
        <p className="text-sm text-muted-foreground">
          Move stock between master and shops. Stock leaves master into transit
          and lands only once the shop confirms what actually arrived.
        </p>
      </div>

      {transit.length > 0 && <TransitBanner transit={transit} />}

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
        <TabsList>
          <TabsTrigger value="delivery">New Delivery</TabsTrigger>
          <TabsTrigger value="transit">
            In Transit
            <TabCountBadge count={transit.length} />
          </TabsTrigger>
          <TabsTrigger value="transfers">
            Transfers &amp; Returns
            <TabCountBadge count={pendingTransfers + pendingReturns.length} />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="transit" className="pt-2">
          <TransitPanel transit={transit} />
        </TabsContent>
        <TabsContent value="transfers" className="pt-2">
          <TransfersPanel transfers={transfers} returns={pendingReturns} />
        </TabsContent>
        <TabsContent value="delivery" className="pt-2">
          {prefill && (
            <div className="mb-3 flex flex-col gap-1 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
              <p className="text-sm font-medium">
                Filled in from a shop&apos;s delivery request
              </p>
              <p className="text-xs text-muted-foreground">
                Every requested item is listed below — deliverable rows on top,
                anything with no master stock shown disabled. Check the
                quantities, then deliver; the request is marked fulfilled
                automatically.
              </p>
              {prefill.noStockParts.length + prefill.noStockEngines.length > 0 && (
                <p className="mt-1 text-xs font-medium text-warning-foreground">
                  {prefill.noStockParts.length + prefill.noStockEngines.length} requested
                  item(s) have no master stock yet — buy from a supplier first.
                </p>
              )}
            </div>
          )}
          <Card>
            <CardHeader>
              <CardTitle>Admin → Shop</CardTitle>
              <CardDescription>
                Stock leaves master into transit and lands only once the shop
                confirms what arrived. A printable delivery note is generated.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TransferForm
                kind="delivery"
                prefill={prefill}
                key={prefill?.requestId ?? "new"}
                shops={shops}
                partOptionsForShop={() =>
                  masterParts.map((p) => ({
                    part_id: p.part_id,
                    name: p.name,
                    unit: p.unit,
                    available: p.master_qty,
                    hint: `${p.sku ?? ""} ${p.barcode ?? ""}`,
                  }))
                }
                engineOptionsForShop={() => engines.filter((e) => e.shop_id === null)}
                onDone={(id) => {
                  if (id) window.open(`/deliveries/${id}/note`, "_blank");
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <div>
        <h2 className="mb-2 text-lg font-semibold">History</h2>
        <DataTable
          columns={columns}
          data={sortedHistory}
          searchPlaceholder="Search history…"
          emptyMessage="No deliveries or returns yet."
        />
      </div>
    </div>
  );
}
