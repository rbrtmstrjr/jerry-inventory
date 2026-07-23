"use client";

import * as React from "react";
import { format, subDays } from "date-fns";
import {
  ArrowRight,
  ImagePlus,
  Loader2,
  MessageCircleQuestion,
  Plus,
  ReceiptText,
  ShieldCheck,
  Upload,
} from "lucide-react";
import { toast } from "sonner";

import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { ph_today } from "@/lib/ph-date";
import { createClient } from "@/lib/supabase/client";
import {
  formatBytes,
  processProductImage,
  type ProcessedImage,
} from "@/lib/product-image";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/date-picker";
import { ReceiptImage, RECEIPTS_BUCKET } from "@/components/receipt-image";
import { recordShopExpense } from "../actions";

export interface ShopExpenseRow {
  id: string;
  amount: number;
  expense_date: string;
  description: string;
  paid_to: string | null;
  payment_method: "cash" | "gcash" | "bank" | "other" | null;
  reference_no: string | null;
  receipt_image_path: string | null;
  status: "recorded" | "pending" | "questioned" | "approved" | "rejected";
  source: "owner" | "shop";
  review_note: string | null;
  created_at: string;
  category_name: string;
}

export interface CategoryOption {
  id: string;
  name: string;
  sort_order: number;
}

const STATUS_BADGE: Record<
  ShopExpenseRow["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  recorded: { label: "Not submitted", variant: "outline" },
  pending: { label: "With Admin", variant: "secondary" },
  questioned: { label: "Questioned", variant: "outline" },
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
};

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  gcash: "GCash",
  bank: "Bank",
  other: "Other",
};

const PROPOSE_VALUE = "__propose__";

export function ShopExpensesView({
  expenses,
  categories,
  shopId,
}: {
  expenses: ShopExpenseRow[];
  categories: CategoryOption[];
  shopId: string | null;
}) {
  const today = ph_today();
  // default to this month-to-date; presets / pickers override it
  const [from, setFrom] = React.useState(`${today.slice(0, 7)}-01`);
  const [to, setTo] = React.useState(today);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [viewingReceipt, setViewingReceipt] =
    React.useState<ShopExpenseRow | null>(null);

  function preset(days: number) {
    setFrom(format(subDays(new Date(`${today}T00:00:00`), days - 1), "yyyy-MM-dd"));
    setTo(today);
  }

  // expense_date is YYYY-MM-DD, so string compare is a correct date compare
  const shown = expenses.filter(
    (e) => (!from || e.expense_date >= from) && (!to || e.expense_date <= to)
  );
  const approvedTotal = shown
    .filter((e) => e.status === "approved")
    .reduce((s, e) => s + e.amount, 0);

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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="size-4" /> Record expense
        </Button>
      </div>

      {/* Period filter — date range + quick presets; approved money only */}
      <div className="flex flex-wrap items-end justify-between gap-3 rounded-lg border px-4 py-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="exp-from" className="text-xs">From</Label>
            <DatePicker id="exp-from" value={from} onChange={setFrom} placeholder="Any" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="exp-to" className="text-xs">To</Label>
            <DatePicker id="exp-to" value={to} onChange={setTo} placeholder="Any" />
          </div>
          <Button variant="outline" onClick={() => preset(1)}>Today</Button>
          <Button variant="outline" onClick={() => preset(7)}>7d</Button>
          <Button variant="outline" onClick={() => preset(30)}>30d</Button>
          {(from || to) && (
            <Button
              variant="ghost"
              onClick={() => {
                setFrom("");
                setTo("");
              }}
            >
              Clear
            </Button>
          )}
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">Approved expenses</div>
          <div className="text-lg font-semibold tabular-nums">
            {formatCentavos(approvedTotal)}
          </div>
        </div>
      </div>

      {/* This shop's expenses for the shown month */}
      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No expenses in this range yet.
        </p>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">My shop&apos;s expenses</CardTitle>
            <CardDescription>
              {shown.length} expense{shown.length === 1 ? "" : "s"} — Admin&apos;s
              company-wide costs never appear here.
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y">
            {shown.slice(0, visibleCount).map((e) => {
              const s = STATUS_BADGE[e.status];
              return (
                <div key={e.id} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium">{e.description}</span>
                    <div className="flex items-center gap-2">
                      {e.receipt_image_path && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label="View receipt"
                          onClick={() => setViewingReceipt(e)}
                        >
                          <ReceiptText className="size-4" />
                        </Button>
                      )}
                      <span className="font-medium tabular-nums">
                        {formatCentavos(e.amount)}
                      </span>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{e.category_name}</Badge>
                    {e.source === "owner" ? (
                      <Badge variant="outline">
                        <ShieldCheck className="size-3" /> Recorded by Admin
                      </Badge>
                    ) : (
                      <Badge variant={s.variant}>{s.label}</Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(e.expense_date + "T00:00:00"), "MMM d, yyyy")}
                    {e.paid_to && ` · Paid to ${e.paid_to}`}
                    {e.payment_method && ` · ${METHOD_LABEL[e.payment_method]}`}
                    {e.reference_no && ` · Ref ${e.reference_no}`}
                  </p>
                  {e.review_note &&
                    (e.status === "questioned" || e.status === "rejected") && (
                      <div className="mt-1 flex items-start gap-2 rounded-md bg-accent p-2 text-sm text-accent-foreground">
                        <MessageCircleQuestion className="mt-0.5 size-4 shrink-0" />
                        <span>Admin: {e.review_note}</span>
                      </div>
                    )}
                </div>
              );
            })}
            {visibleCount < shown.length && (
              <div
                ref={sentinelRef}
                className="py-2 text-center text-xs text-muted-foreground"
              >
                Loading more… ({Math.min(visibleCount, shown.length)} of{" "}
                {shown.length})
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <RecordExpenseDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        categories={categories}
        shopId={shopId}
      />

      {/* Receipt viewer */}
      <Dialog
        open={viewingReceipt !== null}
        onOpenChange={(o) => !o && setViewingReceipt(null)}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Receipt</DialogTitle>
            <DialogDescription>
              {viewingReceipt?.description} ·{" "}
              {viewingReceipt && formatCentavos(viewingReceipt.amount)}
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Record dialog
// ---------------------------------------------------------------------------
function RecordExpenseDialog({
  open,
  onOpenChange,
  categories,
  shopId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  categories: CategoryOption[];
  shopId: string | null;
}) {
  const [amount, setAmount] = React.useState("");
  const [date, setDate] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [proposedName, setProposedName] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [paidTo, setPaidTo] = React.useState("");
  const [method, setMethod] = React.useState("cash");
  const [refNo, setRefNo] = React.useState("");
  const [receipt, setReceipt] = React.useState<ProcessedImage | null>(null);
  const [processing, setProcessing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const proposing = categoryId === PROPOSE_VALUE;

  React.useEffect(() => {
    if (open) {
      setAmount("");
      setDate(ph_today());
      setCategoryId("");
      setProposedName("");
      setDescription("");
      setPaidTo("");
      setMethod("cash");
      setRefNo("");
      setReceipt(null);
    }
  }, [open]);

  async function onPickReceipt(file: File | undefined | null) {
    if (!file) return;
    setProcessing(true);
    try {
      setReceipt(await processProductImage(file));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't process that photo.");
    } finally {
      setProcessing(false);
    }
  }

  async function onSave() {
    const centavos = parsePesosToCentavos(amount || "0");
    if (centavos === null || centavos <= 0) {
      toast.error("Enter a valid ₱ amount");
      return;
    }
    setBusy(true);

    // upload first (shop's own prefix — Storage RLS enforces it), then record
    let receiptPath: string | null = null;
    const supabase = createClient();
    if (receipt) {
      if (!shopId) {
        setBusy(false);
        toast.error("No shop on this account — can't attach a receipt.");
        return;
      }
      receiptPath = `shop-${shopId}/${crypto.randomUUID()}.webp`;
      const { error } = await supabase.storage
        .from(RECEIPTS_BUCKET)
        .upload(receiptPath, receipt.blob, { contentType: "image/webp" });
      if (error) {
        setBusy(false);
        toast.error(`Receipt upload failed: ${error.message}`);
        return;
      }
    }

    const res = await recordShopExpense({
      amount_centavos: centavos,
      description,
      category_id: proposing || !categoryId ? null : categoryId,
      proposed_category: proposing ? proposedName : null,
      expense_date: date || null,
      paid_to: paidTo || null,
      payment_method: method,
      reference_no: refNo || null,
      receipt_path: receiptPath,
    });
    if (!res.ok && receiptPath) {
      // don't strand an orphan photo if the record didn't save
      await supabase.storage.from(RECEIPTS_BUCKET).remove([receiptPath]);
    }
    setBusy(false);
    if (res.ok) {
      toast.success("Expense recorded — it goes to Admin with your next report");
      onOpenChange(false);
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record Expense</DialogTitle>
          <DialogDescription>
            Shop costs only (fuel, repairs, supplies). Admin reviews it with
            your next report before it counts.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="sexp-amount">Amount ₱</Label>
              <Input
                id="sexp-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label>Date</Label>
              <DatePicker value={date} onChange={setDate} className="w-full" />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Category</Label>
            <Select value={categoryId} onValueChange={setCategoryId}>
              <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                <SelectValue placeholder="Pick a category" />
              </SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
                <SelectItem value={PROPOSE_VALUE}>
                  Propose new category…
                </SelectItem>
              </SelectContent>
            </Select>
            {proposing && (
              <>
                <Input
                  value={proposedName}
                  onChange={(e) => setProposedName(e.target.value)}
                  placeholder="New category name, e.g. Boat Repair"
                />
                <p className="text-xs text-muted-foreground">
                  Admin approves the new category (or files this under an
                  existing one) when reviewing.
                </p>
              </>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="sexp-desc">Description</Label>
            <Input
              id="sexp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Gas for the service boat"
            />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="sexp-paidto">Paid to</Label>
              <Input
                id="sexp-paidto"
                value={paidTo}
                onChange={(e) => setPaidTo(e.target.value)}
                placeholder="e.g. Shell"
              />
            </div>
            <div className="grid min-w-0 gap-2">
              <Label>Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="gcash">GCash</SelectItem>
                  <SelectItem value="bank">Bank</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="sexp-ref">OR / Ref no.</Label>
              <Input
                id="sexp-ref"
                value={refNo}
                onChange={(e) => setRefNo(e.target.value)}
              />
            </div>
          </div>

          {/* Receipt photo (optional) */}
          <div className="grid gap-2">
            <Label>Receipt photo (optional)</Label>
            <div className="flex items-center gap-3">
              {receipt ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={receipt.previewUrl}
                  alt="Receipt preview"
                  className="size-20 rounded-md border object-cover"
                />
              ) : (
                <div className="flex size-20 items-center justify-center rounded-md border-2 border-dashed text-muted-foreground">
                  <ImagePlus className="size-6" />
                </div>
              )}
              <div className="flex flex-col gap-1.5 text-sm">
                {receipt && (
                  <p className="flex items-center gap-1 text-muted-foreground">
                    <span className="line-through">
                      {formatBytes(receipt.originalBytes)}
                    </span>
                    <ArrowRight className="size-3.5" />
                    <span className="font-medium text-foreground">
                      {formatBytes(receipt.processedBytes)} WebP
                    </span>
                  </p>
                )}
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={processing}
                    onClick={() => fileRef.current?.click()}
                  >
                    <Upload className="size-4" />
                    {processing ? "Processing…" : receipt ? "Replace" : "Add photo"}
                  </Button>
                  {receipt && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setReceipt(null)}
                    >
                      Remove
                    </Button>
                  )}
                </div>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                onPickReceipt(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={onSave}
            disabled={
              busy ||
              processing ||
              description.trim() === "" ||
              !categoryId ||
              (proposing && proposedName.trim() === "")
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Record expense
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
