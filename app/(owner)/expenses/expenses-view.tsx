"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ArrowRight,
  ImagePlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  ReceiptText,
  Trash2,
  Truck,
  Upload,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import {
  formatBytes,
  processProductImage,
  type ProcessedImage,
} from "@/lib/product-image";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { DatePicker } from "@/components/date-picker";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ReceiptImage, RECEIPTS_BUCKET } from "@/components/receipt-image";
import { setExpenseReceipt, upsertExpense, voidExpense } from "./actions";

export interface ExpenseRow {
  id: string;
  amount: number;
  expense_date: string;
  scope: "shop" | "company";
  shop_id: string | null;
  shop_name: string | null;
  delivery_id: string | null;
  description: string;
  paid_to: string | null;
  payment_method: "cash" | "gcash" | "bank" | "other" | null;
  reference_no: string | null;
  receipt_image_path: string | null;
  category_id: string;
  category_name: string;
}

export interface CategoryOption {
  id: string;
  name: string;
  sort_order: number;
}

export interface DeliveryOption {
  id: string;
  shop_id: string;
  label: string;
}

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  gcash: "GCash",
  bank: "Bank",
  other: "Other",
};

type ReceiptAction =
  | { type: "keep" }
  | { type: "set"; image: ProcessedImage }
  | { type: "remove" };

export function ExpensesView({
  expenses,
  categories,
  shops,
  deliveries,
}: {
  expenses: ExpenseRow[];
  categories: CategoryOption[];
  shops: { id: string; name: string }[];
  deliveries: DeliveryOption[];
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ExpenseRow | null>(null);
  const [voiding, setVoiding] = React.useState<ExpenseRow | null>(null);
  const [viewingReceipt, setViewingReceipt] = React.useState<ExpenseRow | null>(null);

  // list filters
  const [catFilter, setCatFilter] = React.useState("all");
  const [scopeFilter, setScopeFilter] = React.useState("all"); // all | company | shop-id
  const [fromDate, setFromDate] = React.useState("");
  const [toDate, setToDate] = React.useState("");

  const filtered = expenses.filter((e) => {
    if (catFilter !== "all" && e.category_id !== catFilter) return false;
    if (scopeFilter === "company" && e.scope !== "company") return false;
    if (
      scopeFilter !== "all" &&
      scopeFilter !== "company" &&
      e.shop_id !== scopeFilter
    )
      return false;
    if (fromDate && e.expense_date < fromDate) return false;
    if (toDate && e.expense_date > toDate) return false;
    return true;
  });

  const filteredTotal = filtered.reduce((s, e) => s + e.amount, 0);

  // recently-used categories first in the dialog
  const recentCatIds: string[] = [];
  for (const e of expenses) {
    if (!recentCatIds.includes(e.category_id)) recentCatIds.push(e.category_id);
    if (recentCatIds.length >= 4) break;
  }
  const orderedCategories = [
    ...recentCatIds
      .map((id) => categories.find((c) => c.id === id))
      .filter((c): c is CategoryOption => !!c),
    ...categories.filter((c) => !recentCatIds.includes(c.id)),
  ];

  const columns: ColumnDef<ExpenseRow>[] = [
    {
      accessorKey: "expense_date",
      header: ({ column }) => <SortableHeader column={column}>Date</SortableHeader>,
      cell: ({ getValue }) => format(new Date(getValue<string>()), "MMM d, yyyy"),
    },
    {
      accessorKey: "category_name",
      header: "Category",
      cell: ({ getValue }) => <Badge variant="secondary">{getValue<string>()}</Badge>,
    },
    {
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <div className="max-w-72">
          <div className="flex items-center gap-1.5 truncate text-sm font-medium">
            {row.original.delivery_id && (
              <Truck className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            {row.original.description}
          </div>
          {row.original.paid_to && (
            <div className="text-xs text-muted-foreground">
              Paid to {row.original.paid_to}
              {row.original.reference_no && ` · Ref ${row.original.reference_no}`}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "scope",
      header: "Scope",
      cell: ({ row }) =>
        row.original.scope === "company" ? (
          <Badge variant="outline">Company</Badge>
        ) : (
          <span className="text-sm">{row.original.shop_name}</span>
        ),
    },
    {
      accessorKey: "payment_method",
      header: "Method",
      cell: ({ getValue }) => (
        <span className="text-sm text-muted-foreground">
          {METHOD_LABEL[getValue<string>() ?? ""] ?? "—"}
        </span>
      ),
    },
    {
      id: "receipt",
      header: "Receipt",
      cell: ({ row }) =>
        row.original.receipt_image_path ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="View receipt"
            onClick={() => setViewingReceipt(row.original)}
          >
            <ReceiptText className="size-4" />
          </Button>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      accessorKey: "amount",
      header: ({ column }) => <SortableHeader column={column}>Amount</SortableHeader>,
      cell: ({ getValue }) => (
        <span className="tabular-nums font-medium">
          {formatCentavos(getValue<number>())}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Expense actions">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setEditing(row.original);
                setDialogOpen(true);
              }}
            >
              <Pencil className="size-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => setVoiding(row.original)}
            >
              <Trash2 className="size-4" /> Void
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1">
          <Label className="text-xs">From</Label>
          <DatePicker value={fromDate} onChange={setFromDate} placeholder="Any" />
        </div>
        <div className="grid gap-1">
          <Label className="text-xs">To</Label>
          <DatePicker value={toDate} onChange={setToDate} placeholder="Any" />
        </div>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={scopeFilter} onValueChange={setScopeFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scopes</SelectItem>
            <SelectItem value="company">Company-wide</SelectItem>
            {shops.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-sm text-muted-foreground">
          Filtered total:{" "}
          <span className="font-semibold tabular-nums text-foreground">
            {formatCentavos(filteredTotal)}
          </span>
        </span>
      </div>

      <DataTable
        columns={columns}
        data={filtered}
        searchPlaceholder="Search description, paid to…"
        emptyMessage="No expenses recorded yet — log the first one."
        toolbar={
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
          >
            <Plus className="size-4" /> Record expense
          </Button>
        }
      />

      <ExpenseDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        expense={editing}
        categories={orderedCategories}
        shops={shops}
        deliveries={deliveries}
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

      <ConfirmDialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        title={`Void this ${voiding ? formatCentavos(voiding.amount) : ""} expense?`}
        description="It disappears from lists and reports. Its receipt photo is removed."
        confirmLabel="Void"
        destructive
        onConfirm={async () => {
          if (!voiding) return;
          const res = await voidExpense(voiding.id);
          if (res.ok) toast.success("Expense voided");
          else toast.error(res.error);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Record / edit dialog
// ---------------------------------------------------------------------------
function ExpenseDialog({
  open,
  onOpenChange,
  expense,
  categories,
  shops,
  deliveries,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  expense: ExpenseRow | null;
  categories: CategoryOption[];
  shops: { id: string; name: string }[];
  deliveries: DeliveryOption[];
}) {
  const [amount, setAmount] = React.useState("");
  const [date, setDate] = React.useState("");
  const [categoryId, setCategoryId] = React.useState("");
  const [scope, setScope] = React.useState<"shop" | "company">("shop");
  const [shopId, setShopId] = React.useState("");
  const [deliveryId, setDeliveryId] = React.useState("none");
  const [description, setDescription] = React.useState("");
  const [paidTo, setPaidTo] = React.useState("");
  const [method, setMethod] = React.useState("cash");
  const [refNo, setRefNo] = React.useState("");
  const [receipt, setReceipt] = React.useState<ReceiptAction>({ type: "keep" });
  const [processing, setProcessing] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setAmount(expense ? (expense.amount / 100).toFixed(2) : "");
      setDate(expense?.expense_date ?? new Date().toISOString().slice(0, 10));
      setCategoryId(expense?.category_id ?? "");
      setScope(expense?.scope ?? "shop");
      setShopId(expense?.shop_id ?? "");
      setDeliveryId(expense?.delivery_id ?? "none");
      setDescription(expense?.description ?? "");
      setPaidTo(expense?.paid_to ?? "");
      setMethod(expense?.payment_method ?? "cash");
      setRefNo(expense?.reference_no ?? "");
      setReceipt({ type: "keep" });
    }
  }, [open, expense]);

  const deliveryChoices =
    scope === "shop" && shopId
      ? deliveries.filter((d) => d.shop_id === shopId)
      : deliveries;

  async function onPickReceipt(file: File | undefined | null) {
    if (!file) return;
    setProcessing(true);
    try {
      const image = await processProductImage(file);
      setReceipt({ type: "set", image });
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
    const res = await upsertExpense({
      id: expense?.id,
      category_id: categoryId,
      amount: centavos,
      expense_date: date,
      scope,
      shop_id: scope === "shop" ? shopId || null : null,
      delivery_id: deliveryId === "none" ? null : deliveryId,
      description,
      paid_to: paidTo || null,
      payment_method: method,
      reference_no: refNo || null,
    });

    if (!res.ok) {
      setBusy(false);
      toast.error(res.error);
      return;
    }

    // receipt handling (private bucket, owner-only via Storage RLS)
    const expenseId = expense?.id ?? res.id;
    if (expenseId && receipt.type !== "keep") {
      const supabase = createClient();
      const objectPath = `${expenseId}.webp`;
      if (receipt.type === "set") {
        const { error } = await supabase.storage
          .from(RECEIPTS_BUCKET)
          .upload(objectPath, receipt.image.blob, {
            upsert: true,
            contentType: "image/webp",
          });
        if (error) toast.error(`Expense saved, but receipt upload failed: ${error.message}`);
        else await setExpenseReceipt(expenseId, objectPath);
      } else {
        await supabase.storage.from(RECEIPTS_BUCKET).remove([objectPath]);
        await setExpenseReceipt(expenseId, null);
      }
    }

    setBusy(false);
    toast.success(expense ? "Expense updated" : "Expense recorded");
    onOpenChange(false);
  }

  const hasExistingReceipt = !!expense?.receipt_image_path && receipt.type === "keep";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{expense ? "Edit Expense" : "Record Expense"}</DialogTitle>
          <DialogDescription>
            Operating costs only — stock purchases belong in Receiving, wages in
            Payroll.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="exp-amount">Amount ₱</Label>
              <Input
                id="exp-amount"
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
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid min-w-0 gap-2">
              <Label>Scope</Label>
              <Select
                value={scope}
                onValueChange={(v) => {
                  setScope(v as "shop" | "company");
                  if (v === "company") setShopId("");
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="shop">A specific shop</SelectItem>
                  <SelectItem value="company">Company-wide</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid min-w-0 gap-2">
              <Label>Shop</Label>
              <Select
                value={shopId}
                onValueChange={setShopId}
                disabled={scope === "company"}
              >
                <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                  <SelectValue
                    placeholder={scope === "company" ? "—" : "Pick a shop"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {shops.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="exp-desc">Description</Label>
            <Input
              id="exp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Gas for Roxas delivery run"
            />
          </div>

          <div className="grid gap-2">
            <Label className="flex items-center gap-1.5">
              <Truck className="size-3.5" /> Link to a delivery (optional)
            </Label>
            <Select value={deliveryId} onValueChange={setDeliveryId}>
              <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Not delivery-related</SelectItem>
                {deliveryChoices.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="exp-paidto">Paid to</Label>
              <Input
                id="exp-paidto"
                value={paidTo}
                onChange={(e) => setPaidTo(e.target.value)}
                placeholder="e.g. Shell, Mang Tony"
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
              <Label htmlFor="exp-ref">OR / Ref no.</Label>
              <Input
                id="exp-ref"
                value={refNo}
                onChange={(e) => setRefNo(e.target.value)}
              />
            </div>
          </div>

          {/* Receipt photo */}
          <div className="grid gap-2">
            <Label>Receipt photo (optional, private)</Label>
            <div className="flex items-center gap-3">
              {receipt.type === "set" ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={receipt.image.previewUrl}
                  alt="Receipt preview"
                  className="size-20 rounded-md border object-cover"
                />
              ) : hasExistingReceipt ? (
                <ReceiptImage
                  path={expense!.receipt_image_path!}
                  className="size-20 object-cover"
                />
              ) : (
                <div className="flex size-20 items-center justify-center rounded-md border-2 border-dashed text-muted-foreground">
                  <ImagePlus className="size-6" />
                </div>
              )}
              <div className="flex flex-col gap-1.5 text-sm">
                {receipt.type === "set" && (
                  <p className="flex items-center gap-1 text-muted-foreground">
                    <span className="line-through">
                      {formatBytes(receipt.image.originalBytes)}
                    </span>
                    <ArrowRight className="size-3.5" />
                    <span className="font-medium text-foreground">
                      {formatBytes(receipt.image.processedBytes)} WebP
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
                    {processing
                      ? "Processing…"
                      : hasExistingReceipt || receipt.type === "set"
                        ? "Replace"
                        : "Add photo"}
                  </Button>
                  {(hasExistingReceipt || receipt.type !== "keep") && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() =>
                        setReceipt(
                          receipt.type === "set" && !expense?.receipt_image_path
                            ? { type: "keep" }
                            : { type: "remove" }
                        )
                      }
                    >
                      Remove
                    </Button>
                  )}
                </div>
                {receipt.type === "remove" && (
                  <p className="text-xs text-destructive">Removed on save.</p>
                )}
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
              !categoryId ||
              description.trim() === "" ||
              (scope === "shop" && !shopId)
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {expense ? "Save changes" : "Record expense"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
