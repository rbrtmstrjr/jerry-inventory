"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  FileText,
  Inbox,
  Loader2,
  Printer,
  Truck,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ShopBadge } from "@/components/shop-badge";
import type { TransferLineRow, TransferRow } from "./page";
import { approveTransfer, resolveDeliveryDiscrepancy, reviewReturn } from "./actions";

/** A shop-requested return awaiting owner approval (0065). */
export type ReturnLineRow = {
  id: string;
  name: string;
  unit: string;
  is_engine: boolean;
  serial_number: string | null;
  qty: number;
  qty_damaged: number;
};
export type ReturnRequestRow = {
  id: string;
  shop_name: string;
  shop_color_key: string | null;
  reason: string | null;
  requested_by: string | null;
  created_at: string;
  lines: ReturnLineRow[];
};

/** Source → destination header, shared across every transfer card. */
function TransferRoute({ t }: { t: TransferRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <ShopBadge shop={{ name: t.from_shop_name, color_key: t.from_shop_color_key }} />
      <ArrowRight className="size-3.5 text-muted-foreground" />
      <ShopBadge shop={{ name: t.to_shop_name, color_key: t.to_shop_color_key }} />
    </span>
  );
}

function LineItem({ l }: { l: TransferLineRow }) {
  return (
    <div className="flex items-center justify-between gap-2 text-sm">
      <span className="truncate">
        {l.is_engine && (
          <Badge variant="secondary" className="mr-1">
            Engine
          </Badge>
        )}
        {l.name}
        {l.serial_number && (
          <span className="ml-1 font-mono text-xs text-muted-foreground">
            {l.serial_number}
          </span>
        )}
      </span>
      <span className="tabular-nums text-muted-foreground">
        × {l.qty} {l.is_engine ? "" : l.unit}
      </span>
    </div>
  );
}

function SlipLink({ id }: { id: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={`/transfer/${id}/slip`} target="_blank">
        <FileText className="size-3.5" /> Print slip
      </Link>
    </Button>
  );
}

/**
 * Shop-to-shop transfers. Distinct from Requests (shops asking master for
 * stock): here one shop sends to another and the owner approves the debit,
 * confirms nothing (the destination does), and resolves any shortfall — a
 * transfer shortfall can go back to the SOURCE shop, never to master.
 */
export function TransfersPanel({
  transfers,
  returns = [],
}: {
  transfers: TransferRow[];
  returns?: ReturnRequestRow[];
}) {
  const router = useRouter();
  const [rejecting, setRejecting] = React.useState<TransferRow | null>(null);
  const [reason, setReason] = React.useState("");
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = React.useState<{
    transfer: TransferRow;
    line: TransferLineRow;
  } | null>(null);
  const [rejectingReturn, setRejectingReturn] = React.useState<ReturnRequestRow | null>(null);
  const [returnReason, setReturnReason] = React.useState("");

  async function onApproveReturn(r: ReturnRequestRow) {
    setBusyId(r.id);
    const res = await reviewReturn(r.id, "approve");
    setBusyId(null);
    if (res.ok) {
      toast.success("Return approved — good stock is back in master");
      router.refresh();
    } else toast.error(res.error);
  }

  async function onRejectReturn() {
    if (!rejectingReturn) return;
    if (!returnReason.trim()) {
      toast.error("A rejection needs a note for the shop");
      return;
    }
    setBusyId(rejectingReturn.id);
    const res = await reviewReturn(rejectingReturn.id, "reject", returnReason.trim());
    setBusyId(null);
    if (res.ok) {
      toast.success("Return declined — the shop was told");
      setRejectingReturn(null);
      setReturnReason("");
      router.refresh();
    } else toast.error(res.error);
  }

  const pending = transfers.filter((t) => t.status === "requested");
  const inTransit = transfers.filter((t) => t.status === "in_transit");
  const short = transfers.filter((t) => t.status === "discrepancy");

  async function onApprove(t: TransferRow) {
    setBusyId(t.id);
    const res = await approveTransfer(t.id, "approve");
    setBusyId(null);
    if (res.ok) {
      toast.success("Transfer approved — stock left the source shop into transit");
      router.refresh();
    } else toast.error(res.error);
  }

  async function onReject() {
    if (!rejecting) return;
    if (!reason.trim()) {
      toast.error("A rejection needs a note for the shop");
      return;
    }
    setBusyId(rejecting.id);
    const res = await approveTransfer(rejecting.id, "reject", reason.trim());
    setBusyId(null);
    if (res.ok) {
      toast.success("Transfer declined — the source shop was told");
      setRejecting(null);
      setReason("");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm text-muted-foreground">
        One shop sending stock to another. Approving debits the source shop into
        transit; the destination confirms what actually arrives, and any
        shortfall is resolved back to the source or written off.
      </p>

      {/* Pending requests */}
      <div className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Inbox className="size-4" /> Pending approval ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No transfers waiting for approval.
          </p>
        ) : (
          pending.map((t) => (
            <Card key={t.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    <TransferRoute t={t} />
                  </CardTitle>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => onApprove(t)}
                      disabled={busyId === t.id}
                    >
                      {busyId === t.id ? (
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
                        setReason("");
                        setRejecting(t);
                      }}
                      disabled={busyId === t.id}
                    >
                      <X className="size-3.5" /> Reject
                    </Button>
                    <SlipLink id={t.id} />
                  </div>
                </div>
                <CardDescription>
                  {t.requested_by ? `${t.requested_by} · ` : ""}
                  {format(new Date(t.requested_at), "MMM d, yyyy h:mm a")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                {t.lines.map((l) => (
                  <LineItem key={l.id} l={l} />
                ))}
                {t.note && (
                  <p className="mt-1 rounded-md bg-accent p-2 text-xs text-accent-foreground">
                    “{t.note}”
                  </p>
                )}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Return requests (shop → master) */}
      <div className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Undo2 className="size-4" /> Returns awaiting approval ({returns.length})
        </h2>
        {returns.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No returns waiting for approval.
          </p>
        ) : (
          returns.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex flex-wrap items-center gap-1.5 text-base">
                    <ShopBadge shop={{ name: r.shop_name, color_key: r.shop_color_key }} />
                    <ArrowRight className="size-3.5 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Admin / Master</span>
                  </CardTitle>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" asChild>
                      <a href={`/return/${r.id}/slip`} target="_blank" rel="noopener noreferrer">
                        <Printer className="size-3.5" /> Print slip
                      </a>
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => onApproveReturn(r)}
                      disabled={busyId === r.id}
                    >
                      {busyId === r.id ? (
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
                        setReturnReason("");
                        setRejectingReturn(r);
                      }}
                      disabled={busyId === r.id}
                    >
                      <X className="size-3.5" /> Reject
                    </Button>
                  </div>
                </div>
                <CardDescription>
                  {r.requested_by ? `${r.requested_by} · ` : ""}
                  {format(new Date(r.created_at), "MMM d, yyyy h:mm a")}
                  {r.reason ? ` · ${r.reason}` : ""}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                {r.lines.map((l) => (
                  <div
                    key={l.id}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="truncate">
                      {l.is_engine && (
                        <Badge variant="secondary" className="mr-1">
                          Engine
                        </Badge>
                      )}
                      {l.name}
                      {l.serial_number && (
                        <span className="ml-1 font-mono text-xs text-muted-foreground">
                          {l.serial_number}
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums text-muted-foreground">
                      × {l.qty} {l.is_engine ? "" : l.unit}
                      {l.qty_damaged > 0 && (
                        <span className="ml-1 text-warning-foreground">
                          ({l.qty_damaged} damaged)
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* Discrepancies */}
      {short.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="size-4 text-warning-foreground" />
            Reported missing ({short.length})
          </h2>
          {short.map((t) => (
            <Card key={t.id} className="border-warning">
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    <TransferRoute t={t} />
                  </CardTitle>
                  <SlipLink id={t.id} />
                </div>
                <CardDescription>
                  Sent{" "}
                  {t.approved_at
                    ? format(new Date(t.approved_at), "MMM d, yyyy")
                    : format(new Date(t.requested_at), "MMM d, yyyy")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1.5">
                {t.lines.map((l) =>
                  l.qty_outstanding > 0 ? (
                    <div
                      key={l.id}
                      className="flex flex-wrap items-center gap-3 rounded-md border border-warning px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">
                          {l.is_engine && (
                            <Badge variant="secondary" className="mr-1">
                              Engine
                            </Badge>
                          )}
                          {l.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          sent {l.qty}, received {l.qty_received ?? 0}
                        </div>
                      </div>
                      <span className="text-sm font-semibold tabular-nums text-warning-foreground">
                        {l.qty_outstanding} missing
                      </span>
                      <Button
                        size="sm"
                        onClick={() => setResolveTarget({ transfer: t, line: l })}
                      >
                        Resolve
                      </Button>
                    </div>
                  ) : (
                    <LineItem key={l.id} l={l} />
                  )
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* In transit */}
      <div className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Truck className="size-4" /> In transit ({inTransit.length})
        </h2>
        {inTransit.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing moving between shops right now.
          </p>
        ) : (
          inTransit.map((t) => (
            <div
              key={t.id}
              className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <TransferRoute t={t} />
                <div className="mt-1 text-xs text-muted-foreground">
                  {t.lines.length} line{t.lines.length === 1 ? "" : "s"} ·{" "}
                  {t.approved_at
                    ? `sent ${format(new Date(t.approved_at), "MMM d, h:mm a")}`
                    : `requested ${format(new Date(t.requested_at), "MMM d")}`}
                </div>
              </div>
              <Badge variant="secondary">Awaiting confirmation</Badge>
              <SlipLink id={t.id} />
            </div>
          ))
        )}
      </div>

      {/* Reject dialog */}
      <Dialog
        open={rejecting !== null}
        onOpenChange={(o) => !o && busyId === null && setRejecting(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Decline this transfer?</DialogTitle>
            <DialogDescription>
              {rejecting?.from_shop_name} will see this reason. No stock moves.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. keep it at your branch, we'll restock from master"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRejecting(null)}
              disabled={busyId !== null}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onReject}
              disabled={busyId !== null || !reason.trim()}
            >
              {busyId !== null && <Loader2 className="size-4 animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Return reject dialog */}
      <Dialog
        open={rejectingReturn !== null}
        onOpenChange={(o) => !o && busyId === null && setRejectingReturn(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Decline this return?</DialogTitle>
            <DialogDescription>
              {rejectingReturn?.shop_name} will see this reason. No stock moves —
              it stays at the shop.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            value={returnReason}
            onChange={(e) => setReturnReason(e.target.value)}
            placeholder="e.g. keep it for now, it'll still sell"
            autoFocus
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRejectingReturn(null)}
              disabled={busyId !== null}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onRejectReturn}
              disabled={busyId !== null || !returnReason.trim()}
            >
              {busyId !== null && <Loader2 className="size-4 animate-spin" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ResolveTransferDialog
        target={resolveTarget}
        onClose={() => setResolveTarget(null)}
      />
    </div>
  );
}

/**
 * Resolve a transfer shortfall — mirrors transit-panel's ResolveDialog, but a
 * transfer's stock left a SOURCE SHOP, so it returns there, never to master.
 */
function ResolveTransferDialog({
  target,
  onClose,
}: {
  target: { transfer: TransferRow; line: TransferLineRow } | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [qty, setQty] = React.useState("");
  const [resolution, setResolution] = React.useState<
    "returned_to_source" | "written_off"
  >("returned_to_source");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const line = target?.line ?? null;
  const outstanding = line?.qty_outstanding ?? 0;

  React.useEffect(() => {
    if (line) {
      setQty(String(line.qty_outstanding));
      setResolution("returned_to_source");
      setReason("");
    }
  }, [line]);

  const n = parseInt(qty || "0", 10) || 0;
  const tooMany = line ? n > outstanding : false;

  async function onSave() {
    if (!line) return;
    if (n <= 0 || tooMany) {
      toast.error(`Enter 1–${outstanding}`);
      return;
    }
    setBusy(true);
    const res = await resolveDeliveryDiscrepancy({
      delivery_line_id: line.id,
      qty: n,
      resolution,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(
        resolution === "returned_to_source"
          ? `${n} back at ${target?.transfer.from_shop_name}`
          : `${n} written off as lost in transit`
      );
      onClose();
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve missing stock</DialogTitle>
          <DialogDescription>
            {line?.name} — {outstanding} unaccounted for on the way from{" "}
            {target?.transfer.from_shop_name} to {target?.transfer.to_shop_name}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="tx-res-qty">Quantity</Label>
            <Input
              id="tx-res-qty"
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
              className={cn("w-28 tabular-nums", tooMany && "border-destructive")}
            />
            {tooMany && (
              <p className="text-xs text-destructive">Only {outstanding} outstanding.</p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>What happened?</Label>
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => setResolution("returned_to_source")}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                  resolution === "returned_to_source" && "border-primary bg-primary/10"
                )}
              >
                <div className="font-medium">
                  Found — return to {target?.transfer.from_shop_name ?? "source shop"}
                </div>
                <div className="text-xs text-muted-foreground">
                  Never actually left, or it came back. The source shop&apos;s stock
                  goes back up.
                </div>
              </button>
              <button
                type="button"
                onClick={() => setResolution("written_off")}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                  resolution === "written_off" && "border-destructive bg-destructive/10"
                )}
              >
                <div className="font-medium">Lost — write off</div>
                <div className="text-xs text-muted-foreground">
                  Gone between the two shops. Recorded as a transit loss, kept
                  separate from shop losses.
                </div>
              </button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="tx-res-reason">Reason</Label>
            <Textarea
              id="tx-res-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                resolution === "written_off"
                  ? "e.g. nawala sa biyahe / nahulog"
                  : "e.g. naiwan sa branch, hindi na-load"
              }
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={busy || tooMany || n <= 0}
            variant={resolution === "written_off" ? "destructive" : "default"}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {resolution === "written_off" ? "Write off" : "Return to source"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
