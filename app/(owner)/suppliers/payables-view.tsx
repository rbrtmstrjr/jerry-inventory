"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  CalendarClock,
  Download,
  HandCoins,
  Info,
  Loader2,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import type { ReceivingBalanceRow, SupplierPayableRow } from "@/lib/db-types";
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
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TabCountBadge } from "@/components/ui/tab-count-badge";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import {
  ImageUploadField,
  type ImageAction,
} from "@/components/image-upload-field";
import { createClient } from "@/lib/supabase/client";
import { recordSupplierPayment } from "./actions";

export interface PaymentHistoryRow {
  id: string;
  payment_group_id: string;
  supplier_id: string;
  receiving_id: string | null;
  amount: number;
  paid_at: string;
  method: string;
  reference_no: string | null;
  note: string | null;
  receipt_image_path: string | null;
  created_at: string;
}

const RECEIPTS_BUCKET = "receipts";

/** green → amber at ≥80% → red at ≥100% */
function utilTone(pct: number | null) {
  if (pct == null) return "bg-muted-foreground/40";
  if (pct >= 100) return "bg-destructive";
  if (pct >= 80) return "bg-warning";
  return "bg-success";
}

function UtilBar({ pct }: { pct: number | null }) {
  if (pct == null) {
    return <span className="text-xs text-muted-foreground">No limit</span>;
  }
  return (
    <div className="min-w-28">
      <div className="flex items-center justify-between text-xs">
        <span
          className={cn(
            "font-medium tabular-nums",
            pct >= 100 && "text-destructive",
            pct >= 80 && pct < 100 && "text-warning-foreground"
          )}
        >
          {pct}%
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", utilTone(pct))}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
}

/** Aging buckets by how far past due, in PH days. */
function agingBucket(r: ReceivingBalanceRow): "current" | "1-30" | "31-60" | "60+" {
  const d = r.days_overdue ?? -1;
  if (!r.overdue || d <= 0) return "current";
  if (d <= 30) return "1-30";
  if (d <= 60) return "31-60";
  return "60+";
}

export function PayablesView({
  suppliers,
  balances,
  payments,
  today,
}: {
  suppliers: SupplierPayableRow[];
  balances: ReceivingBalanceRow[];
  payments: PaymentHistoryRow[];
  today: string;
}) {
  const [detail, setDetail] = React.useState<SupplierPayableRow | null>(null);
  const [paying, setPaying] = React.useState<{
    supplier: SupplierPayableRow;
    receiving: ReceivingBalanceRow | null;
  } | null>(null);

  const owing = suppliers.filter((s) => s.outstanding > 0);
  const totalOwed = owing.reduce((s, r) => s + r.outstanding, 0);
  const totalOverdue = owing.reduce((s, r) => s + r.overdue_amount, 0);
  const nearOrOver = owing.filter(
    (s) => s.utilization_pct != null && s.utilization_pct >= 80
  ).length;

  const openBalances = balances.filter((b) => b.balance > 0);

  // aging rollup
  const aging = React.useMemo(() => {
    const buckets = { current: 0, "1-30": 0, "31-60": 0, "60+": 0 };
    for (const b of openBalances) buckets[agingBucket(b)] += b.balance;
    // severity gradient — centralized tokens (app/theme.css), never raw hex
    return [
      { bucket: "Current", amount: buckets.current, fill: "var(--aging-current)" },
      { bucket: "1–30 days", amount: buckets["1-30"], fill: "var(--aging-low)" },
      { bucket: "31–60 days", amount: buckets["31-60"], fill: "var(--aging-mid)" },
      { bucket: "60+ days", amount: buckets["60+"], fill: "var(--aging-high)" },
    ];
  }, [openBalances]);

  // controlled so the CSV button in the tab row knows which export to run
  const [tab, setTab] = React.useState("suppliers");

  const columns: ColumnDef<SupplierPayableRow>[] = [
    {
      accessorKey: "supplier_name",
      header: ({ column }) => <SortableHeader column={column}>Supplier</SortableHeader>,
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.supplier_name}</div>
          {row.original.contact && (
            <div className="text-xs text-muted-foreground">{row.original.contact}</div>
          )}
        </div>
      ),
    },
    {
      accessorKey: "outstanding",
      header: ({ column }) => <SortableHeader column={column}>We owe</SortableHeader>,
      cell: ({ getValue }) => (
        <span className="font-semibold tabular-nums">
          {formatCentavos(getValue<number>())}
        </span>
      ),
    },
    {
      accessorKey: "credit_limit",
      header: "Limit",
      cell: ({ getValue }) => {
        const v = getValue<number | null>();
        return v == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="tabular-nums">{formatCentavos(v)}</span>
        );
      },
    },
    {
      accessorKey: "utilization_pct",
      header: ({ column }) => <SortableHeader column={column}>Used</SortableHeader>,
      cell: ({ getValue }) => <UtilBar pct={getValue<number | null>()} />,
    },
    {
      accessorKey: "oldest_due_date",
      header: "Oldest due",
      cell: ({ getValue }) => {
        const d = getValue<string | null>();
        if (!d) return <span className="text-muted-foreground">—</span>;
        const late = d < today;
        return (
          <span className={cn("text-sm", late && "font-medium text-destructive")}>
            {format(new Date(d), "MMM d, yyyy")}
          </span>
        );
      },
    },
    {
      accessorKey: "overdue_amount",
      header: "Overdue",
      cell: ({ getValue }) => {
        const v = getValue<number>();
        return v > 0 ? (
          <span className="font-medium tabular-nums text-destructive">
            {formatCentavos(v)}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
    {
      accessorKey: "payment_terms_days",
      header: "Terms",
      cell: ({ getValue }) => {
        const d = getValue<number | null>();
        return d != null ? `Net ${d}` : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDetail(row.original)}>
            Detail
          </Button>
          <Button
            size="sm"
            disabled={row.original.outstanding <= 0}
            onClick={() => setPaying({ supplier: row.original, receiving: null })}
          >
            <HandCoins className="size-3.5" /> Pay
          </Button>
        </div>
      ),
    },
  ];

  const csvRows = owing.map((s) => ({
    supplier: s.supplier_name,
    outstanding: (s.outstanding / 100).toFixed(2),
    credit_limit: s.credit_limit != null ? (s.credit_limit / 100).toFixed(2) : "",
    utilization_pct: s.utilization_pct ?? "",
    overdue: (s.overdue_amount / 100).toFixed(2),
    oldest_due: s.oldest_due_date ?? "",
    terms: s.payment_terms_days != null ? `Net ${s.payment_terms_days}` : "",
  }));

  const agingCsv = openBalances.map((b) => ({
    supplier: b.supplier_name ?? "",
    received: b.received_at.slice(0, 10),
    due: b.due_date ?? "",
    bucket: agingBucket(b),
    days_overdue: b.overdue ? (b.days_overdue ?? 0) : 0,
    total: (b.total_amount / 100).toFixed(2),
    paid: ((b.amount_paid + b.paid_since) / 100).toFixed(2),
    balance: (b.balance / 100).toFixed(2),
  }));

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Supplier Payables</h1>
        <p className="text-sm text-muted-foreground">
          What you owe suppliers for stock. Debt starts when you receive on
          credit.
        </p>
      </div>

      {/* The one thing that quietly ruins the books if we don't say it */}
      <p className="flex items-start gap-2 rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Supplier payments are <span className="font-medium">stock cost (COGS)</span> and
          belong here — don&apos;t also log them in Expenses (that&apos;s for fuel,
          labour, rent). Recording them twice overstates expenses and hides your
          real margin.
        </span>
      </p>

      {/* Summary */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardDescription>Total owed</CardDescription>
            <Wallet className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatCentavos(totalOwed)}
            </div>
            <p className="text-xs text-muted-foreground">
              across {owing.length} supplier{owing.length === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>
        <Card className={totalOverdue > 0 ? "border-destructive" : ""}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardDescription>Overdue</CardDescription>
            <CalendarClock
              className={cn(
                "size-4",
                totalOverdue > 0 ? "text-destructive" : "text-muted-foreground"
              )}
            />
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                "text-2xl font-bold tabular-nums",
                totalOverdue > 0 && "text-destructive"
              )}
            >
              {formatCentavos(totalOverdue)}
            </div>
            <p className="text-xs text-muted-foreground">past the due date</p>
          </CardContent>
        </Card>
        <Card className={nearOrOver > 0 ? "border-warning" : ""}>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardDescription>Near / over limit</CardDescription>
            <AlertTriangle
              className={cn(
                "size-4",
                nearOrOver > 0 ? "text-warning-foreground" : "text-muted-foreground"
              )}
            />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{nearOrOver}</div>
            <p className="text-xs text-muted-foreground">supplier(s) at 80%+</p>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList>
            <TabsTrigger value="suppliers">
              By supplier<TabCountBadge count={owing.length} />
            </TabsTrigger>
            <TabsTrigger value="aging">Aging</TabsTrigger>
          </TabsList>
          <Button
            variant="outline"
            size="sm"
            disabled={tab === "aging" ? agingCsv.length === 0 : csvRows.length === 0}
            onClick={() =>
              tab === "aging"
                ? downloadCsv("payables_aging.csv", agingCsv)
                : downloadCsv("supplier_payables.csv", csvRows)
            }
          >
            <Download className="size-4" /> {tab === "aging" ? "Aging CSV" : "CSV"}
          </Button>
        </div>

        <TabsContent value="suppliers" className="pt-2">
          <DataTable
            columns={columns}
            data={suppliers}
            searchPlaceholder="Search supplier…"
            emptyMessage="No suppliers yet."
            rowClassName={(s) =>
              s.overdue_amount > 0
                ? "bg-destructive/5"
                : s.utilization_pct != null && s.utilization_pct >= 80
                  ? "bg-warning/5"
                  : undefined
            }
          />
        </TabsContent>

        <TabsContent value="aging" className="flex flex-col gap-4 pt-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Payables aging</CardTitle>
              <CardDescription>
                Open balances by how far past due (PH dates).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={aging}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="bucket" tickLine={false} axisLine={false} />
                    <YAxis
                      tickFormatter={(v) => `₱${(v / 100000).toFixed(0)}k`}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      formatter={(v) => formatCentavos(Number(v ?? 0))}
                      labelFormatter={(l) => String(l)}
                      cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                    />
                    <Bar dataKey="amount" radius={[6, 6, 0, 0]} maxBarSize={72}>
                      {aging.map((a, i) => (
                        <Cell key={i} fill={a.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 grid grid-cols-4 gap-2 text-center text-sm">
                {aging.map((a) => (
                  <div key={a.bucket} className="rounded-md border p-2">
                    <div className="text-xs text-muted-foreground">{a.bucket}</div>
                    <div className="font-semibold tabular-nums">
                      {formatCentavos(a.amount)}
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <SupplierDetail
        supplier={detail}
        balances={balances}
        payments={payments}
        onClose={() => setDetail(null)}
        onPay={(receiving) =>
          detail && setPaying({ supplier: detail, receiving })
        }
      />
      <PayDialog
        target={paying}
        balances={balances}
        onClose={() => setPaying(null)}
      />
    </div>
  );
}

function SupplierDetail({
  supplier,
  balances,
  payments,
  onClose,
  onPay,
}: {
  supplier: SupplierPayableRow | null;
  balances: ReceivingBalanceRow[];
  payments: PaymentHistoryRow[];
  onClose: () => void;
  onPay: (r: ReceivingBalanceRow | null) => void;
}) {
  if (!supplier) return null;
  const open = balances.filter(
    (b) => b.supplier_id === supplier.supplier_id && b.balance > 0
  );
  const hist = payments.filter((p) => p.supplier_id === supplier.supplier_id);

  return (
    <Dialog open={!!supplier} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{supplier.supplier_name}</DialogTitle>
          <DialogDescription>
            {formatCentavos(supplier.outstanding)} owed
            {supplier.credit_limit != null &&
              ` of a ${formatCentavos(supplier.credit_limit)} limit`}
            {supplier.payment_terms_days != null &&
              ` · Net ${supplier.payment_terms_days}`}
            {supplier.terms_note && ` · ${supplier.terms_note}`}
          </DialogDescription>
        </DialogHeader>

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Open receivings ({open.length})
          </h3>
          {open.length === 0 && (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              Nothing outstanding — all settled.
            </p>
          )}
          {open.map((b) => (
            <div
              key={b.receiving_id}
              className={cn(
                "flex flex-wrap items-center gap-3 rounded-md border px-3 py-2",
                b.overdue && "border-destructive bg-destructive/5"
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {format(new Date(b.received_at), "MMM d, yyyy")}
                  {b.limit_override && (
                    <Badge variant="outline" className="ml-2 border-warning/50">
                      over-limit override
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {b.note ?? "Receiving"}
                  {b.due_date && ` · due ${format(new Date(b.due_date), "MMM d")}`}
                  {b.overdue && (
                    <span className="ml-1 font-medium text-destructive">
                      · {b.days_overdue}d overdue
                    </span>
                  )}
                </div>
                {b.limit_override_reason && (
                  <div className="text-xs italic text-muted-foreground">
                    “{b.limit_override_reason}”
                  </div>
                )}
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div>
                  {formatCentavos(b.total_amount)} total ·{" "}
                  {formatCentavos(b.amount_paid + b.paid_since)} paid
                </div>
                <div className="text-base font-semibold tabular-nums text-foreground">
                  {formatCentavos(b.balance)}
                </div>
              </div>
              <Button size="sm" variant="outline" onClick={() => onPay(b)}>
                Pay this
              </Button>
            </div>
          ))}
          <div className="flex justify-end">
            <Button size="sm" onClick={() => onPay(null)} disabled={open.length === 0}>
              <HandCoins className="size-3.5" /> Pay oldest first (FIFO)
            </Button>
          </div>
        </section>

        <section className="flex flex-col gap-2 border-t pt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Payment history ({hist.length})
          </h3>
          {hist.length === 0 ? (
            <p className="text-sm text-muted-foreground">No payments yet.</p>
          ) : (
            <div className="flex flex-col gap-1 text-xs">
              {hist.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
                >
                  <span className="text-muted-foreground">
                    {format(new Date(p.paid_at), "MMM d, yyyy")} ·{" "}
                    <Badge variant="outline">{p.method}</Badge>
                    {p.reference_no && ` · ${p.reference_no}`}
                  </span>
                  <span className="font-medium tabular-nums text-success">
                    {formatCentavos(p.amount)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}

function PayDialog({
  target,
  balances,
  onClose,
}: {
  target: { supplier: SupplierPayableRow; receiving: ReceivingBalanceRow | null } | null;
  balances: ReceivingBalanceRow[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [amount, setAmount] = React.useState("");
  const [method, setMethod] = React.useState("cash");
  const [ref, setRef] = React.useState("");
  const [note, setNote] = React.useState("");
  const [receipt, setReceipt] = React.useState<ImageAction>({ type: "keep" });
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (target) {
      setAmount("");
      setMethod("cash");
      setRef("");
      setNote("");
      setReceipt({ type: "keep" });
    }
  }, [target]);

  if (!target) return null;
  const max = target.receiving ? target.receiving.balance : target.supplier.outstanding;
  const amountC = parsePesosToCentavos(amount || "0") ?? 0;
  const tooMuch = amountC > max;
  const after = Math.max(0, max - amountC);

  async function onSave() {
    if (!target) return;
    if (amountC <= 0) {
      toast.error("Enter the amount you paid");
      return;
    }
    if (tooMuch) {
      toast.error(`That's more than the ${formatCentavos(max)} owed`);
      return;
    }
    setBusy(true);

    // optional proof of payment → PRIVATE receipts bucket (owner-only read)
    let path: string | null = null;
    if (receipt.type === "set") {
      const supabase = createClient();
      path = `supplier-${target.supplier.supplier_id}-${Date.now()}.webp`;
      const { error } = await supabase.storage
        .from(RECEIPTS_BUCKET)
        .upload(path, receipt.image.blob, {
          contentType: "image/webp",
          cacheControl: "31536000",
        });
      if (error) {
        setBusy(false);
        toast.error(`Receipt upload failed: ${error.message}`);
        return;
      }
    }

    const res = await recordSupplierPayment({
      supplier_id: target.supplier.supplier_id,
      amount_centavos: amountC,
      receiving_id: target.receiving?.receiving_id ?? null,
      method,
      reference_no: ref.trim() || null,
      note: note.trim() || null,
      receipt_image_path: path,
    });
    setBusy(false);
    if (res.ok) {
      const n = res.allocations.length;
      toast.success(
        target.receiving
          ? `Paid — ${formatCentavos(amountC)} applied`
          : `Paid — allocated across ${n} receiving${n === 1 ? "" : "s"}, oldest first`
      );
      onClose();
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            {target.supplier.supplier_name} —{" "}
            {target.receiving ? (
              <>
                paying one receiving from{" "}
                {format(new Date(target.receiving.received_at), "MMM d, yyyy")} (
                {formatCentavos(max)} owed)
              </>
            ) : (
              <>
                {formatCentavos(max)} owed — this will be applied to the oldest
                receivings first
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="pay-amt">Amount ₱</Label>
            <Input
              id="pay-amt"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              placeholder="0.00"
              className="text-base tabular-nums"
              autoFocus
            />
            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAmount((max / 100).toFixed(2))}
              >
                Pay all ({formatCentavos(max)})
              </Button>
              {tooMuch ? (
                <span className="text-xs font-medium text-destructive">
                  More than the {formatCentavos(max)} owed
                </span>
              ) : (
                amountC > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Balance after:{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {formatCentavos(after)}
                    </span>
                  </span>
                )
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Method</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">Cash</SelectItem>
                  <SelectItem value="bank">Bank transfer</SelectItem>
                  <SelectItem value="gcash">GCash</SelectItem>
                  <SelectItem value="check">Check</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="pay-ref">Reference no</Label>
              <Input
                id="pay-ref"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="pay-note">Note</Label>
            <Textarea
              id="pay-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="optional"
            />
          </div>

          <div className="grid gap-1.5">
            <Label>Proof of payment (optional)</Label>
            <ImageUploadField
              currentPath={null}
              action={receipt}
              onActionChange={setReceipt}
            />
            <p className="text-xs text-muted-foreground">
              Stored privately — only you can see it.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy || tooMuch || amountC <= 0}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Record payment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
