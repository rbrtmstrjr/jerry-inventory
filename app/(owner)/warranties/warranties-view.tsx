"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import {
  FileText,
  History,
  Loader2,
  Plus,
  Search,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { ph_today } from "@/lib/ph-date";
import type { ShopOption } from "@/lib/db-types";
import { Badge } from "@/components/ui/badge";
import { ShopBadge } from "@/components/shop-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { DatePicker } from "@/components/date-picker";
import { addClaim } from "./actions";

export interface WarrantyClaim {
  id: string;
  claim_date: string;
  issue: string;
  action_taken: string | null;
}

export interface WarrantyRow {
  id: string;
  engine_id: string;
  serial_number: string;
  model: string;
  horsepower: number | null;
  customer: string;
  customer_phone: string | null;
  shop: string | null;
  shop_color_key: string | null;
  sold_on: string;
  months: number;
  expires_on: string;
  active: boolean;
  claims: WarrantyClaim[];
}

export interface SerialRow {
  id: string;
  serial_number: string;
  model: string;
  horsepower: number | null;
  status: "in_master" | "delivered" | "sold" | "returned" | "written_off";
  shop: string | null;
  shop_color_key: string | null;
  customer: string | null;
  customer_phone: string | null;
  sold_at: string | null;
}

const SERIAL_STATUS: Record<
  SerialRow["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  in_master: { label: "In master", variant: "secondary" },
  delivered: { label: "At shop", variant: "default" },
  sold: { label: "Sold", variant: "outline" },
  returned: { label: "Returned", variant: "secondary" },
  written_off: { label: "Written off", variant: "destructive" },
};

interface Movement {
  movement_type: string;
  qty_change: number;
  shop_id: string | null;
  shop_name: string | null;
  note: string | null;
  created_at: string;
}

function daysLeft(expires_on: string, today: string): number {
  return Math.round(
    (new Date(expires_on + "T00:00:00Z").getTime() -
      new Date(today + "T00:00:00Z").getTime()) /
      86400000
  );
}

export function WarrantiesView({
  warranties,
  serials,
  today,
  shops = [],
}: {
  warranties: WarrantyRow[];
  serials: SerialRow[];
  today: string;
  shops?: ShopOption[];
}) {
  const [claimsFor, setClaimsFor] = React.useState<WarrantyRow | null>(null);
  const [journeyFor, setJourneyFor] = React.useState<SerialRow | null>(null);
  const [shopFilter, setShopFilter] = React.useState("all");

  // Slice the registry by branch — consistent with the reviewed-history filter.
  const shownWarranties =
    shopFilter === "all"
      ? warranties
      : warranties.filter((w) => w.shop === shopFilter);

  const warrantyColumns: ColumnDef<WarrantyRow>[] = [
    {
      accessorKey: "serial_number",
      header: "Serial",
      cell: ({ getValue }) => (
        <span className="font-mono text-sm">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "model",
      header: "Model",
      cell: ({ row }) => (
        <span>
          {row.original.model}
          {row.original.horsepower != null && (
            <span className="text-muted-foreground"> — {row.original.horsepower}HP</span>
          )}
        </span>
      ),
    },
    {
      accessorKey: "customer",
      header: "Customer",
      cell: ({ row }) => (
        <div>
          <div>{row.original.customer}</div>
          {row.original.customer_phone && (
            <div className="text-xs text-muted-foreground">
              {row.original.customer_phone}
            </div>
          )}
        </div>
      ),
    },
    {
      accessorKey: "shop",
      header: ({ column }) => <SortableHeader column={column}>Sold by</SortableHeader>,
      cell: ({ row }) =>
        row.original.shop ? (
          <ShopBadge
            shop={{ name: row.original.shop, color_key: row.original.shop_color_key }}
          />
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: "sold_on",
      header: ({ column }) => <SortableHeader column={column}>Sold</SortableHeader>,
      cell: ({ row }) => (
        <div>{format(new Date(row.original.sold_on), "MMM d, yyyy")}</div>
      ),
    },
    {
      accessorKey: "expires_on",
      header: ({ column }) => <SortableHeader column={column}>Expires</SortableHeader>,
      cell: ({ row }) => {
        const d = daysLeft(row.original.expires_on, today);
        return (
          <div>
            {format(new Date(row.original.expires_on), "MMM d, yyyy")}
            <div className="text-xs">
              {row.original.active ? (
                <span className={d <= 30 ? "font-medium text-warning-foreground" : "text-muted-foreground"}>
                  {d} day{d === 1 ? "" : "s"} left
                </span>
              ) : (
                <span className="text-destructive">expired</span>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <Badge variant={row.original.active ? "default" : "destructive"}>
          {row.original.active ? "Active" : "Expired"}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setClaimsFor(row.original)}
          >
            <Wrench className="size-4" />
            Claims{row.original.claims.length > 0 && ` (${row.original.claims.length})`}
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/warranties/${row.original.id}/certificate`}>
              <FileText className="size-4" /> Certificate
            </Link>
          </Button>
        </div>
      ),
    },
  ];

  const serialColumns: ColumnDef<SerialRow>[] = [
    {
      accessorKey: "serial_number",
      header: "Serial",
      cell: ({ getValue }) => (
        <span className="font-mono text-sm">{getValue<string>()}</span>
      ),
    },
    {
      accessorKey: "model",
      header: "Model",
      cell: ({ row }) => (
        <span>
          {row.original.model}
          {row.original.horsepower != null && (
            <span className="text-muted-foreground"> — {row.original.horsepower}HP</span>
          )}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const s = SERIAL_STATUS[row.original.status];
        return (
          <div>
            <Badge variant={s.variant}>{s.label}</Badge>
            {row.original.shop && row.original.status === "delivered" && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                <ShopBadge
                  shop={{
                    name: row.original.shop,
                    color_key: row.original.shop_color_key,
                  }}
                  variant="text"
                />
              </div>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "customer",
      header: "Customer",
      cell: ({ row }) =>
        row.original.customer ? (
          <div>
            <div>{row.original.customer}</div>
            {row.original.sold_at && (
              <div className="text-xs text-muted-foreground">
                {format(new Date(row.original.sold_at), "MMM d, yyyy")}
              </div>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button variant="ghost" size="sm" onClick={() => setJourneyFor(row.original)}>
          <History className="size-4" /> Journey
        </Button>
      ),
    },
  ];

  const activeCount = warranties.filter((w) => w.active).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Warranties &amp; Serials
        </h1>
        <p className="text-sm text-muted-foreground">
          {activeCount} active warrant{activeCount === 1 ? "y" : "ies"} · search
          any serial to see who bought it, where, and when.
        </p>
      </div>

      <Tabs defaultValue="warranties">
        <TabsList>
          <TabsTrigger value="warranties">
            <ShieldCheck className="size-4" /> Warranties ({warranties.length})
          </TabsTrigger>
          <TabsTrigger value="serials">
            <Search className="size-4" /> Serial Lookup ({serials.length})
          </TabsTrigger>
        </TabsList>

        <TabsContent value="warranties" className="pt-2">
          <DataTable
            columns={warrantyColumns}
            data={shownWarranties}
            searchPlaceholder="Search serial, customer, model…"
            emptyMessage="No warranties yet — they appear automatically when you approve an engine sale."
            rowClassName={(w) =>
              !w.active
                ? "opacity-60"
                : daysLeft(w.expires_on, today) <= 30
                  ? "bg-warning/10"
                  : undefined
            }
            toolbar={
              shops.length > 0 ? (
                <Select value={shopFilter} onValueChange={setShopFilter}>
                  <SelectTrigger className="w-48">
                    <SelectValue placeholder="All shops" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All shops</SelectItem>
                    {shops.map((s) => (
                      <SelectItem key={s.id} value={s.name}>
                        <ShopBadge shop={s} variant="text" />
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null
            }
          />
        </TabsContent>

        <TabsContent value="serials" className="pt-2">
          <DataTable
            columns={serialColumns}
            data={serials}
            searchPlaceholder="Scan or type any serial…"
            emptyMessage="No engines yet."
          />
        </TabsContent>
      </Tabs>

      <ClaimsDialog warranty={claimsFor} onClose={() => setClaimsFor(null)} />
      <JourneyDialog serial={journeyFor} onClose={() => setJourneyFor(null)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Claims dialog — list + add
// ---------------------------------------------------------------------------
function ClaimsDialog({
  warranty,
  onClose,
}: {
  warranty: WarrantyRow | null;
  onClose: () => void;
}) {
  const [adding, setAdding] = React.useState(false);
  const [date, setDate] = React.useState("");
  const [issue, setIssue] = React.useState("");
  const [action, setAction] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (warranty) {
      setAdding(false);
      setDate(ph_today());
      setIssue("");
      setAction("");
    }
  }, [warranty]);

  async function onSubmit() {
    if (!warranty) return;
    setBusy(true);
    const res = await addClaim({
      warranty_id: warranty.id,
      claim_date: date,
      issue,
      action_taken: action || null,
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Claim logged");
      onClose();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={warranty !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Claims — <span className="font-mono">{warranty?.serial_number}</span>
          </DialogTitle>
          <DialogDescription>
            {warranty?.model} · {warranty?.customer}
            {warranty?.active === false && " · warranty EXPIRED"}
          </DialogDescription>
        </DialogHeader>

        <div className="flex max-h-64 flex-col gap-2 overflow-auto">
          {warranty?.claims.length === 0 && !adding && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No claims logged for this engine.
            </p>
          )}
          {warranty?.claims.map((c) => (
            <Card key={c.id}>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">
                  {format(new Date(c.claim_date), "MMM d, yyyy")} — {c.issue}
                </CardTitle>
                {c.action_taken && (
                  <CardDescription>Action: {c.action_taken}</CardDescription>
                )}
              </CardHeader>
            </Card>
          ))}
        </div>

        {adding ? (
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Label htmlFor="claim-date">Date</Label>
              <DatePicker id="claim-date" value={date} onChange={setDate} className="w-44" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="claim-issue">Issue</Label>
              <Textarea
                id="claim-issue"
                rows={2}
                value={issue}
                onChange={(e) => setIssue(e.target.value)}
                placeholder="e.g. hindi umaandar, carburetor issue"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="claim-action">Action taken (optional)</Label>
              <Textarea
                id="claim-action"
                rows={2}
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="e.g. replaced impeller, sent to Yamaha service center"
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button onClick={onSubmit} disabled={busy || issue.trim() === ""}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                Log claim
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Log claim
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Serial journey dialog — the movements ledger for one engine
// ---------------------------------------------------------------------------
const MOVE_LABEL: Record<string, string> = {
  received: "Received into master",
  delivery: "Delivery",
  return: "Return",
  sale: "Sold",
  loss: "Written off",
  correction: "Correction",
};

function JourneyDialog({
  serial,
  onClose,
}: {
  serial: SerialRow | null;
  onClose: () => void;
}) {
  const [moves, setMoves] = React.useState<Movement[] | null>(null);

  React.useEffect(() => {
    if (!serial) {
      setMoves(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("stock_movements")
        .select("movement_type, qty_change, shop_id, note, created_at, shops(name)")
        .eq("engine_id", serial.id)
        .order("created_at", { ascending: true });
      if (!cancelled) {
        setMoves(
          /* eslint-disable @typescript-eslint/no-explicit-any */
          (data ?? []).map((m: any) => ({
            movement_type: m.movement_type,
            qty_change: m.qty_change,
            shop_id: m.shop_id,
            shop_name: m.shops?.name ?? null,
            note: m.note,
            created_at: m.created_at,
          }))
          /* eslint-enable @typescript-eslint/no-explicit-any */
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serial]);

  return (
    <Dialog open={serial !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Journey — <span className="font-mono">{serial?.serial_number}</span>
          </DialogTitle>
          <DialogDescription>
            {serial?.model}
            {serial?.customer && ` · sold to ${serial.customer}`}
          </DialogDescription>
        </DialogHeader>

        {moves === null ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : moves.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No recorded movements for this serial.
          </p>
        ) : (
          <ol className="relative ml-3 flex flex-col gap-4 border-l pl-6 py-2">
            {moves
              .filter((m) => m.qty_change > 0 || m.movement_type === "sale" || m.movement_type === "loss")
              .map((m, i) => (
                <li key={i} className="relative">
                  <span className="absolute -left-[1.85rem] top-1 size-3 rounded-full border-2 border-background bg-primary" />
                  <div className="text-sm font-medium">
                    {MOVE_LABEL[m.movement_type] ?? m.movement_type}
                    {m.shop_name && ` — ${m.shop_name}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {format(new Date(m.created_at), "MMM d, yyyy h:mm a")}
                    {m.note && ` · ${m.note}`}
                  </div>
                </li>
              ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
