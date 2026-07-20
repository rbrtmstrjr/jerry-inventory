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
  Receipt,
  ReceiptText,
  ShoppingCart,
  Wallet,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ShopBadge } from "@/components/shop-badge";
import { ReceiptImage } from "@/components/receipt-image";
import {
  approveBatch,
  approveExpense,
  approveLoss,
  approveSale,
  reviewSubmission,
} from "./actions";

export interface PendingSale {
  id: string;
  batch_id: string | null;
  batch_submitted_at: string | null;
  shop_name: string;
  shop_color_key: string | null;
  employee: string;
  customer: string | null;
  status: "pending" | "questioned";
  total_centavos: number;
  payment_type: "full" | "partial";
  amount_paid_centavos: number | null;
  balance_due_centavos: number;
  receipt_no: string | null;
  owner_note: string | null;
  created_at: string;
  has_engine: boolean;
  lines: {
    description: string;
    qty: number;
    line_total_centavos: number;
    is_engine: boolean;
    agreed_price_centavos: number | null;
    list_reference_centavos: number | null;
    discount_centavos: number | null;
    floor_centavos: number | null;
  }[];
}

export interface PendingLoss {
  id: string;
  batch_id: string | null;
  batch_submitted_at: string | null;
  shop_name: string;
  shop_color_key: string | null;
  employee: string;
  status: "pending" | "questioned";
  reason: "nasira" | "nawala" | "expired" | "sample" | "correction";
  qty: number;
  note: string | null;
  owner_note: string | null;
  description: string;
  created_at: string;
}

export interface PendingExpense {
  id: string;
  batch_id: string | null;
  batch_submitted_at: string | null;
  shop_name: string;
  shop_color_key: string | null;
  employee: string;
  status: "pending" | "questioned";
  amount_centavos: number;
  expense_date: string;
  description: string;
  paid_to: string | null;
  payment_method: string | null;
  reference_no: string | null;
  receipt_image_path: string | null;
  review_note: string | null;
  created_at: string;
  category_id: string;
  category_name: string;
  category_proposed: boolean;
}

export interface ActiveCategoryOption {
  id: string;
  name: string;
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
  shopColorKey: string | null;
  submittedAt: string | null;
  sales: PendingSale[];
  losses: PendingLoss[];
  expenses: PendingExpense[];
}

type DialogState =
  | {
      kind: "sale" | "loss" | "expense";
      id: string;
      action: "question" | "reject";
      title: string;
    }
  | null;

export function ApprovalsView({
  sales,
  losses,
  expenses,
  activeCategories,
}: {
  sales: PendingSale[];
  losses: PendingLoss[];
  expenses: PendingExpense[];
  activeCategories: ActiveCategoryOption[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [dialog, setDialog] = React.useState<DialogState>(null);
  const [note, setNote] = React.useState("");
  const [approvingExpense, setApprovingExpense] =
    React.useState<PendingExpense | null>(null);
  const [viewingReceipt, setViewingReceipt] =
    React.useState<PendingExpense | null>(null);

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
        { event: "INSERT", schema: "public", table: "expenses" },
        () => refresh(false)
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "expenses" },
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
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "expenses" },
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
      shopColorKey: string | null,
      submittedAt: string | null
    ) => {
      const key = batchId ?? `legacy-${shopName}`;
      let g = map.get(key);
      if (!g) {
        g = {
          key,
          batchId,
          shopName,
          shopColorKey,
          submittedAt,
          sales: [],
          losses: [],
          expenses: [],
        };
        map.set(key, g);
      }
      return g;
    };
    for (const s of sales) {
      groupFor(s.batch_id, s.shop_name, s.shop_color_key, s.batch_submitted_at).sales.push(s);
    }
    for (const l of losses) {
      groupFor(l.batch_id, l.shop_name, l.shop_color_key, l.batch_submitted_at).losses.push(l);
    }
    for (const e of expenses) {
      groupFor(e.batch_id, e.shop_name, e.shop_color_key, e.batch_submitted_at).expenses.push(e);
    }
    // oldest submission first — Admin clears the queue in arrival order
    return [...map.values()].sort((a, b) =>
      (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "")
    );
  }, [sales, losses, expenses]);

  async function onApprove(kind: "sale" | "loss", id: string) {
    setBusy(id);
    const res = kind === "sale" ? await approveSale(id) : await approveLoss(id);
    setBusy(null);
    if (res.ok) {
      toast.success(
        kind === "sale"
          ? "Sale approved — stock deducted"
          : "Loss approved — written off"
      );
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
        `Batch approved — ${res.sales} sale(s), ${res.losses} loss(es) and ${res.expenses} expense(s)`
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

  function ActionButtons({
    kind,
    id,
    onApproveClick,
  }: {
    kind: "sale" | "loss" | "expense";
    id: string;
    /** expenses approve via a confirm dialog (category remap) instead of directly */
    onApproveClick?: () => void;
  }) {
    return (
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy === id}
          onClick={() =>
            onApproveClick
              ? onApproveClick()
              : onApprove(kind as "sale" | "loss", id)
          }
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
            <div key={i} className="flex flex-col gap-0.5">
              <div className="flex justify-between">
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
              {/* Negotiation context: asking / floor / discount (owner-only) */}
              {l.is_engine && l.floor_centavos != null && (
                <div className="flex flex-wrap gap-x-3 pl-1 text-xs text-muted-foreground">
                  {l.list_reference_centavos != null && (
                    <span>Asking {formatCentavos(l.list_reference_centavos)}</span>
                  )}
                  <span>Floor {formatCentavos(l.floor_centavos)}</span>
                  {l.discount_centavos != null && l.discount_centavos > 0 && (
                    <span className="text-warning-foreground">
                      {formatCentavos(l.discount_centavos)} off
                    </span>
                  )}
                  {l.agreed_price_centavos != null &&
                    l.agreed_price_centavos <= l.floor_centavos && (
                      <span className="font-medium text-success">at floor</span>
                    )}
                </div>
              )}
            </div>
          ))}

          {/* Payment split + receipt */}
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t pt-2">
            <div className="text-xs">
              {s.payment_type === "partial" ? (
                <span>
                  <span className="font-medium">Partial</span> · paid{" "}
                  {formatCentavos(s.amount_paid_centavos ?? 0)} · balance{" "}
                  <span className="font-medium text-warning-foreground">
                    {formatCentavos(s.balance_due_centavos)}
                  </span>
                </span>
              ) : (
                <span className="text-muted-foreground">Paid in full</span>
              )}
            </div>
            <Button asChild variant="outline" size="sm">
              <a href={`/receipt/${s.id}`} target="_blank" rel="noopener noreferrer">
                <Receipt className="size-3.5" /> Receipt
                {s.receipt_no ? ` ${s.receipt_no}` : ""}
              </a>
            </Button>
          </div>

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

  function renderExpenseCard(e: PendingExpense) {
    return (
      <Card key={e.id} className={e.status === "questioned" ? "border-warning" : ""}>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-base tabular-nums">
              {formatCentavos(e.amount_centavos)}
              {e.category_proposed ? (
                <Badge
                  variant="outline"
                  className="ml-2 border-warning/50 bg-warning/10 text-warning-foreground"
                >
                  proposed: {e.category_name}
                </Badge>
              ) : (
                <Badge variant="secondary" className="ml-2">
                  {e.category_name}
                </Badge>
              )}
              {e.status === "questioned" && (
                <Badge variant="outline" className="ml-2">
                  Questioned
                </Badge>
              )}
            </CardTitle>
            <ActionButtons
              kind="expense"
              id={e.id}
              onApproveClick={() => setApprovingExpense(e)}
            />
          </div>
          <CardDescription>
            {format(new Date(e.expense_date), "MMM d")} · recorded{" "}
            {format(new Date(e.created_at), "MMM d, h:mm a")}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1 text-sm">
          <p>{e.description}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {e.paid_to && <span>Paid to {e.paid_to}</span>}
            {e.payment_method && <span>{e.payment_method}</span>}
            {e.reference_no && <span>Ref {e.reference_no}</span>}
            {e.receipt_image_path && (
              <Button
                variant="outline"
                size="sm"
                className="h-7"
                onClick={() => setViewingReceipt(e)}
              >
                <ReceiptText className="size-3.5" /> View receipt
              </Button>
            )}
          </div>
          {e.review_note && (
            <p className="text-xs text-muted-foreground">
              Your note: {e.review_note}
            </p>
          )}
        </CardContent>
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
          b.losses.filter((l) => l.status === "pending").length +
          b.expenses.filter((e) => e.status === "pending").length;
        const questionedCount =
          b.sales.filter((s) => s.status === "questioned").length +
          b.losses.filter((l) => l.status === "questioned").length +
          b.expenses.filter((e) => e.status === "questioned").length;
        const salesTotal = b.sales.reduce((sum, s) => sum + s.total_centavos, 0);
        const employee =
          b.sales[0]?.employee ?? b.losses[0]?.employee ?? b.expenses[0]?.employee ?? "?";
        return (
          <section key={b.key} className="overflow-hidden rounded-lg border">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/50 px-4 py-3">
              <div>
                <p className="font-semibold">
                  <ShopBadge
                    variant="text"
                    shop={{ name: b.shopName, color_key: b.shopColorKey }}
                  />
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
                  {b.expenses.length > 0 &&
                    ` · ${b.expenses.length} expense${b.expenses.length === 1 ? "" : "s"}`}
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
              {b.expenses.length > 0 && (
                <p className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <Wallet className="size-3.5" /> EXPENSES
                </p>
              )}
              {b.expenses.map(renderExpenseCard)}
            </div>
          </section>
        );
      })}

      {/* Reviewed history lives in its own section below (see ReviewedHistory) */}

      {/* Approve expense (confirm + optional category remap) */}
      <ApproveExpenseDialog
        expense={approvingExpense}
        activeCategories={activeCategories}
        busy={busy !== null}
        onClose={() => setApprovingExpense(null)}
        onConfirm={async (remapCategoryId) => {
          if (!approvingExpense) return;
          setBusy(approvingExpense.id);
          const res = await approveExpense(
            approvingExpense.id,
            undefined,
            remapCategoryId
          );
          setBusy(null);
          if (res.ok) {
            toast.success("Expense approved");
            setApprovingExpense(null);
          } else {
            toast.error(res.error);
          }
        }}
      />

      {/* Receipt viewer (private bucket — signed URL via ReceiptImage) */}
      <Dialog
        open={viewingReceipt !== null}
        onOpenChange={(o) => !o && setViewingReceipt(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Receipt</DialogTitle>
            <DialogDescription>
              {viewingReceipt?.description} ·{" "}
              {viewingReceipt && formatCentavos(viewingReceipt.amount_centavos)}
            </DialogDescription>
          </DialogHeader>
          {viewingReceipt?.receipt_image_path && (
            <ReceiptImage
              path={viewingReceipt.receipt_image_path}
              className="max-h-[60vh] w-full"
            />
          )}
        </DialogContent>
      </Dialog>

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

const KEEP_PROPOSED = "__keep";

function ApproveExpenseDialog({
  expense,
  activeCategories,
  busy,
  onClose,
  onConfirm,
}: {
  expense: PendingExpense | null;
  activeCategories: ActiveCategoryOption[];
  busy: boolean;
  onClose: () => void;
  onConfirm: (remapCategoryId: string | null) => Promise<void>;
}) {
  const [category, setCategory] = React.useState(KEEP_PROPOSED);

  React.useEffect(() => {
    if (expense) setCategory(KEEP_PROPOSED);
  }, [expense]);

  return (
    <Dialog open={expense !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Approve this expense?</DialogTitle>
          <DialogDescription>
            {expense && (
              <>
                {formatCentavos(expense.amount_centavos)} · {expense.description}
                {" — "}
                <ShopBadge
                  variant="text"
                  shop={{
                    name: expense.shop_name,
                    color_key: expense.shop_color_key,
                  }}
                />
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {expense?.category_proposed ? (
          <div className="grid gap-2">
            <Label>Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP_PROPOSED}>
                  Keep as proposed — creates “{expense.category_name}”
                </SelectItem>
                {activeCategories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The shop proposed a new category. Approving as-is makes it a real
              category everyone can pick; choosing an existing one files this
              expense there instead and the proposal stays inactive.
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Category: <Badge variant="secondary">{expense?.category_name}</Badge>
            {" — "}counts in expenses and P&amp;L once approved.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              onConfirm(category === KEEP_PROPOSED ? null : category)
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            <Check className="size-4" /> Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
