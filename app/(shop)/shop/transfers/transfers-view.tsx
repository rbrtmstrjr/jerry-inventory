"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  ArrowLeftRight,
  Check,
  ChevronsUpDown,
  Loader2,
  Plus,
  Printer,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { ShopBadge } from "@/components/shop-badge";
import { cancelTransfer, requestTransfer } from "../actions";
import {
  ShopReturnsPanel,
  type ShopReturn,
  type ShopReturnLine,
} from "./returns-panel";

export interface DestShop {
  id: string;
  name: string;
  color_key: string | null;
}

export interface OutgoingTransfer {
  id: string;
  from_shop_id: string;
  to_shop_id: string;
  to_shop_name: string;
  to_shop_location: string | null;
  to_shop_color_key: string | null;
  status:
    | "requested"
    | "in_transit"
    | "confirmed"
    | "discrepancy"
    | "resolved"
    | "rejected"
    | "cancelled";
  note: string | null;
  review_note: string | null;
  requested_at: string;
  approved_at: string | null;
  confirmed_at: string | null;
  resolved_at: string | null;
  line_count: number;
  qty_sent: number;
  qty_outstanding: number;
}

export interface OutgoingLine {
  id: string;
  delivery_id: string;
  from_shop_id: string;
  part_id: string | null;
  engine_id: string | null;
  name: string;
  sku: string | null;
  unit: string;
  serial_number: string | null;
  qty_sent: number;
  qty_received: number | null;
  qty_outstanding: number;
  shop_note: string | null;
}

const STATUS: Record<
  OutgoingTransfer["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  requested: { label: "Requested — waiting for Admin", variant: "secondary" },
  in_transit: { label: "Approved — in transit", variant: "default" },
  confirmed: { label: "Confirmed", variant: "default" },
  discrepancy: { label: "Discrepancy — with Admin", variant: "destructive" },
  resolved: { label: "Resolved by Admin", variant: "outline" },
  rejected: { label: "Rejected", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

// a slip only exists once Admin has approved (stock actually left)
const SLIP_STATUSES = new Set<OutgoingTransfer["status"]>([
  "in_transit",
  "confirmed",
  "discrepancy",
  "resolved",
]);

type PendingLine =
  | {
      key: string;
      kind: "part";
      part_id: string;
      name: string;
      unit: string;
      qty: number;
      onHand: number;
    }
  | { key: string; kind: "engine"; engine_id: string; label: string };

export function ShopTransfersView({
  destinations,
  stock,
  engines,
  transfers,
  lines,
  returns,
  returnLines,
}: {
  destinations: DestShop[];
  stock: ShopStockRow[];
  engines: ShopEngineRow[];
  transfers: OutgoingTransfer[];
  lines: OutgoingLine[];
  returns: ShopReturn[];
  returnLines: ShopReturnLine[];
}) {
  const router = useRouter();

  const [toShopId, setToShopId] = React.useState("");
  const [picked, setPicked] = React.useState<PendingLine[]>([]);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  // line builder state
  const [tab, setTab] = React.useState("part");
  const [partId, setPartId] = React.useState("");
  const [partOpen, setPartOpen] = React.useState(false);
  const [partQty, setPartQty] = React.useState("1");
  const [engineId, setEngineId] = React.useState("");

  const linesFor = React.useCallback(
    (id: string) => lines.filter((l) => l.delivery_id === id),
    [lines]
  );

  const REVEAL_PAGE = 10;
  const [visibleCount, setVisibleCount] = React.useState(REVEAL_PAGE);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisibleCount((n) => n + REVEAL_PAGE);
      },
      { rootMargin: "600px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleCount]);

  const usedEngineIds = new Set(
    picked.filter((l) => l.kind === "engine").map((l) => (l as { engine_id: string }).engine_id)
  );
  const availableEngines = engines.filter(
    (e) => e.status === "delivered" && !usedEngineIds.has(e.engine_id)
  );
  const part = stock.find((p) => p.part_id === partId);

  function addPart() {
    if (!part) {
      toast.error("Pick an item");
      return;
    }
    const q = parseInt(partQty || "0", 10);
    if (isNaN(q) || q <= 0) {
      toast.error("Quantity must be positive");
      return;
    }
    if (q > part.qty) {
      toast.error(`Only ${part.qty} ${part.unit} on hand`);
      return;
    }
    setPicked((prev) => {
      const existing = prev.find(
        (l) => l.kind === "part" && l.part_id === part.part_id
      ) as (PendingLine & { kind: "part" }) | undefined;
      if (existing) {
        const total = existing.qty + q;
        if (total > part.qty) {
          toast.error(`Only ${part.qty} ${part.unit} on hand`);
          return prev;
        }
        return prev.map((l) =>
          l.kind === "part" && l.part_id === part.part_id
            ? { ...l, qty: total }
            : l
        );
      }
      return [
        ...prev,
        {
          key: `part:${part.part_id}`,
          kind: "part",
          part_id: part.part_id,
          name: part.name,
          unit: part.unit,
          qty: q,
          onHand: part.qty,
        },
      ];
    });
    setPartId("");
    setPartQty("1");
  }

  function addEngine() {
    const e = engines.find((x) => x.engine_id === engineId);
    if (!e) {
      toast.error("Pick an engine");
      return;
    }
    setPicked((prev) => [
      ...prev,
      {
        key: `engine:${e.engine_id}`,
        kind: "engine",
        engine_id: e.engine_id,
        label: `${e.brand} ${e.model} — SN ${e.serial_number}`,
      },
    ]);
    setEngineId("");
  }

  function removeLine(key: string) {
    setPicked((prev) => prev.filter((l) => l.key !== key));
  }

  async function submit() {
    if (!toShopId) {
      toast.error("Pick a destination shop");
      return;
    }
    if (picked.length === 0) {
      toast.error("Add at least one item");
      return;
    }
    setBusy(true);
    const res = await requestTransfer({
      to_shop_id: toShopId,
      lines: picked.map((l) =>
        l.kind === "part"
          ? { part_id: l.part_id, qty: l.qty }
          : { engine_id: l.engine_id }
      ),
      note: note.trim() || null,
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Transfer requested — Admin will approve it before stock moves");
      setToShopId("");
      setPicked([]);
      setNote("");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Tabs defaultValue="send">
        <TabsList>
          <TabsTrigger value="send">Send to shop</TabsTrigger>
          <TabsTrigger value="return">Return to Admin</TabsTrigger>
          <TabsTrigger value="outgoing">History</TabsTrigger>
        </TabsList>

        <TabsContent value="return" className="pt-2">
          <ShopReturnsPanel
            stock={stock}
            engines={engines}
            returns={returns}
            lines={returnLines}
          />
        </TabsContent>

        {/* ── Send form ───────────────────────────────────────────────── */}
        <TabsContent value="send" className="flex flex-col gap-3 pt-2">
          {destinations.length === 0 ? (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              There are no other shops to transfer to.
            </p>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ArrowLeftRight className="size-4" /> New transfer
                </CardTitle>
                <CardDescription>
                  Pick where it goes and add items from your own stock. Nothing
                  moves until Admin approves.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="grid min-w-0 gap-2">
                  <Label>Send to</Label>
                  <Select value={toShopId} onValueChange={setToShopId}>
                    <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                      <SelectValue placeholder="Pick a destination shop" />
                    </SelectTrigger>
                    <SelectContent>
                      {destinations.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <Tabs value={tab} onValueChange={setTab}>
                  <TabsList>
                    <TabsTrigger value="part">Part / goods</TabsTrigger>
                    <TabsTrigger value="engine">Engine</TabsTrigger>
                  </TabsList>
                  <TabsContent value="part" className="flex flex-col gap-3 pt-3">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="grid min-w-0 flex-1 gap-2">
                        <Label>Item</Label>
                        <Popover open={partOpen} onOpenChange={setPartOpen}>
                          <PopoverTrigger asChild>
                            <Button
                              variant="outline"
                              role="combobox"
                              className="justify-between font-normal"
                            >
                              <span className="truncate">
                                {part ? part.name : "Pick from your stock…"}
                              </span>
                              <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-96 p-0" align="start">
                            <Command>
                              <CommandInput placeholder="Search…" />
                              <CommandList>
                                <CommandEmpty>Nothing in stock.</CommandEmpty>
                                <CommandGroup>
                                  {stock
                                    .filter((p) => p.qty > 0)
                                    .map((p) => (
                                      <CommandItem
                                        key={p.part_id}
                                        value={`${p.name} ${p.barcode ?? ""}`}
                                        onSelect={() => {
                                          setPartId(p.part_id);
                                          setPartOpen(false);
                                        }}
                                      >
                                        <Check
                                          className={cn(
                                            "size-4",
                                            p.part_id === partId
                                              ? "opacity-100"
                                              : "opacity-0"
                                          )}
                                        />
                                        <span className="flex-1">{p.name}</span>
                                        <span className="text-xs text-muted-foreground">
                                          {p.qty} {p.unit}
                                        </span>
                                      </CommandItem>
                                    ))}
                                </CommandGroup>
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </div>
                      <div className="grid gap-2">
                        <Label htmlFor="tx-qty">Qty</Label>
                        <Input
                          id="tx-qty"
                          inputMode="numeric"
                          max={part?.qty}
                          className="w-24 tabular-nums"
                          value={partQty}
                          onChange={(e) => {
                            const digits = e.target.value.replace(/\D/g, "");
                            // clamp to what's on hand once an item is picked
                            if (digits === "" || !part) return setPartQty(digits);
                            setPartQty(String(Math.min(parseInt(digits, 10), part.qty)));
                          }}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={addPart}
                        disabled={!part || (parseInt(partQty || "0", 10) || 0) <= 0}
                      >
                        <Plus className="size-4" /> Add
                      </Button>
                    </div>
                    {part && (
                      <p className="text-xs text-muted-foreground">
                        {part.qty} {part.unit} on hand
                      </p>
                    )}
                  </TabsContent>
                  <TabsContent value="engine" className="flex flex-col gap-3 pt-3">
                    <div className="flex flex-wrap items-end gap-2">
                      <div className="grid min-w-0 flex-1 gap-2">
                        <Label>Engine</Label>
                        <Select
                          value={engineId}
                          onValueChange={setEngineId}
                          disabled={availableEngines.length === 0}
                        >
                          <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                            <SelectValue
                              placeholder={
                                availableEngines.length === 0
                                  ? "No engines at your shop"
                                  : "Pick an engine at your shop"
                              }
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {availableEngines.map((e) => (
                              <SelectItem key={e.engine_id} value={e.engine_id}>
                                {e.brand} {e.model} — SN {e.serial_number}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        onClick={addEngine}
                        disabled={!engineId}
                      >
                        <Plus className="size-4" /> Add
                      </Button>
                    </div>
                  </TabsContent>
                </Tabs>

                {picked.length > 0 && (
                  <div className="flex flex-col gap-2 rounded-md border p-3">
                    <div className="text-xs font-medium text-muted-foreground">
                      {picked.length} item{picked.length === 1 ? "" : "s"} to send
                    </div>
                    {picked.map((l) => (
                      <div
                        key={l.key}
                        className="flex items-center gap-2 rounded-md border px-3 py-2"
                      >
                        {l.kind === "engine" && (
                          <Badge variant="secondary">Engine</Badge>
                        )}
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">
                          {l.kind === "part" ? l.name : l.label}
                        </span>
                        {l.kind === "part" && (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            × {l.qty} {l.unit}
                          </span>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="Remove"
                          onClick={() => removeLine(l.key)}
                        >
                          <Trash2 className="size-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="grid gap-2">
                  <Label htmlFor="tx-note">Note (optional)</Label>
                  <Textarea
                    id="tx-note"
                    rows={2}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    placeholder="e.g. hiniram ng Branch 2 kanina"
                  />
                </div>

                <Button
                  onClick={submit}
                  disabled={busy || picked.length === 0 || !toShopId}
                  className="self-end"
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Request transfer
                </Button>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── Outgoing list ───────────────────────────────────────────── */}
        <TabsContent value="outgoing" className="flex flex-col gap-3 pt-2">
          {transfers.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              You haven&apos;t sent any transfers yet.
            </p>
          )}
          {transfers.slice(0, visibleCount).map((t) => (
            <TransferCard key={t.id} transfer={t} lines={linesFor(t.id)} />
          ))}
          {visibleCount < transfers.length && (
            <div
              ref={sentinelRef}
              className="py-2 text-center text-xs text-muted-foreground"
            >
              Loading more… ({Math.min(visibleCount, transfers.length)} of{" "}
              {transfers.length})
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function TransferCard({
  transfer,
  lines,
}: {
  transfer: OutgoingTransfer;
  lines: OutgoingLine[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  const s = STATUS[transfer.status];

  async function onCancel() {
    setBusy(true);
    const res = await cancelTransfer(transfer.id);
    setBusy(false);
    if (res.ok) {
      toast.success("Transfer cancelled");
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Card className={transfer.status === "discrepancy" ? "border-warning" : ""}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowLeftRight className="size-4" />
            {transfer.line_count} item{transfer.line_count === 1 ? "" : "s"} to{" "}
            <ShopBadge
              shop={{
                name: transfer.to_shop_name,
                color_key: transfer.to_shop_color_key,
              }}
            />
          </CardTitle>
          <Badge variant={s.variant}>{s.label}</Badge>
        </div>
        <CardDescription>
          Requested {format(new Date(transfer.requested_at), "MMM d, yyyy h:mm a")}
          {transfer.approved_at &&
            ` · approved ${format(new Date(transfer.approved_at), "MMM d, h:mm a")}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm">
        {lines.map((l) => (
          <div key={l.id} className="flex flex-col">
            <div className="flex justify-between gap-2">
              <span className="truncate">
                {l.engine_id && (
                  <Badge variant="secondary" className="mr-1">
                    Engine
                  </Badge>
                )}
                {l.name}
                {l.serial_number && (
                  <span className="ml-1 font-mono text-xs text-muted-foreground">
                    SN {l.serial_number}
                  </span>
                )}
              </span>
              <span className="tabular-nums text-xs text-muted-foreground">
                × {l.qty_sent} {l.unit}
              </span>
            </div>
          </div>
        ))}

        {transfer.note && (
          <p className="mt-1 text-xs text-muted-foreground">
            Your note: {transfer.note}
          </p>
        )}
        {transfer.status === "rejected" && transfer.review_note && (
          <p className="mt-1 rounded-md bg-destructive/10 p-2 text-xs text-destructive">
            Admin: {transfer.review_note}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          {transfer.status === "requested" && (
            <Button
              variant="outline"
              size="sm"
              onClick={onCancel}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <X className="size-4" />
              )}
              Cancel
            </Button>
          )}
          {SLIP_STATUSES.has(transfer.status) && (
            <Button variant="outline" size="sm" asChild>
              <a
                href={`/transfer/${transfer.id}/slip`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Printer className="size-4" /> Print slip
              </a>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
