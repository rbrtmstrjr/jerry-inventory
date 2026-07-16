"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  PackageCheck,
  Truck,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { confirmDelivery } from "../actions";

export interface IncomingDelivery {
  id: string;
  shop_id: string;
  delivered_at: string;
  note: string | null;
  status: "in_transit" | "confirmed" | "discrepancy" | "resolved";
  confirmed_at: string | null;
  resolved_at: string | null;
  line_count: number;
  qty_sent: number;
  qty_outstanding: number;
}

export interface IncomingLine {
  id: string;
  delivery_id: string;
  part_id: string | null;
  engine_id: string | null;
  name: string;
  unit: string;
  serial_number: string | null;
  qty_sent: number;
  qty_received: number | null;
  qty_outstanding: number;
  shop_note: string | null;
}

const STATUS: Record<
  IncomingDelivery["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  in_transit: { label: "On the way — confirm it", variant: "secondary" },
  confirmed: { label: "Received in full", variant: "default" },
  discrepancy: { label: "Discrepancy — with Admin", variant: "destructive" },
  resolved: { label: "Resolved by Admin", variant: "outline" },
};

export function ShopDeliveriesView({
  deliveries,
  lines,
}: {
  deliveries: IncomingDelivery[];
  lines: IncomingLine[];
}) {
  const linesFor = React.useCallback(
    (id: string) => lines.filter((l) => l.delivery_id === id),
    [lines]
  );

  const incoming = deliveries.filter((d) => d.status === "in_transit");
  const history = deliveries.filter((d) => d.status !== "in_transit");

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Incoming Deliveries
        </h1>
        <p className="text-sm text-muted-foreground">
          Count what actually arrives and confirm it. Stock only joins your shop
          once you confirm.
        </p>
      </div>

      <Tabs defaultValue="incoming">
        <TabsList>
          <TabsTrigger value="incoming">
            To confirm ({incoming.length})
          </TabsTrigger>
          <TabsTrigger value="history">History ({history.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="incoming" className="flex flex-col gap-3 pt-2">
          {incoming.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              Nothing on the way right now.
            </p>
          )}
          {incoming.map((d) => (
            <ConfirmCard key={d.id} delivery={d} lines={linesFor(d.id)} />
          ))}
        </TabsContent>

        <TabsContent value="history" className="flex flex-col gap-3 pt-2">
          {history.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No past deliveries yet.
            </p>
          )}
          {history.map((d) => (
            <HistoryCard key={d.id} delivery={d} lines={linesFor(d.id)} />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** The shop's only actions: enter counts, add notes, confirm. */
function ConfirmCard({
  delivery,
  lines,
}: {
  delivery: IncomingDelivery;
  lines: IncomingLine[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);
  // prefilled to what was sent — the common case is "everything arrived"
  const [counts, setCounts] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(lines.map((l) => [l.id, String(l.qty_sent)]))
  );
  const [notes, setNotes] = React.useState<Record<string, string>>({});

  const parsed = lines.map((l) => ({
    line: l,
    got: Math.max(0, parseInt(counts[l.id] || "0", 10) || 0),
  }));
  const short = parsed.reduce((s, p) => s + (p.line.qty_sent - p.got), 0);
  const over = parsed.some((p) => p.got > p.line.qty_sent);

  async function onConfirm() {
    if (over) {
      toast.error("You can't receive more than was sent");
      return;
    }
    setBusy(true);
    const res = await confirmDelivery({
      delivery_id: delivery.id,
      lines: parsed.map((p) => ({
        line_id: p.line.id,
        qty_received: p.got,
        shop_note: notes[p.line.id]?.trim() || null,
      })),
    });
    setBusy(false);
    if (res.ok) {
      if (res.short > 0) {
        toast.success(
          `Confirmed ${res.landed}. ${res.short} reported to Admin for review.`
        );
      } else {
        toast.success("Received in full — stock is now in your shop");
      }
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Card className="border-primary/40">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <Truck className="size-4" /> {delivery.line_count} item
            {delivery.line_count === 1 ? "" : "s"} on the way
          </CardTitle>
          <Badge variant={STATUS[delivery.status].variant}>
            {STATUS[delivery.status].label}
          </Badge>
        </div>
        <CardDescription>
          Sent {format(new Date(delivery.delivered_at), "MMM d, yyyy h:mm a")}
          {delivery.note && ` · ${delivery.note}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-2">
          {lines.map((l) => {
            const got = parseInt(counts[l.id] || "0", 10) || 0;
            const lineShort = l.qty_sent - got;
            const tooMany = got > l.qty_sent;
            return (
              <div key={l.id} className="flex flex-col gap-1.5 rounded-md border px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      {l.engine_id && (
                        <Badge variant="secondary" className="mr-1">
                          Engine
                        </Badge>
                      )}
                      {l.name}
                    </div>
                    {l.serial_number && (
                      <div className="font-mono text-xs text-muted-foreground">
                        SN {l.serial_number}
                      </div>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    sent{" "}
                    <span className="font-semibold text-foreground tabular-nums">
                      {l.qty_sent} {l.unit}
                    </span>
                  </span>
                  <div className="flex items-center gap-1.5">
                    <Label htmlFor={`got-${l.id}`} className="text-xs">
                      Received
                    </Label>
                    <Input
                      id={`got-${l.id}`}
                      inputMode="numeric"
                      value={counts[l.id] ?? ""}
                      onChange={(e) =>
                        setCounts((c) => ({
                          ...c,
                          [l.id]: e.target.value.replace(/\D/g, ""),
                        }))
                      }
                      className={`w-20 tabular-nums ${tooMany ? "border-destructive" : ""}`}
                    />
                  </div>
                </div>
                {tooMany && (
                  <p className="text-xs font-medium text-destructive">
                    Only {l.qty_sent} was sent.
                  </p>
                )}
                {lineShort > 0 && !tooMany && (
                  <Input
                    value={notes[l.id] ?? ""}
                    onChange={(e) =>
                      setNotes((n) => ({ ...n, [l.id]: e.target.value }))
                    }
                    placeholder={`${lineShort} short — what happened? (e.g. 1 box basa/sira)`}
                    className="text-xs"
                    aria-label={`Note for ${l.name}`}
                  />
                )}
              </div>
            );
          })}
        </div>

        {short > 0 && !over && (
          <div className="flex items-start gap-2 rounded-md bg-warning/10 p-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
            <p className="text-xs text-warning-foreground">
              <span className="font-medium">
                {short} item{short === 1 ? "" : "s"} unaccounted for.
              </span>{" "}
              This will be reported to Admin for review — please contact them to
              clarify. You don&apos;t need to do anything else.
            </p>
          </div>
        )}

        <Button onClick={onConfirm} disabled={busy || over} className="self-end">
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <PackageCheck className="size-4" />
          )}
          Confirm what arrived
        </Button>
      </CardContent>
    </Card>
  );
}

/** Read-only once confirmed — the shop has no further say. */
function HistoryCard({
  delivery,
  lines,
}: {
  delivery: IncomingDelivery;
  lines: IncomingLine[];
}) {
  const short = delivery.qty_outstanding;
  return (
    <Card className={delivery.status === "discrepancy" ? "border-warning" : ""}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {delivery.status === "confirmed" ? (
              <CheckCircle2 className="size-4 text-success" />
            ) : (
              <Truck className="size-4" />
            )}
            {delivery.line_count} item{delivery.line_count === 1 ? "" : "s"}
          </CardTitle>
          <Badge variant={STATUS[delivery.status].variant}>
            {STATUS[delivery.status].label}
          </Badge>
        </div>
        <CardDescription>
          Sent {format(new Date(delivery.delivered_at), "MMM d, yyyy")}
          {delivery.confirmed_at &&
            ` · confirmed ${format(new Date(delivery.confirmed_at), "MMM d, h:mm a")}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 text-sm">
        {lines.map((l) => (
          <div key={l.id} className="flex flex-col">
            <div className="flex justify-between gap-2">
              <span className="truncate">{l.name}</span>
              <span className="tabular-nums text-xs">
                {l.qty_received ?? 0} of {l.qty_sent} {l.unit}
                {l.qty_outstanding > 0 && (
                  <span className="ml-1 font-medium text-warning-foreground">
                    · {l.qty_outstanding} missing
                  </span>
                )}
              </span>
            </div>
            {l.shop_note && (
              <span className="text-xs text-muted-foreground">“{l.shop_note}”</span>
            )}
          </div>
        ))}
        {short > 0 && (
          <p className="mt-1 rounded-md bg-accent p-2 text-xs text-accent-foreground">
            Waiting for Admin to review the {short} missing item
            {short === 1 ? "" : "s"}. Nothing more for you to do here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
