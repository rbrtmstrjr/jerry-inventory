"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  Inbox,
  Loader2,
  MessageCircleQuestion,
  ShoppingCart,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { approveBatch, approveLoss, approveSale, reviewSubmission } from "./actions";

export interface PendingSale {
  id: string;
  batch_id: string | null;
  batch_submitted_at: string | null;
  shop_name: string;
  employee: string;
  customer: string | null;
  status: "pending" | "questioned";
  total_centavos: number;
  owner_note: string | null;
  created_at: string;
  has_engine: boolean;
  lines: {
    description: string;
    qty: number;
    line_total_centavos: number;
    is_engine: boolean;
  }[];
}

export interface PendingLoss {
  id: string;
  batch_id: string | null;
  batch_submitted_at: string | null;
  shop_name: string;
  employee: string;
  status: "pending" | "questioned";
  reason: "nasira" | "nawala" | "expired" | "sample" | "correction";
  qty: number;
  note: string | null;
  owner_note: string | null;
  description: string;
  created_at: string;
}

const REASON_LABEL: Record<PendingLoss["reason"], string> = {
  nasira: "Nasira (damaged)",
  nawala: "Nawala (missing)",
  expired: "Expired",
  sample: "Sample / libre",
  correction: "Correction",
};

interface BatchGroup {
  key: string;
  batchId: string | null;
  shopName: string;
  submittedAt: string | null;
  sales: PendingSale[];
  losses: PendingLoss[];
}

type DialogState =
  | { kind: "sale" | "loss"; id: string; action: "question" | "reject"; title: string }
  | null;

export function ApprovalsView({
  sales,
  losses,
  recent,
}: {
  sales: PendingSale[];
  losses: PendingLoss[];
  recent: {
    id: string;
    status: string;
    total_centavos: number;
    reviewed_at: string | null;
    shop_name: string;
  }[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<DialogState>(null);
  const [note, setNote] = React.useState("");

  // Near-live queue: refresh when any submission changes. Shops record as
  // 'recorded' first (invisible here) and batch-submit later, so only an
  // UPDATE landing on 'pending' means new work for the owner. One batch can
  // flip many rows at once — the toast shares the refresh debounce window.
  React.useEffect(() => {
    const supabase = createClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let sawNew = false;
    const refresh = (isNew: boolean) => {
      sawNew = sawNew || isNew;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (sawNew) toast.info("New submission arrived");
        sawNew = false;
        router.refresh();
      }, 400);
    };
    const becamePending = (payload: { new?: Record<string, unknown> }) =>
      (payload.new as { status?: string } | undefined)?.status === "pending";
    const channel = supabase
      .channel("approval-queue")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "sales" },
        () => refresh(false)
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "losses" },
        () => refresh(false)
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "sales" },
        (payload) => refresh(becamePending(payload))
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "losses" },
        (payload) => refresh(becamePending(payload))
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "sales" },
        () => refresh(false)
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "losses" },
        () => refresh(false)
      )
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [router]);

  // One review unit per shop submission: group everything by batch.
  const batches = React.useMemo(() => {
    const map = new Map<string, BatchGroup>();
    const groupFor = (
      batchId: string | null,
      shopName: string,
      submittedAt: string | null
    ) => {
      const key = batchId ?? `legacy-${shopName}`;
      let g = map.get(key);
      if (!g) {
        g = { key, batchId, shopName, submittedAt, sales: [], losses: [] };
        map.set(key, g);
      }
      return g;
    };
    for (const s of sales) {
      groupFor(s.batch_id, s.shop_name, s.batch_submitted_at).sales.push(s);
    }
    for (const l of losses) {
      groupFor(l.batch_id, l.shop_name, l.batch_submitted_at).losses.push(l);
    }
    // oldest submission first — Jerry clears the queue in arrival order
    return [...map.values()].sort((a, b) =>
      (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "")
    );
  }, [sales, losses]);

  async function onApprove(kind: "sale" | "loss", id: string) {
    setBusy(id);
    const res = kind === "sale" ? await approveSale(id) : await approveLoss(id);
    setBusy(null);
    if (res.ok) {
      toast.success(kind === "sale" ? "Sale approved — stock deducted" : "Loss approved — written off");
    } else {
      toast.error(res.error);
    }
  }

  async function onApproveBatch(batchId: string) {
    setBusy(batchId);
    const res = await approveBatch(batchId);
    setBusy(null);
    if (res.ok) {
      toast.success(
        `Batch approved — ${res.sales} sale(s) and ${res.losses} loss(es), stock deducted`
      );
    } else {
      toast.error(res.error);
    }
  }

  async function onDialogSubmit() {
    if (!dialog) return;
    if (dialog.action === "question" && note.trim() === "") {
      toast.error("Write the question for the employee");
      return;
    }
    setBusy(dialog.id);
    const res = await reviewSubmission({
      kind: dialog.kind,
      id: dialog.id,
      action: dialog.action,
      note: note.trim(),
    });
    setBusy(null);
    if (res.ok) {
      toast.success(dialog.action === "question" ? "Question sent" : "Rejected");
      setDialog(null);
      setNote("");
    } else {
      toast.error(res.error);
    }
  }

  function ActionButtons({ kind, id }: { kind: "sale" | "loss"; id: string }) {
    return (
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy === id}
          onClick={() => onApprove(kind, id)}
        >
          {busy === id ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy === id}
          onClick={() => {
            setNote("");
            setDialog({ kind, id, action: "question", title: "Question this line" });
          }}
        >
          <MessageCircleQuestion className="size-4" /> Question
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="text-destructive"
          disabled={busy === id}
          onClick={() => {
            setNote("");
            setDialog({ kind, id, action: "reject", title: "Reject this line" });
          }}
        >
          <X className="size-4" /> Reject
        </Button>
      </div>
    );
  }

  function renderSaleCard(s: PendingSale) {
    return (
      <Card key={s.id} className={s.status === "questioned" ? "border-warning" : ""}>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base tabular-nums">
              {formatCentavos(s.total_centavos)}
              {s.has_engine && (
                <Badge variant="secondary" className="ml-2">
                  Engine sale
                </Badge>
              )}
              {s.status === "questioned" && (
                <Badge variant="outline" className="ml-2">
                  Questioned
                </Badge>
              )}
            </CardTitle>
            <ActionButtons kind="sale" id={s.id} />
          </div>
          <CardDescription>
            {format(new Date(s.created_at), "MMM d, h:mm a")}
            {s.customer && ` · Customer: ${s.customer}`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          {s.lines.map((l, i) => (
            <div key={i} className="flex justify-between">
              <span className="truncate">
                {l.is_engine && (
                  <Badge variant="secondary" className="mr-1">
                    Engine
                  </Badge>
                )}
                {l.description} × {l.qty}
              </span>
              <span className="tabular-nums">
                {formatCentavos(l.line_total_centavos)}
              </span>
            </div>
          ))}
          {s.owner_note && (
            <p className="mt-1 text-xs text-muted-foreground">
              Your note: {s.owner_note}
            </p>
          )}
        </CardContent>
      </Card>
    );
  }

  function renderLossCard(l: PendingLoss) {
    return (
      <Card key={l.id} className={l.status === "questioned" ? "border-warning" : ""}>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base">
              {l.description} × {l.qty}
              <Badge variant="outline" className="ml-2">
                {REASON_LABEL[l.reason]}
              </Badge>
              {l.status === "questioned" && (
                <Badge variant="outline" className="ml-2">
                  Questioned
                </Badge>
              )}
            </CardTitle>
            <ActionButtons kind="loss" id={l.id} />
          </div>
          <CardDescription>
            Loss / adjustment · {format(new Date(l.created_at), "MMM d, h:mm a")}
          </CardDescription>
        </CardHeader>
        {(l.note || l.owner_note) && (
          <CardContent className="flex flex-col gap-1 text-sm">
            {l.note && <p className="text-muted-foreground">“{l.note}”</p>}
            {l.owner_note && (
              <p className="text-xs text-muted-foreground">
                Your note: {l.owner_note}
              </p>
            )}
          </CardContent>
        )}
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approval Queue</h1>
        <p className="text-sm text-muted-foreground">
          {batches.length} batch{batches.length === 1 ? "" : "es"} waiting —
          each is one shop submission you can approve in one click. Stock only
          moves when you approve. Updates live as shops submit.
        </p>
      </div>

      {batches.length === 0 && (
        <div className="flex flex-col items-center gap-2 rounded-md border border-dashed p-10 text-center text-sm text-muted-foreground">
          <Inbox className="size-8" />
          Nothing waiting — you&apos;re all caught up.
        </div>
      )}

      {batches.map((b) => {
        const pendingCount =
          b.sales.filter((s) => s.status === "pending").length +
          b.losses.filter((l) => l.status === "pending").length;
        const questionedCount =
          b.sales.filter((s) => s.status === "questioned").length +
          b.losses.filter((l) => l.status === "questioned").length;
        const salesTotal = b.sales.reduce((sum, s) => sum + s.total_centavos, 0);
        const employee = b.sales[0]?.employee ?? b.losses[0]?.employee ?? "?";
        return (
          <section key={b.key} className="overflow-hidden rounded-lg border">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/50 px-4 py-3">
              <div>
                <p className="font-semibold">
                  {b.shopName}
                  <span className="ml-2 text-sm font-normal text-muted-foreground">
                    {b.submittedAt
                      ? `submitted ${format(new Date(b.submittedAt), "MMM d, h:mm a")}`
                      : "earlier individual submissions"}{" "}
                    · {employee}
                  </span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {b.sales.length} sale{b.sales.length === 1 ? "" : "s"}
                  {b.losses.length > 0 &&
                    ` · ${b.losses.length} loss${b.losses.length === 1 ? "" : "es"}`}
                  {salesTotal > 0 && (
                    <>
                      {" · "}
                      <span className="font-medium tabular-nums text-foreground">
                        {formatCentavos(salesTotal)}
                      </span>
                    </>
                  )}
                  {questionedCount > 0 &&
                    ` · ${questionedCount} questioned (excluded from approve-all)`}
                </p>
              </div>
              {b.batchId && (
                <Button
                  disabled={busy === b.batchId || pendingCount === 0}
                  onClick={() => onApproveBatch(b.batchId!)}
                >
                  {busy === b.batchId ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CheckCheck className="size-4" />
                  )}
                  Approve all ({pendingCount})
                </Button>
              )}
            </div>
            <div className="flex flex-col gap-3 p-3">
              {b.sales.length > 0 && (
                <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <ShoppingCart className="size-3.5" /> SALES
                </p>
              )}
              {b.sales.map(renderSaleCard)}
              {b.losses.length > 0 && (
                <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <AlertTriangle className="size-3.5" /> LOSSES / ADJUSTMENTS
                </p>
              )}
              {b.losses.map(renderLossCard)}
            </div>
          </section>
        );
      })}

      {/* Recently reviewed */}
      {recent.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground">
            Recently reviewed sales
          </h2>
          <div className="flex flex-col gap-1 text-sm">
            {recent.map((r) => (
              <div
                key={r.id}
                className="flex items-center justify-between rounded-md border px-3 py-1.5"
              >
                <span className="text-muted-foreground">
                  {r.shop_name} ·{" "}
                  {r.reviewed_at
                    ? format(new Date(r.reviewed_at), "MMM d, h:mm a")
                    : ""}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums">
                    {formatCentavos(r.total_centavos)}
                  </span>
                  <Badge variant={r.status === "approved" ? "default" : "destructive"}>
                    {r.status}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Question / Reject dialog */}
      <Dialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialog(null);
            setNote("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{dialog?.title}</DialogTitle>
            <DialogDescription>
              {dialog?.action === "question"
                ? "The employee sees this note on their submission and can clarify or cancel. Questioned lines are skipped by approve-all."
                : "Rejects the line — nothing deducts. A note helps the employee understand."}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              dialog?.action === "question"
                ? "e.g. Bakit 3 pcs? Isa lang nabenta kanina…"
                : "Reason (optional)"
            }
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              onClick={onDialogSubmit}
              disabled={busy !== null}
              variant={dialog?.action === "reject" ? "destructive" : "default"}
            >
              {busy !== null && <Loader2 className="size-4 animate-spin" />}
              {dialog?.action === "question" ? "Send question" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
