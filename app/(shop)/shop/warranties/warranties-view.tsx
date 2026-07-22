"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import {
  CircleAlert,
  Loader2,
  Printer,
  ScanLine,
  Send,
  ShieldCheck,
  ShieldX,
  User,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";

import type { ShopEngineRow } from "@/lib/db-types";
import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TabCountBadge } from "@/components/ui/tab-count-badge";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { requestWarrantyClaim, cancelWarrantyClaim } from "./actions";

export type ClaimResolution = "repair" | "replace" | "refund";
export type ClaimStatus = "requested" | "approved" | "rejected" | "cancelled";

export interface ShopWarrantyClaimRow {
  id: string;
  warranty_id: string;
  status: ClaimStatus;
  resolution: ClaimResolution | null;
  issue: string;
  review_note: string | null;
  refund_centavos: number | null;
  created_at: string;
  approved_at: string | null;
  serial_number: string;
  brand: string | null;
  model: string | null;
  customer_name: string | null;
  replacement_serial: string | null;
}

const CLAIM_STATUS: Record<
  ClaimStatus,
  { label: string; variant: "secondary" | "default" | "destructive" | "outline" }
> = {
  requested: { label: "Waiting for Admin", variant: "secondary" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
  cancelled: { label: "Cancelled", variant: "outline" },
};

const RESOLUTION_LABEL: Record<ClaimResolution, string> = {
  repair: "Repair",
  replace: "Replace",
  refund: "Refund",
};

export interface ShopWarrantyRow {
  id: string;
  engine_id: string;
  shop_id: string;
  shop_name: string;
  serial_number: string;
  condition: string | null;
  brand: string | null;
  model: string | null;
  horsepower: number | null;
  stroke: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  sold_on: string;
  months: number;
  expires_on: string;
  days_left: number;
  active: boolean;
  expiring_soon: boolean;
  sale_id: string;
  receipt_no: string | null;
}

function statusOf(r: ShopWarrantyRow) {
  if (!r.active) return "expired" as const;
  if (r.expiring_soon) return "expiring" as const;
  return "active" as const;
}

function StatusBadge({ r }: { r: ShopWarrantyRow }) {
  const s = statusOf(r);
  if (s === "expired")
    return (
      <Badge variant="destructive" className="gap-1">
        <ShieldX className="size-3" /> Expired
      </Badge>
    );
  if (s === "expiring")
    return (
      <Badge variant="outline" className="gap-1 border-warning/50 bg-warning/10 text-warning-foreground">
        <CircleAlert className="size-3" /> Expiring soon
      </Badge>
    );
  return (
    <Badge variant="default" className="gap-1">
      <ShieldCheck className="size-3" /> Active
    </Badge>
  );
}

export function ShopWarrantiesView({
  rows,
  claims,
  engines,
}: {
  rows: ShopWarrantyRow[];
  claims: ShopWarrantyClaimRow[];
  engines: ShopEngineRow[];
}) {
  const scanRef = React.useRef<HTMLInputElement>(null);
  const [lookup, setLookup] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [open, setOpen] = React.useState<ShopWarrantyRow | null>(null);
  const [claimFor, setClaimFor] = React.useState<ShopWarrantyRow | null>(null);

  // keyboard-wedge scanners type then press Enter — keep the box focused
  React.useEffect(() => {
    scanRef.current?.focus();
  }, []);

  const q = lookup.trim().toLowerCase();
  const matches = rows.filter((r) => {
    if (status !== "all" && statusOf(r) !== status) return false;
    if (!q) return true;
    return (
      r.serial_number.toLowerCase().includes(q) ||
      (r.customer_name ?? "").toLowerCase().includes(q) ||
      `${r.brand ?? ""} ${r.model ?? ""}`.toLowerCase().includes(q)
    );
  });

  // A serial we can't find is either not ours or doesn't exist — we never say
  // which, and we never query another shop's data to find out.
  const notOurs = q.length >= 4 && matches.length === 0;

  const columns: ColumnDef<ShopWarrantyRow>[] = [
    {
      accessorKey: "serial_number",
      header: "Serial",
      cell: ({ row }) => (
        <span className="font-mono text-sm">{row.original.serial_number}</span>
      ),
    },
    {
      id: "model",
      accessorFn: (r) => `${r.brand ?? ""} ${r.model ?? ""}`,
      header: "Engine",
      cell: ({ row }) => (
        <span>
          {row.original.brand} {row.original.model}
          {row.original.horsepower != null && (
            <span className="text-muted-foreground"> — {row.original.horsepower}HP</span>
          )}
        </span>
      ),
    },
    {
      accessorKey: "customer_name",
      header: "Customer",
      cell: ({ row }) => (
        <div>
          <div>{row.original.customer_name ?? "—"}</div>
          {row.original.customer_phone && (
            <div className="text-xs text-muted-foreground">
              {row.original.customer_phone}
            </div>
          )}
        </div>
      ),
    },
    {
      accessorKey: "sold_on",
      header: ({ column }) => <SortableHeader column={column}>Sold</SortableHeader>,
      cell: ({ getValue }) => format(new Date(getValue<string>()), "MMM d, yyyy"),
    },
    {
      accessorKey: "expires_on",
      header: ({ column }) => <SortableHeader column={column}>Expires</SortableHeader>,
      cell: ({ row }) => (
        <div>
          <div>{format(new Date(row.original.expires_on), "MMM d, yyyy")}</div>
          <div className="text-xs text-muted-foreground">
            {row.original.days_left >= 0
              ? `${row.original.days_left} day(s) left`
              : `${Math.abs(row.original.days_left)} day(s) ago`}
          </div>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge r={row.original} />,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setOpen(row.original)}>
            View
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/shop/warranties/${row.original.id}/certificate`} target="_blank">
              <Printer className="size-4" />
            </Link>
          </Button>
        </div>
      ),
    },
  ];

  const expiring = rows.filter((r) => statusOf(r) === "expiring").length;
  const pendingClaims = claims.filter((c) => c.status === "requested").length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Warranties</h1>
        <p className="text-sm text-muted-foreground">
          Engines your shop sold. Look up a serial when a customer comes in, and
          file a warranty claim when one comes back — Admin approves it.
        </p>
      </div>

      <Tabs defaultValue="warranties">
        <TabsList>
          <TabsTrigger value="warranties">Warranties</TabsTrigger>
          <TabsTrigger value="claims">
            Claims<TabCountBadge count={pendingClaims} />
          </TabsTrigger>
        </TabsList>

        <TabsContent value="warranties" className="flex flex-col gap-4 pt-2">
          {/* Serial lookup — the counter use case */}
          <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
            <div className="flex items-center gap-2">
              <ScanLine className="size-5 shrink-0 text-muted-foreground" />
              <Input
                ref={scanRef}
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
                placeholder="Scan or type the engine serial (or customer / model)…"
                className="bg-background text-base"
                autoComplete="off"
                aria-label="Look up a warranty by serial"
              />
              {lookup && (
                <Button variant="outline" onClick={() => setLookup("")}>
                  Clear
                </Button>
              )}
            </div>
            {notOurs && (
              <div className="flex items-start gap-2 rounded-md bg-warning/10 p-3">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
                <p className="text-sm text-warning-foreground">
                  <span className="font-medium">
                    This engine wasn&apos;t sold by this shop.
                  </span>{" "}
                  Please contact Admin — they can look it up across all branches.
                </p>
              </div>
            )}
          </div>

          {expiring > 0 && (
            <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
              <span className="font-medium">
                {expiring} warrant{expiring === 1 ? "y" : "ies"} expiring soon.
              </span>{" "}
              Worth a heads-up to the customer.
            </p>
          )}

          <DataTable
            columns={columns}
            data={matches}
            searchPlaceholder="Filter this list…"
            emptyMessage={
              q ? "No warranty matches that." : "No warranties yet — sell an engine first."
            }
            rowClassName={(r) =>
              statusOf(r) === "expiring" ? "bg-warning/5" : undefined
            }
            toolbar={
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="All statuses" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="expiring">Expiring soon</SelectItem>
                  <SelectItem value="expired">Expired</SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </TabsContent>

        <TabsContent value="claims" className="pt-2">
          {claims.length === 0 ? (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No claims yet — open a warranty (View) and File a claim.
            </p>
          ) : (
            <MyClaims claims={claims} />
          )}
        </TabsContent>
      </Tabs>

      <DetailDialog
        row={open}
        onClose={() => setOpen(null)}
        onFileClaim={(r) => {
          setOpen(null);
          setClaimFor(r);
        }}
      />
      <ClaimDialog
        warranty={claimFor}
        engines={engines}
        onClose={() => setClaimFor(null)}
      />
    </div>
  );
}

function DetailDialog({
  row,
  onClose,
  onFileClaim,
}: {
  row: ShopWarrantyRow | null;
  onClose: () => void;
  onFileClaim: (r: ShopWarrantyRow) => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Warranty
            {row && <StatusBadge r={row} />}
          </DialogTitle>
          <DialogDescription>
            {row?.brand} {row?.model}
            {row?.horsepower != null && ` — ${row.horsepower}HP`}
          </DialogDescription>
        </DialogHeader>

        {row && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Serial">
                <span className="font-mono">{row.serial_number}</span>
              </Field>
              <Field label="Condition at sale">
                {row.condition === "brand_new" ? "Brand new" : "Second hand"}
              </Field>
              <Field label="Sold on">
                {format(new Date(row.sold_on), "MMM d, yyyy")}
              </Field>
              <Field label="Expires">
                {format(new Date(row.expires_on), "MMM d, yyyy")}
                <div className="text-xs text-muted-foreground">
                  {row.months} month{row.months === 1 ? "" : "s"} ·{" "}
                  {row.days_left >= 0
                    ? `${row.days_left} day(s) left`
                    : `expired ${Math.abs(row.days_left)} day(s) ago`}
                </div>
              </Field>
            </div>

            <div className="rounded-md border p-2.5">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Customer
              </div>
              <div className="flex items-center gap-1.5 font-medium">
                <User className="size-3.5 text-muted-foreground" />
                {row.customer_name ?? "—"}
              </div>
              {row.customer_phone && (
                <div className="text-muted-foreground">{row.customer_phone}</div>
              )}
              {row.customer_address && (
                <div className="text-xs text-muted-foreground">
                  {row.customer_address}
                </div>
              )}
            </div>

            <p className="rounded-md bg-accent p-2 text-xs text-accent-foreground">
              For an extension or any correction, contact Admin. To handle a
              defective unit, file a claim below — Admin approves it.
            </p>
          </div>
        )}

        <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-between">
          {row && (
            <Button variant="outline" onClick={() => onFileClaim(row)}>
              <Wrench className="size-4" /> File a claim
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
            {row && (
              <Button asChild>
                <Link href={`/shop/warranties/${row.id}/certificate`} target="_blank">
                  <Printer className="size-4" /> Certificate
                </Link>
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** File a warranty claim — repair / replace (from own stock) / refund. */
function ClaimDialog({
  warranty,
  engines,
  onClose,
}: {
  warranty: ShopWarrantyRow | null;
  engines: ShopEngineRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [issue, setIssue] = React.useState("");
  const [resolution, setResolution] = React.useState<ClaimResolution>("repair");
  const [replacementId, setReplacementId] = React.useState("");
  const [refund, setRefund] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (warranty) {
      setIssue("");
      setResolution("repair");
      setReplacementId("");
      setRefund("");
    }
  }, [warranty]);

  // replacement candidates: on-hand engines, excluding the warranted serial
  const candidates = engines.filter((e) => e.engine_id !== warranty?.engine_id);
  const refundC = parsePesosToCentavos(refund || "0") ?? 0;

  async function onSubmit() {
    if (!warranty) return;
    if (issue.trim() === "") {
      toast.error("Describe the issue");
      return;
    }
    if (resolution === "replace" && !replacementId) {
      toast.error("Pick a replacement engine");
      return;
    }
    if (resolution === "refund" && refundC <= 0) {
      toast.error("Enter the refund amount");
      return;
    }
    setBusy(true);
    const res = await requestWarrantyClaim({
      warranty_id: warranty.id,
      issue: issue.trim(),
      resolution,
      replacement_engine_id: resolution === "replace" ? replacementId : null,
      refund_centavos: resolution === "refund" ? refundC : null,
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Claim filed — waiting for Admin to approve");
      onClose();
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Dialog open={warranty !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>File a warranty claim</DialogTitle>
          <DialogDescription>
            {warranty?.brand} {warranty?.model} · SN {warranty?.serial_number} —{" "}
            {warranty?.customer_name ?? "customer"}. Admin approves before anything
            moves.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="claim-issue">What&apos;s wrong?</Label>
            <Textarea
              id="claim-issue"
              rows={2}
              value={issue}
              onChange={(e) => setIssue(e.target.value)}
              placeholder="e.g. hard to start, smoking, gearbox noise"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>How to resolve?</Label>
            <div className="grid grid-cols-3 gap-1.5">
              {(["repair", "replace", "refund"] as const).map((r) => (
                <Button
                  key={r}
                  type="button"
                  variant={resolution === r ? "default" : "outline"}
                  size="sm"
                  onClick={() => setResolution(r)}
                >
                  {RESOLUTION_LABEL[r]}
                </Button>
              ))}
            </div>
          </div>

          {resolution === "replace" && (
            <div className="grid gap-1.5">
              <Label>Replacement engine (from your stock)</Label>
              <Select value={replacementId} onValueChange={setReplacementId}>
                <SelectTrigger className="w-full">
                  <SelectValue
                    placeholder={
                      candidates.length === 0
                        ? "No spare engines on hand"
                        : "Pick an on-hand engine…"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {candidates.map((e) => (
                    <SelectItem key={e.engine_id} value={e.engine_id}>
                      {e.brand} {e.model} · SN {e.serial_number}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                On approval this engine goes to the customer and the defective one
                returns to Admin.
              </p>
            </div>
          )}

          {resolution === "refund" && (
            <div className="grid gap-1.5">
              <Label htmlFor="claim-refund">Refund amount ₱</Label>
              <Input
                id="claim-refund"
                inputMode="decimal"
                value={refund}
                onChange={(e) => setRefund(e.target.value.replace(/[^\d.]/g, ""))}
                placeholder="0.00"
                className="tabular-nums"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onSubmit}
            disabled={
              busy ||
              (resolution === "replace" && candidates.length === 0)
            }
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            File claim
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The shop's own claims, with status + cancel while pending. */
function MyClaims({ claims }: { claims: ShopWarrantyClaimRow[] }) {
  const router = useRouter();

  async function onCancel(id: string) {
    const res = await cancelWarrantyClaim(id);
    if (res.ok) {
      toast.success("Claim cancelled");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="flex flex-col gap-2">
      {claims.map((c) => (
        <div
          key={c.id}
          className="flex flex-wrap items-start justify-between gap-2 rounded-lg border p-3"
        >
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
              {c.brand} {c.model}
              <span className="font-mono text-xs text-muted-foreground">
                SN {c.serial_number}
              </span>
              {c.resolution && (
                <Badge variant="secondary">{RESOLUTION_LABEL[c.resolution]}</Badge>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {format(new Date(c.created_at), "MMM d, yyyy")}
              {c.customer_name ? ` · ${c.customer_name}` : ""} · {c.issue}
            </div>
            {c.resolution === "replace" && c.replacement_serial && (
              <div className="text-xs text-muted-foreground">
                Replacement: SN {c.replacement_serial}
              </div>
            )}
            {c.resolution === "refund" && c.refund_centavos != null && (
              <div className="text-xs text-muted-foreground">
                Refund: {formatCentavos(c.refund_centavos)}
              </div>
            )}
            {c.status === "rejected" && c.review_note && (
              <p className="mt-1 rounded-md bg-destructive/5 p-2 text-xs text-destructive">
                Admin: “{c.review_note}”
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={CLAIM_STATUS[c.status].variant}>
              {CLAIM_STATUS[c.status].label}
            </Badge>
            {c.status === "requested" && (
              <Button variant="outline" size="sm" onClick={() => onCancel(c.id)}>
                <X className="size-3.5" /> Cancel
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
