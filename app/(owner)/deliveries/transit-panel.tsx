"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { AlertTriangle, Loader2, Truck } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
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
import type { DiscrepancyRow } from "./page";
import { resolveDeliveryDiscrepancy } from "./actions";

/** Always-visible answer to "what's between master and my shops right now?" */
export function TransitBanner({ transit }: { transit: DiscrepancyRow[] }) {
  const short = transit.filter((t) => t.status === "discrepancy");
  const qty = transit.reduce((s, t) => s + t.qty_outstanding, 0);
  const shortQty = short.reduce((s, t) => s + t.qty_outstanding, 0);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardDescription>Stock in transit</CardDescription>
          <Truck className="size-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold tabular-nums">{qty}</div>
          <p className="text-xs text-muted-foreground">
            unit(s) between master and shops, across{" "}
            {new Set(transit.map((t) => t.delivery_id)).size} delivery(s)
          </p>
        </CardContent>
      </Card>
      <Card className={shortQty > 0 ? "border-warning" : ""}>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardDescription>Needs your decision</CardDescription>
          <AlertTriangle
            className={cn(
              "size-4",
              shortQty > 0 ? "text-warning-foreground" : "text-muted-foreground"
            )}
          />
        </CardHeader>
        <CardContent>
          <div
            className={cn(
              "text-2xl font-bold tabular-nums",
              shortQty > 0 && "text-warning-foreground"
            )}
          >
            {shortQty}
          </div>
          <p className="text-xs text-muted-foreground">
            {shortQty > 0
              ? "unit(s) a shop reported missing — resolve below"
              : "nothing unaccounted for"}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * In-transit lines. Anything a shop reported short is resolvable here — and
 * ONLY here, by the owner.
 */
export function TransitPanel({ transit }: { transit: DiscrepancyRow[] }) {
  const [target, setTarget] = React.useState<DiscrepancyRow | null>(null);
  const awaiting = transit.filter((t) => t.status === "in_transit");
  const short = transit.filter((t) => t.status === "discrepancy");

  return (
    <div className="flex flex-col gap-4">
      {short.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="size-4 text-warning-foreground" />
            Reported missing ({short.length})
          </h2>
          {short.map((t) => (
            <div
              key={t.delivery_line_id}
              className="flex flex-wrap items-center gap-3 rounded-md border border-warning px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">
                  {t.is_engine && (
                    <Badge variant="secondary" className="mr-1">
                      Engine
                    </Badge>
                  )}
                  {t.name}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t.shop_name} · sent {t.qty_sent}, received {t.qty_received ?? 0}{" "}
                  · {format(new Date(t.delivered_at), "MMM d")}
                  {t.shop_note && ` · “${t.shop_note}”`}
                </div>
              </div>
              <span className="text-sm font-semibold tabular-nums text-warning-foreground">
                {t.qty_outstanding} missing
              </span>
              <Button size="sm" onClick={() => setTarget(t)}>
                Resolve
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Truck className="size-4" /> Awaiting shop confirmation ({awaiting.length})
        </h2>
        {awaiting.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            Nothing waiting to be confirmed.
          </p>
        ) : (
          awaiting.map((t) => (
            <div
              key={t.delivery_line_id}
              className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{t.name}</div>
                <div className="text-xs text-muted-foreground">
                  {t.shop_name} · sent{" "}
                  {format(new Date(t.delivered_at), "MMM d, h:mm a")}
                </div>
              </div>
              <span className="text-sm tabular-nums">
                {t.qty_outstanding} {t.unit}
              </span>
              <Badge variant="secondary">In transit</Badge>
            </div>
          ))
        )}
      </div>

      <ResolveDialog row={target} onClose={() => setTarget(null)} />
    </div>
  );
}

function ResolveDialog({
  row,
  onClose,
}: {
  row: DiscrepancyRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [qty, setQty] = React.useState("");
  const [resolution, setResolution] = React.useState<
    "returned_to_master" | "written_off"
  >("returned_to_master");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (row) {
      setQty(String(row.qty_outstanding));
      setResolution("returned_to_master");
      setReason("");
    }
  }, [row]);

  const n = parseInt(qty || "0", 10) || 0;
  const tooMany = row ? n > row.qty_outstanding : false;

  async function onSave() {
    if (!row) return;
    if (n <= 0 || tooMany) {
      toast.error(`Enter 1–${row.qty_outstanding}`);
      return;
    }
    setBusy(true);
    const res = await resolveDeliveryDiscrepancy({
      delivery_line_id: row.delivery_line_id,
      qty: n,
      resolution,
      reason: reason.trim() || null,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(
        resolution === "returned_to_master"
          ? `${n} back in master stock`
          : `${n} written off as lost in transit`
      );
      onClose();
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve missing stock</DialogTitle>
          <DialogDescription>
            {row?.name} — {row?.qty_outstanding} unaccounted for on the way to{" "}
            {row?.shop_name}. It sits in transit until you decide.
          </DialogDescription>
        </DialogHeader>

        {row?.shop_note && (
          <p className="rounded-md bg-accent p-2 text-xs text-accent-foreground">
            Shop said: “{row.shop_note}”
          </p>
        )}

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="res-qty">Quantity</Label>
            <Input
              id="res-qty"
              inputMode="numeric"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, ""))}
              className={cn("w-28 tabular-nums", tooMany && "border-destructive")}
            />
            {tooMany && (
              <p className="text-xs text-destructive">
                Only {row?.qty_outstanding} outstanding.
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <Label>What happened?</Label>
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => setResolution("returned_to_master")}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                  resolution === "returned_to_master" &&
                    "border-primary bg-primary/10"
                )}
              >
                <div className="font-medium">Found — return to master</div>
                <div className="text-xs text-muted-foreground">
                  Never actually sent, or it came back. Master stock goes back up.
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
                  Gone between master and the shop. Recorded as a transit loss,
                  kept separate from shop losses.
                </div>
              </button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="res-reason">Reason</Label>
            <Textarea
              id="res-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                resolution === "written_off"
                  ? "e.g. nawala sa biyahe / nahulog"
                  : "e.g. naiwan sa bodega, hindi na-load"
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
            {resolution === "written_off" ? "Write off" : "Return to master"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
