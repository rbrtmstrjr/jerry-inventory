"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { FileText, Inbox, Loader2, Truck, X } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dismissDeliveryRequest } from "./request-actions";

export interface RequestRow {
  id: string;
  shop_id: string;
  shop_name: string;
  employee: string;
  status: "open" | "fulfilled" | "dismissed";
  note: string | null;
  owner_note: string | null;
  created_at: string;
  fulfilled_at: string | null;
  fulfilled_delivery_id: string | null;
  items: { qty: number; name: string; unit: string; note: string | null; is_engine: boolean }[];
}

const STATUS: Record<
  RequestRow["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  open: { label: "Open", variant: "secondary" },
  fulfilled: { label: "Fulfilled", variant: "default" },
  dismissed: { label: "Dismissed", variant: "destructive" },
};

/**
 * Shops asking for stock. Lives inside the Deliveries page because converting a
 * request just pre-fills the delivery form on this same page — a request is not
 * a stock movement of its own.
 *
 * The inner Open/Reviewed tabs use variant="line" so they read as a sub-level of
 * the page's pill tabs rather than competing with them.
 */
export function RequestsPanel({
  requests,
  onConvert,
}: {
  requests: RequestRow[];
  /** Switches the page to the pre-filled New Delivery tab. */
  onConvert: (requestId: string) => void;
}) {
  const router = useRouter();
  const [dismissing, setDismissing] = React.useState<RequestRow | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const open = requests.filter((r) => r.status === "open");
  const closed = requests.filter((r) => r.status !== "open");

  async function onDismiss() {
    if (!dismissing) return;
    setBusy(true);
    const res = await dismissDeliveryRequest(dismissing.id, reason);
    setBusy(false);
    if (res.ok) {
      toast.success("Request dismissed — the shop was told");
      setDismissing(null);
      setReason("");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        Shops asking for stock. Converting fills in the New Delivery tab — stock
        still moves through the usual delivery flow.
      </p>

      <Tabs defaultValue="open">
        <TabsList variant="line">
          <TabsTrigger value="open">Open ({open.length})</TabsTrigger>
          <TabsTrigger value="closed">Reviewed ({closed.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="flex flex-col gap-3 pt-2">
          {open.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
              <Inbox className="size-8" />
              No open requests.
            </div>
          )}
          {open.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Truck className="size-4" /> {r.shop_name}
                    <Badge variant={STATUS[r.status].variant}>
                      {STATUS[r.status].label}
                    </Badge>
                  </CardTitle>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => onConvert(r.id)}>
                      <Truck className="size-3.5" /> Convert to delivery
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive"
                      onClick={() => {
                        setReason("");
                        setDismissing(r);
                      }}
                    >
                      <X className="size-3.5" /> Dismiss
                    </Button>
                  </div>
                </div>
                <CardDescription>
                  {r.employee} · {format(new Date(r.created_at), "MMM d, yyyy h:mm a")}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-1 text-sm">
                {r.items.map((i, idx) => (
                  <div key={idx} className="flex justify-between gap-2">
                    <span className="truncate">
                      {i.is_engine && (
                        <Badge variant="secondary" className="mr-1">
                          Engine
                        </Badge>
                      )}
                      {i.name}
                      {i.note && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({i.note})
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums">
                      × {i.qty} {i.unit}
                    </span>
                  </div>
                ))}
                {r.note && (
                  <p className="mt-1 rounded-md bg-accent p-2 text-xs text-accent-foreground">
                    “{r.note}”
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="closed" className="flex flex-col gap-3 pt-2">
          {closed.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              Nothing reviewed yet.
            </p>
          )}
          {closed.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    {r.shop_name}
                    <Badge variant={STATUS[r.status].variant} className="ml-2">
                      {STATUS[r.status].label}
                    </Badge>
                  </CardTitle>
                  {r.fulfilled_delivery_id && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/deliveries/${r.fulfilled_delivery_id}/note`} target="_blank">
                        <FileText className="size-3.5" /> Delivery note
                      </Link>
                    </Button>
                  )}
                </div>
                <CardDescription>
                  {r.items.length} item{r.items.length === 1 ? "" : "s"} ·{" "}
                  {format(new Date(r.created_at), "MMM d, yyyy")}
                  {r.fulfilled_at &&
                    ` · fulfilled ${format(new Date(r.fulfilled_at), "MMM d")}`}
                </CardDescription>
              </CardHeader>
              {r.owner_note && (
                <CardContent className="text-xs text-muted-foreground">
                  Your note: {r.owner_note}
                </CardContent>
              )}
            </Card>
          ))}
        </TabsContent>
      </Tabs>

      <Dialog
        open={dismissing !== null}
        onOpenChange={(o) => !o && !busy && setDismissing(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Dismiss this request?</DialogTitle>
            <DialogDescription>
              {dismissing?.shop_name} will see this reason on their Low Stock
              page. Nothing is delivered.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. wala pang stock sa master, next week na"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissing(null)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onDismiss} disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Dismiss
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
