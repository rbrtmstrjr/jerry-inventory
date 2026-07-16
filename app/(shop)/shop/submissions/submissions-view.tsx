"use client";

import * as React from "react";
import { format } from "date-fns";
import {
  AlertTriangle,
  Loader2,
  MessageCircleQuestion,
  NotebookPen,
  Send,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { cancelLoss, cancelSale, submitShopBatch } from "../actions";

export interface SaleSubmission {
  id: string;
  business_date: string;
  status: "recorded" | "pending" | "questioned" | "approved" | "rejected";
  total_centavos: number;
  owner_note: string | null;
  created_at: string;
  batch_id: string | null;
  batch_submitted_at: string | null;
  sale_lines: {
    description: string | null;
    qty: number;
    unit_price_centavos: number;
    line_total_centavos: number;
  }[];
}

export interface LossSubmission {
  id: string;
  business_date: string;
  status: "recorded" | "pending" | "questioned" | "approved" | "rejected";
  reason: "nasira" | "nawala" | "expired" | "sample" | "correction";
  qty: number;
  note: string | null;
  owner_note: string | null;
  description: string | null;
  created_at: string;
  batch_id: string | null;
  batch_submitted_at: string | null;
}

const STATUS_BADGE: Record<
  SaleSubmission["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  recorded: { label: "Not submitted", variant: "outline" },
  pending: { label: "With Admin", variant: "secondary" },
  questioned: { label: "Questioned", variant: "outline" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
};

const REASON_LABEL: Record<LossSubmission["reason"], string> = {
  nasira: "Nasira (damaged)",
  nawala: "Nawala (missing)",
  expired: "Expired",
  sample: "Sample / libre",
  correction: "Correction",
};

function StatusBadge({ status }: { status: SaleSubmission["status"] }) {
  const s = STATUS_BADGE[status];
  return <Badge variant={s.variant}>{s.label}</Badge>;
}

/** One report = the current recording session or one submitted batch. */
interface ShopBatch {
  key: string;
  submittedAt: string | null; // null = legacy items from before batching
  sales: SaleSubmission[];
  losses: LossSubmission[];
}

export function SubmissionsView({
  sales,
  losses,
}: {
  sales: SaleSubmission[];
  losses: LossSubmission[];
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [submittingBatch, setSubmittingBatch] = React.useState(false);
  const [cancelling, setCancelling] = React.useState<
    { kind: "sale" | "loss"; id: string } | null
  >(null);

  const currentSales = sales.filter((s) => s.status === "recorded");
  const currentLosses = losses.filter((l) => l.status === "recorded");
  const currentTotal = currentSales.length + currentLosses.length;
  const currentValue = currentSales.reduce((sum, s) => sum + s.total_centavos, 0);

  // Group everything already submitted by its batch. A batch stays in
  // "Submitted" while anything inside still awaits Admin; once every item
  // is approved/rejected it moves to "Reviewed".
  const { submitted, reviewed } = React.useMemo(() => {
    const map = new Map<string, ShopBatch>();
    const groupFor = (batchId: string | null, submittedAt: string | null) => {
      const key = batchId ?? "legacy";
      let g = map.get(key);
      if (!g) {
        g = { key, submittedAt, sales: [], losses: [] };
        map.set(key, g);
      }
      return g;
    };
    for (const s of sales) {
      if (s.status === "recorded") continue;
      groupFor(s.batch_id, s.batch_submitted_at).sales.push(s);
    }
    for (const l of losses) {
      if (l.status === "recorded") continue;
      groupFor(l.batch_id, l.batch_submitted_at).losses.push(l);
    }
    const open = (st: string) => st === "pending" || st === "questioned";
    const isOpen = (g: ShopBatch) =>
      g.sales.some((s) => open(s.status)) || g.losses.some((l) => open(l.status));
    const all = [...map.values()].sort((a, b) =>
      (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "")
    );
    return {
      submitted: all.filter(isOpen),
      reviewed: all.filter((g) => !isOpen(g)),
    };
  }, [sales, losses]);

  async function onSubmitBatch() {
    setSubmittingBatch(true);
    const res = await submitShopBatch();
    setSubmittingBatch(false);
    if (res.ok) {
      toast.success(
        `Sent to Admin: ${res.sales} sale(s) and ${res.losses} loss(es)`
      );
    } else {
      toast.error(res.error);
    }
  }

  function renderSaleRow(s: SaleSubmission, showStatus: boolean) {
    return (
      <div key={s.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium tabular-nums">
            {formatCentavos(s.total_centavos)}
          </span>
          <div className="flex items-center gap-2">
            {showStatus && <StatusBadge status={s.status} />}
            {(s.status === "recorded" || s.status === "pending") && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Cancel sale"
                disabled={busy === s.id}
                onClick={() => setCancelling({ kind: "sale", id: s.id })}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {format(new Date(s.created_at), "MMM d, h:mm a")} ·{" "}
          {s.sale_lines.length} line{s.sale_lines.length === 1 ? "" : "s"}
        </p>
        <div className="flex flex-col gap-0.5 text-sm">
          {s.sale_lines.map((l, i) => (
            <div key={i} className="flex justify-between">
              <span className="truncate">
                {l.description ?? "Item"} × {l.qty}
              </span>
              <span className="tabular-nums">
                {formatCentavos(l.line_total_centavos)}
              </span>
            </div>
          ))}
        </div>
        {s.owner_note && (
          <div className="mt-1 flex items-start gap-2 rounded-md bg-accent p-2 text-sm text-accent-foreground">
            <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
            <span>Owner: {s.owner_note}</span>
          </div>
        )}
      </div>
    );
  }

  function renderLossRow(l: LossSubmission, showStatus: boolean) {
    return (
      <div key={l.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">
            {l.description ?? "Item"} × {l.qty}
          </span>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{REASON_LABEL[l.reason]}</Badge>
            {showStatus && <StatusBadge status={l.status} />}
            {(l.status === "recorded" || l.status === "pending") && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Cancel loss"
                disabled={busy === l.id}
                onClick={() => setCancelling({ kind: "loss", id: l.id })}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {format(new Date(l.created_at), "MMM d, h:mm a")}
        </p>
        {l.note && <p className="text-sm text-muted-foreground">{l.note}</p>}
        {l.owner_note && (
          <div className="mt-1 flex items-start gap-2 rounded-md bg-accent p-2 text-sm text-accent-foreground">
            <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
            <span>Owner: {l.owner_note}</span>
          </div>
        )}
      </div>
    );
  }

  function renderBatchCard(g: ShopBatch) {
    const salesTotal = g.sales.reduce((sum, s) => sum + s.total_centavos, 0);
    // only label sections when the report mixes types
    const mixed =
      [g.sales.length, g.losses.length].filter((n) => n > 0).length > 1;
    return (
      <Card key={g.key}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">
            {g.submittedAt
              ? `Report — submitted ${format(new Date(g.submittedAt), "MMM d, yyyy h:mm a")}`
              : "Earlier submissions"}
          </CardTitle>
          <CardDescription>
            {g.sales.length} sale{g.sales.length === 1 ? "" : "s"}
            {g.losses.length > 0 &&
              ` · ${g.losses.length} loss${g.losses.length === 1 ? "" : "es"}`}
            {salesTotal > 0 && ` · ${formatCentavos(salesTotal)}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {g.sales.length > 0 && (
            <div>
              {mixed && (
                <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <ShoppingCart className="size-3.5" /> SALES
                </p>
              )}
              <div className="divide-y">
                {g.sales.map((s) => renderSaleRow(s, true))}
              </div>
            </div>
          )}
          {g.losses.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <AlertTriangle className="size-3.5" /> LOSSES / ADJUSTMENTS
              </p>
              <div className="divide-y">
                {g.losses.map((l) => renderLossRow(l, true))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Submissions</h1>
        <p className="text-sm text-muted-foreground">
          Record all day, then send everything to Admin as one report whenever
          you&apos;re ready.
        </p>
      </div>

      {/* Batch submit banner */}
      {currentTotal > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
          <div>
            <p className="text-sm font-medium">
              {currentSales.length} sale{currentSales.length === 1 ? "" : "s"}
              {currentLosses.length > 0 &&
                ` · ${currentLosses.length} loss${currentLosses.length === 1 ? "" : "es"}`}
              {" "}
              in your current report
            </p>
            <p className="text-xs text-muted-foreground">
              Admin can&apos;t see these until you submit. Cancel any mistakes
              first.
            </p>
          </div>
          <Button onClick={onSubmitBatch} disabled={submittingBatch}>
            {submittingBatch ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Submit {currentTotal} to Admin
          </Button>
        </div>
      )}

      <Tabs defaultValue="current">
        <TabsList>
          <TabsTrigger value="current">Current ({currentTotal})</TabsTrigger>
          <TabsTrigger value="submitted">Submitted ({submitted.length})</TabsTrigger>
          <TabsTrigger value="reviewed">Reviewed ({reviewed.length})</TabsTrigger>
        </TabsList>

        {/* ONE card for everything not yet sent — it becomes a new report
            card in Submitted once you press the button above. */}
        <TabsContent value="current" className="flex flex-col gap-3 pt-2">
          {currentTotal === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing recorded yet — new sales and losses land here first.
            </p>
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <NotebookPen className="size-4" /> Current report
                </CardTitle>
                <CardDescription>
                  {currentSales.length} sale{currentSales.length === 1 ? "" : "s"}
                  {currentLosses.length > 0 &&
                    ` · ${currentLosses.length} loss${currentLosses.length === 1 ? "" : "es"}`}
                  {currentValue > 0 && ` · ${formatCentavos(currentValue)} sold`} —
                  everything here goes to Admin together.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {currentSales.length > 0 && (
                  <div>
                    {currentTotal > currentSales.length && (
                      <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                        <ShoppingCart className="size-3.5" /> SALES
                      </p>
                    )}
                    <div className="divide-y">
                      {currentSales.map((s) => renderSaleRow(s, false))}
                    </div>
                  </div>
                )}
                {currentLosses.length > 0 && (
                  <div>
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                      <AlertTriangle className="size-3.5" /> LOSSES / ADJUSTMENTS
                    </p>
                    <div className="divide-y">
                      {currentLosses.map((l) => renderLossRow(l, false))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="submitted" className="flex flex-col gap-3 pt-2">
          {submitted.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing with Admin right now.
            </p>
          )}
          {submitted.map(renderBatchCard)}
        </TabsContent>

        <TabsContent value="reviewed" className="flex flex-col gap-3 pt-2">
          {reviewed.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No reviewed reports yet.
            </p>
          )}
          {reviewed.map(renderBatchCard)}
        </TabsContent>
      </Tabs>

      <ConfirmDialog
        open={cancelling !== null}
        onOpenChange={(o) => !o && setCancelling(null)}
        title={
          cancelling?.kind === "sale"
            ? "Cancel this sale?"
            : "Cancel this loss report?"
        }
        description="It's removed from your report (and from Admin's queue if already submitted). You can record it again anytime."
        confirmLabel="Yes, cancel it"
        destructive
        onConfirm={async () => {
          if (!cancelling) return;
          setBusy(cancelling.id);
          const res =
            cancelling.kind === "sale"
              ? await cancelSale(cancelling.id)
              : await cancelLoss(cancelling.id);
          setBusy(null);
          if (res.ok) {
            toast.success(
              cancelling.kind === "sale" ? "Sale cancelled" : "Loss report cancelled"
            );
          } else {
            toast.error(res.error);
          }
        }}
      />
    </div>
  );
}
