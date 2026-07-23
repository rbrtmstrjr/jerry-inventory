"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { AlertTriangle, ChevronDown, Loader2, Package, Truck, Warehouse } from "lucide-react";
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
import { ShopBadge } from "@/components/shop-badge";
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

  // Two collapsible, height-bounded sections so the tab doesn't stack into one
  // endless scroll: the ACTIONABLE discrepancies open by default; the (long,
  // animated) awaiting list collapsed until wanted.
  const [showDecision, setShowDecision] = React.useState(true);
  const [showAwaiting, setShowAwaiting] = React.useState(false);

  return (
    <div className="flex flex-col gap-4">
      {short.length > 0 && (
        <section className="overflow-hidden rounded-xl border border-warning/50 bg-warning/[0.06] shadow-sm">
          <button
            type="button"
            onClick={() => setShowDecision((v) => !v)}
            aria-expanded={showDecision}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-warning/10"
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-warning text-warning-foreground">
              <AlertTriangle className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">Needs your decision</span>
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-warning px-1.5 text-xs font-bold tabular-nums text-warning-foreground">
                  {short.length}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Shortfalls a shop reported — resolve each to settle the delivery.
              </p>
            </div>
            <ChevronDown
              className={cn(
                "size-5 shrink-0 text-muted-foreground transition-transform duration-200",
                !showDecision && "-rotate-90"
              )}
            />
          </button>
          {showDecision && (
          <div className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto border-t border-warning/30 p-3">
          {short.map((t) => {
            const missing = Math.max(0, t.qty_outstanding - t.qty_damaged);
            return (
              <div
                key={t.delivery_line_id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-warning px-3 py-2"
              >
                {t.damage_photo_url && (
                  <a href={t.damage_photo_url} target="_blank" rel="noopener noreferrer">
                    {/* signed URL to a private photo — plain img is correct */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={t.damage_photo_url}
                      alt="Damage"
                      className="size-12 rounded-md border object-cover"
                    />
                  </a>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {t.is_engine && (
                      <Badge variant="secondary" className="mr-1">
                        Engine
                      </Badge>
                    )}
                    {t.name}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
                    <ShopBadge
                      variant="text"
                      shop={{ name: t.shop_name, color_key: t.shop_color_key }}
                    />
                    <span>
                      · sent {t.qty_sent}, received {t.qty_received ?? 0} ·{" "}
                      {format(new Date(t.delivered_at), "MMM d")}
                      {t.shop_note && ` · “${t.shop_note}”`}
                    </span>
                  </div>
                </div>
                <span className="flex flex-col items-end text-sm font-semibold tabular-nums">
                  {t.qty_damaged > 0 && (
                    <span className="text-warning-foreground">{t.qty_damaged} damaged</span>
                  )}
                  {missing > 0 && (
                    <span className="text-muted-foreground">{missing} missing</span>
                  )}
                </span>
                <Button size="sm" onClick={() => setTarget(t)}>
                  Resolve
                </Button>
              </div>
            );
          })}
          </div>
          )}
        </section>
      )}

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        <button
          type="button"
          onClick={() => setShowAwaiting((v) => !v)}
          aria-expanded={showAwaiting}
          className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Truck className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold">Awaiting shop confirmation</span>
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-semibold tabular-nums text-muted-foreground">
                {awaiting.length}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              On the road — waiting for shops to confirm what arrived.
            </p>
          </div>
          <ChevronDown
            className={cn(
              "size-5 shrink-0 text-muted-foreground transition-transform duration-200",
              !showAwaiting && "-rotate-90"
            )}
          />
        </button>
        {showAwaiting &&
          (awaiting.length === 0 ? (
            <p className="border-t p-6 text-center text-sm text-muted-foreground">
              Nothing waiting to be confirmed.
            </p>
          ) : (
            <div className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto border-t p-3">
            {awaiting.map((t) => (
            <div key={t.delivery_line_id} className="rounded-lg border bg-card p-3">
              {/* header: what + how many */}
              <div className="flex items-center gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <Package className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">
                    {t.is_engine && (
                      <Badge variant="secondary" className="mr-1">Engine</Badge>
                    )}
                    {t.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    sent {format(new Date(t.delivered_at), "MMM d, h:mm a")}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-sm font-semibold tabular-nums">
                    {t.qty_outstanding} {t.unit}
                  </span>
                  <Badge variant="secondary">In transit</Badge>
                </div>
              </div>

              {/* journey: master → (truck) → shop */}
              <div className="mt-3 flex items-center gap-2 sm:gap-3">
                <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
                  <Warehouse className="size-3.5" /> Master
                </span>
                <div
                  className="relative h-6 flex-1 [container-type:inline-size]"
                  aria-hidden="true"
                >
                  {/* the road */}
                  <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 border-t border-dashed border-muted-foreground/30" />
                  {/* the truck (rides the road, animated horizontally) */}
                  <div className="absolute inset-x-0 top-1/2 -translate-y-1/2">
                    <span className="animate-truck-run inline-flex size-6 items-center justify-center rounded-full border bg-background text-primary shadow-sm">
                      <Truck className="size-3.5" />
                    </span>
                  </div>
                </div>
                <ShopBadge
                  variant="text"
                  shop={{ name: t.shop_name, color_key: t.shop_color_key }}
                />
              </div>
            </div>
            ))}
            </div>
          ))}
        </section>

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
  const [cause, setCause] = React.useState<"damaged" | "lost_in_transit">("lost_in_transit");
  const [resolution, setResolution] = React.useState<
    "returned_to_master" | "written_off"
  >("written_off");
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (row) {
      // pre-fill from what the shop flagged: damaged units default to the
      // damaged cause + write-off; missing default to lost + write-off.
      const damaged = row.qty_damaged > 0;
      setQty(String(damaged ? row.qty_damaged : row.qty_outstanding));
      setCause(damaged ? "damaged" : "lost_in_transit");
      setResolution("written_off");
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
    // structured reason so reports can split "arrived damaged" (supplier/quality)
    // from "lost in transit" (logistics): cause token first, free text appended.
    const structured = reason.trim() ? `${cause}: ${reason.trim()}` : cause;
    const res = await resolveDeliveryDiscrepancy({
      delivery_line_id: row.delivery_line_id,
      qty: n,
      resolution,
      reason: structured,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(
        resolution === "returned_to_master"
          ? `${n} returned to master`
          : `${n} written off (${cause === "damaged" ? "damaged" : "lost in transit"})`
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
          <DialogTitle>Resolve damaged / missing</DialogTitle>
          <DialogDescription>
            {row?.name} — {row?.qty_outstanding} outstanding on the way to{" "}
            {row?.shop_name}
            {row && row.qty_damaged > 0 && ` (${row.qty_damaged} flagged damaged)`}.
            It sits in transit until you decide.
          </DialogDescription>
        </DialogHeader>

        {row?.damage_photo_url && (
          <a href={row.damage_photo_url} target="_blank" rel="noopener noreferrer">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={row.damage_photo_url}
              alt="Damage"
              className="max-h-40 w-full rounded-md border object-contain"
            />
          </a>
        )}
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

          {/* Cause — splits reporting between quality (damaged) and logistics */}
          <div className="grid gap-1.5">
            <Label>Cause</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={cause === "damaged" ? "default" : "outline"}
                size="sm"
                onClick={() => setCause("damaged")}
              >
                Damaged
              </Button>
              <Button
                type="button"
                variant={cause === "lost_in_transit" ? "default" : "outline"}
                size="sm"
                onClick={() => setCause("lost_in_transit")}
              >
                Lost in transit
              </Button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>What now?</Label>
            <div className="grid gap-2">
              <button
                type="button"
                onClick={() => setResolution("returned_to_master")}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent",
                  resolution === "returned_to_master" && "border-primary bg-primary/10"
                )}
              >
                <div className="font-medium">Return to master</div>
                <div className="text-xs text-muted-foreground">
                  {cause === "damaged"
                    ? "Send back to master to return to the supplier. Master stock goes back up."
                    : "Found — never sent, or came back. Master stock goes back up."}
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
                <div className="font-medium">Write off</div>
                <div className="text-xs text-muted-foreground">
                  {cause === "damaged"
                    ? "Damaged beyond use. Business shrinkage, kept separate from shop losses."
                    : "Gone between master and the shop. Recorded as a transit loss."}
                </div>
              </button>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="res-reason">Note (optional)</Label>
            <Textarea
              id="res-reason"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                cause === "damaged"
                  ? "e.g. casing cracked, water-damaged"
                  : "e.g. nawala sa biyahe / naiwan sa bodega"
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
