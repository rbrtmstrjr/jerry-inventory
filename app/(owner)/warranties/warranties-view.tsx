"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ArrowRight,
  Check,
  FileText,
  History,
  Loader2,
  Search,
  ShieldCheck,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { formatCentavos } from "@/lib/format";

import { createClient } from "@/lib/supabase/client";
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
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TabCountBadge } from "@/components/ui/tab-count-badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { reviewWarrantyClaim } from "./actions";

export type ClaimResolution = "repair" | "replace" | "refund";
const RESOLUTION_LABEL: Record<ClaimResolution, string> = {
  repair: "Repair",
  replace: "Replace",
  refund: "Refund",
};

export interface PendingClaimRow {
  id: string;
  resolution: ClaimResolution | null;
  issue: string;
  refund_centavos: number | null;
  created_at: string;
  shop: string;
  shop_color_key: string | null;
  serial_number: string;
  model: string;
  customer: string | null;
  replacement_serial: string | null;
}

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
  status: "in_master" | "delivered" | "sold" | "returned" | "defective" | "written_off";
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
  defective: { label: "Defective (RMA)", variant: "destructive" },
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
  pendingClaims = [],
}: {
  warranties: WarrantyRow[];
  serials: SerialRow[];
  today: string;
  shops?: ShopOption[];
  pendingClaims?: PendingClaimRow[];
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

  return (
    <div className="flex flex-col gap-4">
      {/* Land on Approval when there are claims to act on, else on Warranty. */}
      <Tabs defaultValue={pendingClaims.length > 0 ? "approval" : "warranty"}>
        <TabsList>
          <TabsTrigger value="approval">
            <Wrench className="size-4" /> Approval
            <TabCountBadge count={pendingClaims.length} />
          </TabsTrigger>
          <TabsTrigger value="warranty">
            <ShieldCheck className="size-4" /> Warranty
            <TabCountBadge count={warranties.length} />
          </TabsTrigger>
          <TabsTrigger value="serials">
            <Search className="size-4" /> Serials
            <TabCountBadge count={serials.length} />
          </TabsTrigger>
        </TabsList>

        {/* Approval: shop-filed warranty claims awaiting the owner's decision. */}
        <TabsContent value="approval" className="pt-2">
          {pendingClaims.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
              <Wrench className="size-8" />
              No warranty claims awaiting approval.
            </div>
          ) : (
            <ClaimsApproval claims={pendingClaims} />
          )}
        </TabsContent>

        <TabsContent value="warranty" className="pt-2">
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
/** Read-only claim history for a serial. Claims are filed by shops and decided
 *  in the "awaiting approval" section — there is no owner-typed claim path. */
function ClaimsDialog({
  warranty,
  onClose,
}: {
  warranty: WarrantyRow | null;
  onClose: () => void;
}) {
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
          {warranty?.claims.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No claims for this engine.
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

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
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

/** Shop-filed warranty claims awaiting the owner's approval. */
function ClaimsApproval({ claims }: { claims: PendingClaimRow[] }) {
  const router = useRouter();
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState<PendingClaimRow | null>(null);
  const [note, setNote] = React.useState("");

  async function onApprove(c: PendingClaimRow) {
    setBusyId(c.id);
    const res = await reviewWarrantyClaim(c.id, "approve");
    setBusyId(null);
    if (res.ok) {
      toast.success("Claim approved");
      router.refresh();
    } else toast.error(res.error);
  }

  async function onReject() {
    if (!rejecting) return;
    if (note.trim() === "") {
      toast.error("Give a reason");
      return;
    }
    setBusyId(rejecting.id);
    const res = await reviewWarrantyClaim(rejecting.id, "reject", note.trim());
    setBusyId(null);
    if (res.ok) {
      toast.success("Claim declined — the shop was told");
      setRejecting(null);
      setNote("");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <Wrench className="size-4" /> Warranty claims awaiting approval ({claims.length})
      </h2>
      {claims.map((c) => (
        <Card key={c.id} className="border-warning/40">
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {c.model}
                <span className="font-mono text-xs text-muted-foreground">
                  SN {c.serial_number}
                </span>
                {c.resolution && (
                  <Badge variant="secondary">{RESOLUTION_LABEL[c.resolution]}</Badge>
                )}
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => onApprove(c)} disabled={busyId === c.id}>
                  {busyId === c.id ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Check className="size-3.5" />
                  )}
                  Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive"
                  onClick={() => {
                    setNote("");
                    setRejecting(c);
                  }}
                  disabled={busyId === c.id}
                >
                  <X className="size-3.5" /> Reject
                </Button>
              </div>
            </div>
            <CardDescription>
              <ShopBadge shop={{ name: c.shop, color_key: c.shop_color_key }} variant="text" />
              {" · "}
              {format(new Date(c.created_at), "MMM d, yyyy")}
              {c.customer ? ` · ${c.customer}` : ""}
            </CardDescription>
          </CardHeader>
          <CardContent className="text-sm">
            <p className="text-muted-foreground">{c.issue}</p>
            {c.resolution === "replace" && c.replacement_serial && (
              <p className="mt-1 flex flex-wrap items-center gap-1 text-xs">
                Replacement <span className="font-mono">SN {c.replacement_serial}</span>
                <ArrowRight className="size-3 text-muted-foreground" /> customer; defective
                unit returns to master.
              </p>
            )}
            {c.resolution === "refund" && c.refund_centavos != null && (
              <p className="mt-1 text-xs">
                Refund {formatCentavos(c.refund_centavos)} (booked as a company expense).
              </p>
            )}
          </CardContent>
        </Card>
      ))}

      <Dialog open={rejecting !== null} onOpenChange={(o) => !o && setRejecting(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Decline this claim?</DialogTitle>
            <DialogDescription>
              The shop is told your reason. Nothing moves.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="claim-reject-note">Reason</Label>
            <Textarea
              id="claim-reject-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. out of warranty, customer misuse"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onReject} disabled={busyId !== null}>
              Decline claim
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
