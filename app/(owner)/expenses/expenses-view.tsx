"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import {
  ArrowRight,
  BellRing,
  ImagePlus,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Printer,
  ReceiptText,
  Trash2,
  Truck,
  Upload,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import type { BusinessIdentity } from "@/lib/db-types";
import { ph_today } from "@/lib/ph-date";
import { createClient } from "@/lib/supabase/client";
import {
  formatBytes,
  processProductImage,
  type ProcessedImage,
} from "@/lib/product-image";
import { Badge } from "@/components/ui/badge";
import { ShopBadge } from "@/components/shop-badge";
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
  shop_color_key: string | null;
  delivery_id: string | null;
  description: string;
  paid_to: string | null;
  payment_method: "cash" | "gcash" | "bank" | "other" | null;
  reference_no: string | null;
  receipt_image_path: string | null;
  category_id: string;
  category_name: string;
  status: "recorded" | "pending" | "questioned" | "approved" | "rejected";
  source: "owner" | "shop";
  review_note: string | null;
  batch_id: string | null;
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

const STATUS_META: Record<
  ExpenseRow["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  recorded: { label: "Recorded", variant: "outline" },
  pending: { label: "Pending", variant: "outline" },
  questioned: { label: "Questioned", variant: "outline" },
  approved: { label: "Approved", variant: "secondary" },
  rejected: { label: "Rejected", variant: "destructive" },
};

/** Pending/questioned shop claims belong to the approval flow, not this page. */
const canEdit = (e: ExpenseRow) =>
  e.source === "owner" || e.status === "approved";

type ReceiptAction =
  | { type: "keep" }
  | { type: "set"; image: ProcessedImage }
  | { type: "remove" };

export function ExpensesView({
  expenses,
  categories,
  shops,
  deliveries,
  business,
}: {
  expenses: ExpenseRow[];
  categories: CategoryOption[];
  shops: { id: string; name: string }[];
  deliveries: DeliveryOption[];
  business: BusinessIdentity;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<ExpenseRow | null>(null);
  const [voiding, setVoiding] = React.useState<ExpenseRow | null>(null);
  const [viewingReceipt, setViewingReceipt] = React.useState<ExpenseRow | null>(null);

  // list filters
  const [catFilter, setCatFilter] = React.useState("all");
  const [scopeFilter, setScopeFilter] = React.useState("all"); // all | company | shop-id
  const [statusFilter, setStatusFilter] = React.useState("all"); // all | approved | review | rejected
  const [sourceFilter, setSourceFilter] = React.useState("all"); // all | owner | shop
  const [fromDate, setFromDate] = React.useState("");
  const [toDate, setToDate] = React.useState("");

  // Stamped on the printed sheet — set on click so SSR can't mismatch.
  const [printedAt, setPrintedAt] = React.useState("");

  const filtered = expenses.filter((e) => {
    if (catFilter !== "all" && e.category_id !== catFilter) return false;
    if (scopeFilter === "company" && e.scope !== "company") return false;
    if (
      scopeFilter !== "all" &&
      scopeFilter !== "company" &&
      e.shop_id !== scopeFilter
    )
      return false;
    if (statusFilter === "approved" && e.status !== "approved") return false;
    if (statusFilter === "review" && !["pending", "questioned"].includes(e.status))
      return false;
    if (statusFilter === "rejected" && e.status !== "rejected") return false;
    if (sourceFilter !== "all" && e.source !== sourceFilter) return false;
    if (fromDate && e.expense_date < fromDate) return false;
    if (toDate && e.expense_date > toDate) return false;
    return true;
  });

  // Shop claims awaiting review — decided on /approvals, surfaced loudly here.
  const awaitingReview = expenses.filter(
    (e) => e.source === "shop" && (e.status === "pending" || e.status === "questioned")
  ).length;

  // Money figures count APPROVED rows only — a pending claim isn't spend yet
  // and a rejected one never was (same rule the reports already enforce).
  const approvedFiltered = filtered.filter((e) => e.status === "approved");
  const unapprovedCount = filtered.length - approvedFiltered.length;
  const filteredTotal = approvedFiltered.reduce((s, e) => s + e.amount, 0);

  // Company-wide vs per-shop, over whatever the filters currently show.
  // Company overhead is never spread across shops — it's reported on its own.
  const companyTotal = approvedFiltered
    .filter((e) => e.scope === "company")
    .reduce((s, e) => s + e.amount, 0);
  const shopTotal = filteredTotal - companyTotal;
  const perShopTotals = (() => {
    const m = new Map<string, { color_key: string | null; amount: number }>();
    for (const e of approvedFiltered) {
      if (e.scope !== "shop" || !e.shop_name) continue;
      const t = m.get(e.shop_name) ?? { color_key: e.shop_color_key, amount: 0 };
      t.amount += e.amount;
      m.set(e.shop_name, t);
    }
    return [...m.entries()].sort((a, b) => b[1].amount - a[1].amount);
  })();

  // Human-readable list of the active filters, printed on the sheet header so
  // the paper says exactly which slice it represents.
  const activeFilters: string[] = [];
  if (fromDate || toDate)
    activeFilters.push(`Dates ${fromDate || "start"} → ${toDate || "today"}`);
  if (catFilter !== "all")
    activeFilters.push(
      `Category: ${categories.find((c) => c.id === catFilter)?.name ?? "?"}`
    );
  if (scopeFilter !== "all")
    activeFilters.push(
      `Scope: ${
        scopeFilter === "company"
          ? "Company-wide"
          : shops.find((s) => s.id === scopeFilter)?.name ?? "?"
      }`
    );
  if (statusFilter !== "all")
    activeFilters.push(
      `Status: ${
        (
          {
            approved: "Approved",
            review: "Pending / questioned",
            rejected: "Rejected",
          } as Record<string, string>
        )[statusFilter] ?? statusFilter
      }`
    );
  if (sourceFilter !== "all")
    activeFilters.push(
      `Source: ${sourceFilter === "owner" ? "Owner-recorded" : "Shop-recorded"}`
    );

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
          <ShopBadge
            shop={{
              name: row.original.shop_name ?? "?",
              color_key: row.original.shop_color_key,
            }}
          />
        ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <div className="flex flex-col items-start gap-0.5">
          <Badge
            variant={STATUS_META[row.original.status].variant}
            title={row.original.review_note ?? undefined}
          >
            {STATUS_META[row.original.status].label}
          </Badge>
          {row.original.source === "shop" && (
            <span className="text-[11px] text-muted-foreground">
              shop-recorded
            </span>
          )}
        </div>
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
      cell: ({ row }) =>
        canEdit(row.original) ? (
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
        ) : (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Reviewed on the Approval Queue"
            title="A shop claim under review is decided on the Approval Queue"
            disabled
          >
            <MoreHorizontal className="size-4" />
          </Button>
        ),
    },
  ];

  return (
    <>
    <div className="flex flex-col gap-3 print:hidden">
      {/* Shop claims waiting on the owner — decided on /approvals, never here */}
      {awaitingReview > 0 && (
        <Link
          href="/approvals"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 transition-colors hover:bg-warning/15"
        >
          <span className="flex items-center gap-2 text-sm font-medium text-warning-foreground">
            <BellRing className="size-4" />
            {awaitingReview} shop expense{awaitingReview === 1 ? "" : "s"} awaiting
            review
          </span>
          <span className="flex items-center gap-1 text-sm text-warning-foreground">
            Review in Approval Queue <ArrowRight className="size-4" />
          </span>
        </Link>
      )}

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
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="review">Pending / questioned</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            <SelectItem value="owner">Owner-recorded</SelectItem>
            <SelectItem value="shop">Shop-recorded</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Summary — company overhead and branch running costs are different
          animals, so they never get merged into a single number. */}
      <div className="rounded-lg border">
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b bg-muted/40 px-4 py-2.5">
          <div>
            <div className="text-xs text-muted-foreground">Filtered total</div>
            <div className="text-lg font-semibold tabular-nums">
              {formatCentavos(filteredTotal)}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Company-wide</div>
              <div className="font-semibold tabular-nums">
                {formatCentavos(companyTotal)}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">
                Per-shop ({perShopTotals.length})
              </div>
              <div className="font-semibold tabular-nums">
                {formatCentavos(shopTotal)}
              </div>
            </div>
          </div>
        </div>

        {perShopTotals.length > 0 && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 px-4 py-2 text-sm">
            {perShopTotals.map(([name, t]) => (
              <span key={name} className="inline-flex items-center gap-1.5 text-muted-foreground">
                <ShopBadge shop={{ name, color_key: t.color_key }} variant="text" />
                <span className="font-medium tabular-nums text-foreground">
                  {formatCentavos(t.amount)}
                </span>
              </span>
            ))}
          </div>
        )}

        <p className="border-t px-4 py-2 text-xs text-muted-foreground">
          Approved expenses only
          {unapprovedCount > 0 &&
            ` (${unapprovedCount} pending/rejected row${
              unapprovedCount === 1 ? "" : "s"
            } shown below don't count)`}
          . Operating costs only — supplier payments are stock cost (COGS) and
          belong in Supplier Payables, not here.
        </p>
      </div>

      <DataTable
        columns={columns}
        data={filtered}
        searchPlaceholder="Search description, paid to…"
        emptyMessage="No expenses recorded yet — log the first one."
        toolbar={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                setPrintedAt(format(new Date(), "MMM d, yyyy h:mm a"));
                // let React commit the timestamp before the print snapshot
                requestAnimationFrame(() => window.print());
              }}
              title="Print the rows currently shown"
            >
              <Printer className="size-4" /> Print
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="size-4" /> Record expense
            </Button>
          </div>
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

    <ExpensesPrintSheet
      business={business}
      rows={filtered}
      approvedTotal={filteredTotal}
      companyTotal={companyTotal}
      shopTotal={shopTotal}
      unapprovedCount={unapprovedCount}
      activeFilters={activeFilters}
      printedAt={printedAt}
    />
    </>
  );
}

// ---------------------------------------------------------------------------
// Print sheet — hidden on screen, the ONLY thing that prints. Renders the exact
// rows the filters currently show (all of them, unpaginated), so a filtered
// view prints filtered. Money totals mirror the on-screen summary: approved
// rows only.
// ---------------------------------------------------------------------------
function ExpensesPrintSheet({
  business,
  rows,
  approvedTotal,
  companyTotal,
  shopTotal,
  unapprovedCount,
  activeFilters,
  printedAt,
}: {
  business: BusinessIdentity;
  rows: ExpenseRow[];
  approvedTotal: number;
  companyTotal: number;
  shopTotal: number;
  unapprovedCount: number;
  activeFilters: string[];
  printedAt: string;
}) {
  return (
    <div id="expenses-print" className="hidden print:block text-black">
      {/* Print in isolation: the layout heading + tabs are ancestors of this
          view, so display:none on a sibling can't reach them. Hiding everything
          and re-showing only this sheet does — scoped to @media print. */}
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #expenses-print, #expenses-print * { visibility: visible !important; }
        #expenses-print { position: absolute; left: 0; top: 0; width: 100%; }
      }`}</style>
      <header className="mb-4 border-b border-black pb-2 text-center">
        <h1 className="text-lg font-bold">{business.business_name}</h1>
        {business.address && <p className="text-xs">{business.address}</p>}
        {business.phone && <p className="text-xs">{business.phone}</p>}
        <p className="mt-2 text-base font-semibold">Expense Report</p>
      </header>

      <div className="mb-3 flex items-start justify-between text-xs">
        <div>
          <span className="font-semibold">Filters: </span>
          {activeFilters.length ? activeFilters.join(" · ") : "All expenses"}
        </div>
        {printedAt && <div>Printed {printedAt}</div>}
      </div>

      <table className="w-full border-collapse text-xs">
        <thead>
          <tr className="border-y border-black text-left">
            <th className="py-1 pr-2 font-semibold">Date</th>
            <th className="py-1 pr-2 font-semibold">Category</th>
            <th className="py-1 pr-2 font-semibold">Scope</th>
            <th className="py-1 pr-2 font-semibold">Description</th>
            <th className="py-1 pr-2 font-semibold">Paid to</th>
            <th className="py-1 pr-2 font-semibold">Status</th>
            <th className="py-1 pl-2 text-right font-semibold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className="border-b border-black/20 align-top">
              <td className="py-1 pr-2 whitespace-nowrap">
                {format(new Date(e.expense_date), "MMM d, yyyy")}
              </td>
              <td className="py-1 pr-2">{e.category_name}</td>
              <td className="py-1 pr-2">
                {e.scope === "company" ? "Company-wide" : e.shop_name ?? "—"}
              </td>
              <td className="py-1 pr-2">{e.description}</td>
              <td className="py-1 pr-2">{e.paid_to ?? "—"}</td>
              <td className="py-1 pr-2 capitalize">{e.status}</td>
              <td className="py-1 pl-2 text-right tabular-nums">
                {formatCentavos(e.amount)}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="py-3 text-center">
                No expenses match the current filters.
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-black font-semibold">
            <td colSpan={6} className="py-1 pr-2 text-right">
              Approved total ({rows.length} row{rows.length === 1 ? "" : "s"} shown)
            </td>
            <td className="py-1 pl-2 text-right tabular-nums">
              {formatCentavos(approvedTotal)}
            </td>
          </tr>
          <tr>
            <td colSpan={6} className="py-1 pr-2 text-right text-xs">
              Company-wide
            </td>
            <td className="py-1 pl-2 text-right text-xs tabular-nums">
              {formatCentavos(companyTotal)}
            </td>
          </tr>
          <tr>
            <td colSpan={6} className="py-1 pr-2 text-right text-xs">
              Per-shop
            </td>
            <td className="py-1 pl-2 text-right text-xs tabular-nums">
              {formatCentavos(shopTotal)}
            </td>
          </tr>
        </tfoot>
      </table>

      <p className="mt-3 text-[10px]">
        Approved expenses only
        {unapprovedCount > 0 &&
          ` — ${unapprovedCount} pending/rejected row${
            unapprovedCount === 1 ? "" : "s"
          } shown above don't count toward the totals`}
        . Operating costs only; supplier payments are stock cost (COGS) and are
        not included here.
      </p>
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
      setDate(expense?.expense_date ?? ph_today());
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
