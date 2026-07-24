"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Inbox, Loader2, Printer, Truck, X } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TabCountBadge } from "@/components/ui/tab-count-badge";
import { ShopBadge } from "@/components/shop-badge";
import { dismissDeliveryRequest } from "./request-actions";

export interface RequestRow {
  id: string;
  shop_id: string;
  shop_name: string;
  shop_color_key: string | null;
  employee: string;
  status: "open" | "fulfilled" | "dismissed";
  note: string | null;
  owner_note: string | null;
  created_at: string;
  fulfilled_at: string | null;
  fulfilled_delivery_id: string | null;
  items: {
    qty: number;
    name: string;
    unit: string;
    note: string | null;
    is_engine: boolean;
    is_custom: boolean;
  }[];
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
 * Shops asking for stock. Lives on Stock Alerts — a request is a stock-alert
 * signal, not a stock movement. Converting one jumps to the Deliveries page's
 * New Delivery form pre-filled (via ?request=), where the actual movement
 * happens; the printable Stock Request Receipt is the ingoing (shop→admin)
 * document, and a fulfilled request links to its outgoing Delivery Note.
 *
 * The inner Open/Reviewed tabs use variant="line" so they read as a sub-level.
 */
export function RequestsPanel({
  requests,
  onConvert,
}: {
  requests: RequestRow[];
  /** Navigates to the pre-filled New Delivery tab on the Deliveries page. */
  onConvert: (requestId: string) => void;
}) {
  const router = useRouter();
  const [dismissing, setDismissing] = React.useState<RequestRow | null>(null);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const [shopFilter, setShopFilter] = React.useState("all");

  // Shops that actually have requests — de-duped, name-sorted. No filter is
  // offered for a single shop (nothing to narrow).
  const shops = React.useMemo(() => {
    const seen = new Map<
      string,
      { id: string; name: string; color_key: string | null }
    >();
    for (const r of requests)
      if (!seen.has(r.shop_id))
        seen.set(r.shop_id, {
          id: r.shop_id,
          name: r.shop_name,
          color_key: r.shop_color_key,
        });
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [requests]);

  const byShop = (r: RequestRow) => shopFilter === "all" || r.shop_id === shopFilter;
  const open = requests.filter((r) => r.status === "open" && byShop(r));
  const closed = requests.filter((r) => r.status !== "open" && byShop(r));

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
        Shops asking for stock. Print the request for your records, then Convert
        — that fills in the New Delivery form on the Deliveries page, where the
        stock actually moves.
      </p>

      <Tabs defaultValue="open">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList variant="line">
            <TabsTrigger value="open">Open<TabCountBadge count={open.length} /></TabsTrigger>
            <TabsTrigger value="closed">Reviewed</TabsTrigger>
          </TabsList>
          {shops.length > 1 && (
            <Select value={shopFilter} onValueChange={setShopFilter}>
              <SelectTrigger className="h-8 w-[220px]">
                <SelectValue placeholder="All shops" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All shops</SelectItem>
                {shops.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        <TabsContent value="open" className="flex flex-col gap-3 pt-2">
          {open.length === 0 && (
            <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
              <Inbox className="size-8" />
              No open requests.
            </div>
          )}
          <div className="grid items-start gap-3 lg:grid-cols-2">
          {open.map((r) => (
            <Card key={r.id}>
              <CardHeader className="pb-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Truck className="size-4" />
                    <ShopBadge
                      variant="text"
                      shop={{ name: r.shop_name, color_key: r.shop_color_key }}
                    />
                    <Badge variant={STATUS[r.status].variant}>
                      {STATUS[r.status].label}
                    </Badge>
                  </CardTitle>
                  <div className="flex gap-2">
                    <Button asChild variant="outline" size="sm">
                      <Link href={`/stock-alerts/request/${r.id}/receipt`} target="_blank">
                        <Printer className="size-3.5" /> Print request
                      </Link>
                    </Button>
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
              <CardContent className="text-sm">
                {/* Itemized like the print request — one numbered row per item.
                    The cards sit two-per-row, so each is narrow enough that the
                    name-to-qty gap stays tight (no big empty middle). */}
                <div className="flex flex-col">
                  {r.items.map((i, idx) => (
                    <div
                      key={idx}
                      className="flex items-baseline justify-between gap-3 border-b border-border/60 py-2 last:border-0"
                    >
                      <span className="min-w-0 truncate">
                        <span className="mr-1.5 text-xs tabular-nums text-muted-foreground">
                          {idx + 1}.
                        </span>
                        {i.is_engine && (
                          <Badge variant="secondary" className="mr-1">
                            Engine
                          </Badge>
                        )}
                        {i.is_custom && (
                          <Badge variant="outline" className="mr-1 border-primary text-primary">
                            New
                          </Badge>
                        )}
                        {i.name}
                        {i.note && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({i.note})
                          </span>
                        )}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        × {i.qty} {i.unit}
                      </span>
                    </div>
                  ))}
                </div>
                {r.note && (
                  <p className="mt-2 rounded-md bg-accent p-2 text-xs text-accent-foreground">
                    “{r.note}”
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
          </div>
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
                  <CardTitle className="flex items-center gap-2 text-base">
                    <ShopBadge
                      variant="text"
                      shop={{ name: r.shop_name, color_key: r.shop_color_key }}
                    />
                    <Badge variant={STATUS[r.status].variant}>
                      {STATUS[r.status].label}
                    </Badge>
                  </CardTitle>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/stock-alerts/request/${r.id}/receipt`} target="_blank">
                      <Printer className="size-3.5" /> Print request
                    </Link>
                  </Button>
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
