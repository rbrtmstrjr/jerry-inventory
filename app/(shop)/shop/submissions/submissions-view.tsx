"use client";

import * as React from "react";
import { format } from "date-fns";
import Link from "next/link";
import {
  AlertTriangle,
  Loader2,
  MessageCircleQuestion,
  NotebookPen,
  Printer,
  ReceiptText,
  Send,
  ShieldCheck,
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
import { TabCountBadge } from "@/components/ui/tab-count-badge";
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
    engine_id: string | null;
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

export interface ExpenseSubmission {
  id: string;
  expense_date: string;
  status: "recorded" | "pending" | "questioned" | "approved" | "rejected";
  amount: number;
  description: string;
  category_name: string | null;
  paid_to: string | null;
  review_note: string | null;
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
  expenses: ExpenseSubmission[];
}

export function SubmissionsView({
  sales,
  losses,
  expenses,
}: {
  sales: SaleSubmission[];
  losses: LossSubmission[];
  expenses: ExpenseSubmission[];
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [submittingBatch, setSubmittingBatch] = React.useState(false);
  const [cancelling, setCancelling] = React.useState<
    { kind: "sale" | "loss"; id: string } | null
  >(null);

  const currentSales = sales.filter((s) => s.status === "recorded");
  const currentLosses = losses.filter((l) => l.status === "recorded");
  const currentExpenses = expenses.filter((e) => e.status === "recorded");
  const currentTotal =
    currentSales.length + currentLosses.length + currentExpenses.length;
  const currentValue = currentSales.reduce((sum, s) => sum + s.total_centavos, 0);
  const currentExpenseValue = currentExpenses.reduce((sum, e) => sum + e.amount, 0);

  // Group everything already submitted by its batch. A batch stays in
  // "Submitted" while anything inside still awaits Admin; once every item
  // is approved/rejected it moves to "Reviewed".
  const { submitted, reviewed } = React.useMemo(() => {
    const map = new Map<string, ShopBatch>();
    const groupFor = (batchId: string | null, submittedAt: string | null) => {
      const key = batchId ?? "legacy";
      let g = map.get(key);
      if (!g) {
        g = { key, submittedAt, sales: [], losses: [], expenses: [] };
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
    for (const e of expenses) {
      if (e.status === "recorded") continue;
      groupFor(e.batch_id, e.batch_submitted_at).expenses.push(e);
    }
    const open = (st: string) => st === "pending" || st === "questioned";
    const isOpen = (g: ShopBatch) =>
      g.sales.some((s) => open(s.status)) ||
      g.losses.some((l) => open(l.status)) ||
      g.expenses.some((e) => open(e.status));
    const all = [...map.values()].sort((a, b) =>
      (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "")
    );
    return {
      submitted: all.filter(isOpen),
      reviewed: all.filter((g) => !isOpen(g)),
    };
  }, [sales, losses, expenses]);

  const REVEAL_PAGE = 10;
  const [visibleCount, setVisibleCount] = React.useState(REVEAL_PAGE);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisibleCount((n) => n + REVEAL_PAGE);
      },
      { rootMargin: "600px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleCount]);

  async function onSubmitBatch() {
    setSubmittingBatch(true);
    const res = await submitShopBatch();
    setSubmittingBatch(false);
    if (res.ok) {
      toast.success(
        `Sent to Admin: ${res.sales} sale(s), ${res.losses} loss(es), ${res.expenses} expense(s)`
      );
    } else {
      toast.error(res.error);
    }
  }

  function renderSaleRow(s: SaleSubmission, showStatus: boolean) {
    const engineLineCount = s.sale_lines.filter((l) => l.engine_id).length;
    return (
      <div key={s.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium tabular-nums">
            {formatCentavos(s.total_centavos)}
          </span>
          <div className="flex items-center gap-2">
            {showStatus && <StatusBadge status={s.status} />}
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Print receipt"
            >
              <Link href={`/receipt/${s.id}`} target="_blank">
                <Printer className="size-4" />
              </Link>
            </Button>
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
        {/* Warranty certificate — full-page (coupon printer), NOT the thermal
            receipt. A customer document rendered from the sale, so it's ready
            the moment the engine sale is recorded (no Admin approval needed).
            Voids with the sale: cancelling it 404s this the same as the receipt. */}
        {engineLineCount > 0 && (
          <div className="mt-1 flex items-center justify-between gap-2 rounded-md border border-dashed bg-muted/30 px-2 py-1.5 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                Warranty certificate
                {engineLineCount > 1 ? ` · ${engineLineCount} engines` : ""}
              </span>
            </span>
            <Button asChild variant="outline" size="sm" className="h-7 shrink-0">
              <Link href={`/shop/warranty-preview/${s.id}`} target="_blank">
                <Printer className="size-3.5" /> Print warranty
              </Link>
            </Button>
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

  // no cancel here on purpose — employees have no delete path on expenses
  function renderExpenseRow(e: ExpenseSubmission, showStatus: boolean) {
    return (
      <div key={e.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium">{e.description}</span>
          <div className="flex items-center gap-2">
            {e.category_name && <Badge variant="outline">{e.category_name}</Badge>}
            {showStatus && <StatusBadge status={e.status} />}
            <span className="font-medium tabular-nums">
              {formatCentavos(e.amount)}
            </span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          {format(new Date(e.created_at), "MMM d, h:mm a")}
          {e.paid_to && ` · Paid to ${e.paid_to}`}
        </p>
        {e.review_note && (
          <div className="mt-1 flex items-start gap-2 rounded-md bg-accent p-2 text-sm text-accent-foreground">
            <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
            <span>Owner: {e.review_note}</span>
          </div>
        )}
      </div>
    );
  }

  function renderBatchCard(g: ShopBatch) {
    const salesTotal = g.sales.reduce((sum, s) => sum + s.total_centavos, 0);
    // only label sections when the report mixes types
    const mixed =
      [g.sales.length, g.losses.length, g.expenses.length].filter((n) => n > 0)
        .length > 1;
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
            {g.expenses.length > 0 &&
              ` · ${g.expenses.length} expense${g.expenses.length === 1 ? "" : "s"}`}
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
          {g.expenses.length > 0 && (
            <div>
              <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <ReceiptText className="size-3.5" /> EXPENSES
              </p>
              <div className="divide-y">
                {g.expenses.map((e) => renderExpenseRow(e, true))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Batch submit banner */}
      {currentTotal > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-3">
          <div>
            <p className="text-sm font-medium">
              {currentSales.length} sale{currentSales.length === 1 ? "" : "s"}
              {currentLosses.length > 0 &&
                ` · ${currentLosses.length} loss${currentLosses.length === 1 ? "" : "es"}`}
              {currentExpenses.length > 0 &&
                ` · ${currentExpenses.length} expense${currentExpenses.length === 1 ? "" : "s"}`}
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
          <TabsTrigger value="current">
            Current<TabCountBadge count={currentTotal} />
          </TabsTrigger>
          <TabsTrigger value="submitted">
            Submitted<TabCountBadge count={submitted.length} />
          </TabsTrigger>
          <TabsTrigger value="reviewed">Reviewed</TabsTrigger>
        </TabsList>

        {/* ONE card for everything not yet sent — it becomes a new report
            card in Submitted once you press the button above. */}
        <TabsContent value="current" className="flex flex-col gap-3 pt-2">
          {currentTotal === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing recorded yet — new sales, losses, and expenses land here
              first.
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
                  {currentExpenses.length > 0 &&
                    ` · ${currentExpenses.length} expense${currentExpenses.length === 1 ? "" : "s"}`}
                  {currentValue > 0 && ` · ${formatCentavos(currentValue)} sold`}
                  {currentExpenseValue > 0 &&
                    ` · ${formatCentavos(currentExpenseValue)} spent`} —
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
                {currentExpenses.length > 0 && (
                  <div>
                    <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                      <ReceiptText className="size-3.5" /> EXPENSES
                    </p>
                    <div className="divide-y">
                      {currentExpenses.map((e) => renderExpenseRow(e, false))}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Expenses can&apos;t be cancelled here — ask Admin to reject
                      a mistaken one.
                    </p>
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
          {submitted.slice(0, visibleCount).map(renderBatchCard)}
          {visibleCount < submitted.length && (
            <div
              ref={sentinelRef}
              className="py-2 text-center text-xs text-muted-foreground"
            >
              Loading more… ({Math.min(visibleCount, submitted.length)} of{" "}
              {submitted.length})
            </div>
          )}
        </TabsContent>

        <TabsContent value="reviewed" className="flex flex-col gap-3 pt-2">
          {reviewed.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No reviewed reports yet.
            </p>
          )}
          {reviewed.slice(0, visibleCount).map(renderBatchCard)}
          {visibleCount < reviewed.length && (
            <div
              ref={sentinelRef}
              className="py-2 text-center text-xs text-muted-foreground"
            >
              Loading more… ({Math.min(visibleCount, reviewed.length)} of{" "}
              {reviewed.length})
            </div>
          )}
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
