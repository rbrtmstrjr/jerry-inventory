"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  CheckCircle2,
  ChevronDown,
  HandCoins,
  Loader2,
  Printer,
  Search,
  Undo2,
  Wallet,
} from "lucide-react";
import { toast } from "sonner";

import type { ReceivableRow } from "@/lib/db-types";
import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ConfirmDialog } from "@/components/confirm-dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { recordUtangPayment, voidUtangPayment } from "../actions";

export interface PaymentRow {
  id: string;
  sale_id: string;
  amount_centavos: number;
  note: string | null;
  owner_note: string | null;
  created_at: string;
  voided: boolean;
  recorded_by: string;
}

export function ShopReceivablesView({
  rows,
  payments,
}: {
  rows: ReceivableRow[];
  payments: PaymentRow[];
}) {
  const [search, setSearch] = React.useState("");
  const [target, setTarget] = React.useState<ReceivableRow | null>(null);

  const historyBySale = React.useMemo(() => {
    const m = new Map<string, PaymentRow[]>();
    for (const p of payments) {
      const list = m.get(p.sale_id) ?? [];
      list.push(p);
      m.set(p.sale_id, list);
    }
    return m;
  }, [payments]);

  const open = rows.filter((r) => r.balance_centavos > 0);
  const settled = rows.filter((r) => r.balance_centavos <= 0);

  const q = search.trim().toLowerCase();
  const match = (r: ReceivableRow) =>
    !q ||
    (r.customer_name ?? "").toLowerCase().includes(q) ||
    (r.description ?? "").toLowerCase().includes(q) ||
    (r.receipt_no ?? "").toLowerCase().includes(q);

  const openMatches = open.filter(match);
  const settledMatches = settled.filter(match);

  const totalOutstanding = open.reduce((s, r) => s + r.balance_centavos, 0);
  const collected = payments
    .filter((p) => !p.voided)
    .reduce((s, p) => s + p.amount_centavos, 0);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          Receivables (Utang)
        </h1>
        <p className="text-sm text-muted-foreground">
          Balances your customers still owe. Record a payment when they pay —
          it applies straight away and Admin sees it in their receivables.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardDescription>Total outstanding</CardDescription>
            <Wallet className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {formatCentavos(totalOutstanding)}
            </div>
            <p className="text-xs text-muted-foreground">
              {open.length} customer{open.length === 1 ? "" : "s"} owing
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardDescription>Collected so far</CardDescription>
            <HandCoins className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums text-success">
              {formatCentavos(collected)}
            </div>
            <p className="text-xs text-muted-foreground">
              {payments.filter((p) => !p.voided).length} payment
              {payments.filter((p) => !p.voided).length === 1 ? "" : "s"} recorded
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customer, item, or receipt no…"
          className="pl-8"
          aria-label="Search receivables"
        />
      </div>

      <Tabs defaultValue="open">
        <TabsList>
          <TabsTrigger value="open">Open ({open.length})</TabsTrigger>
          <TabsTrigger value="settled">Fully paid ({settled.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="flex flex-col gap-3 pt-2">
          {openMatches.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {open.length === 0
                ? "No outstanding balances — everyone's paid up."
                : "No matches."}
            </p>
          )}
          {openMatches.map((r) => (
            <ReceivableCard
              key={r.sale_id}
              row={r}
              history={historyBySale.get(r.sale_id) ?? []}
              onRecord={() => setTarget(r)}
            />
          ))}
        </TabsContent>

        <TabsContent value="settled" className="flex flex-col gap-3 pt-2">
          {settledMatches.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nothing fully paid yet.
            </p>
          )}
          {settledMatches.map((r) => (
            <ReceivableCard
              key={r.sale_id}
              row={r}
              history={historyBySale.get(r.sale_id) ?? []}
            />
          ))}
        </TabsContent>
      </Tabs>

      <RecordPaymentDialog row={target} onClose={() => setTarget(null)} />
    </div>
  );
}

function ReceivableCard({
  row,
  history,
  onRecord,
}: {
  row: ReceivableRow;
  history: PaymentRow[];
  onRecord?: () => void;
}) {
  const router = useRouter();
  const [showHistory, setShowHistory] = React.useState(false);
  const [voiding, setVoiding] = React.useState<PaymentRow | null>(null);
  const [busy, setBusy] = React.useState(false);
  const paidOff = row.balance_centavos <= 0;
  const live = history.filter((h) => !h.voided);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">
              {row.customer_name ?? "Walk-in"}
              {paidOff && (
                <Badge variant="default" className="ml-2">
                  <CheckCircle2 className="size-3" /> Paid
                </Badge>
              )}
              {row.sale_status !== "approved" && !paidOff && (
                <Badge variant="outline" className="ml-2">
                  Sale not yet approved
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {row.customer_phone && `${row.customer_phone} · `}
              {format(new Date(row.created_at), "MMM d, yyyy")}
              {row.receipt_no && ` · ${row.receipt_no}`}
            </CardDescription>
          </div>
          <div className="text-right">
            <div
              className={`text-lg font-bold tabular-nums ${
                paidOff ? "text-success" : "text-warning-foreground"
              }`}
            >
              {formatCentavos(Math.max(0, row.balance_centavos))}
            </div>
            <div className="text-xs text-muted-foreground">balance</div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {row.description && (
          <p className="truncate text-muted-foreground">{row.description}</p>
        )}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>Total {formatCentavos(row.total_centavos)}</span>
          <span>Down {formatCentavos(row.amount_paid_centavos)}</span>
          {row.paid_since_centavos > 0 && (
            <span className="text-success">
              Paid since {formatCentavos(row.paid_since_centavos)}
            </span>
          )}
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button asChild variant="outline" size="sm">
            <Link href={`/receipt/${row.sale_id}`} target="_blank">
              <Printer className="size-3.5" /> Receipt
            </Link>
          </Button>
          {history.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowHistory((o) => !o)}
            >
              <ChevronDown
                className={`size-3.5 transition-transform ${showHistory ? "rotate-180" : ""}`}
              />
              History ({live.length})
            </Button>
          )}
          {onRecord && !paidOff && (
            <Button size="sm" onClick={onRecord}>
              <HandCoins className="size-3.5" /> Record payment
            </Button>
          )}
        </div>

        {showHistory && history.length > 0 && (
          <div className="flex flex-col gap-1 rounded-md border p-2 text-xs">
            {history.map((h) => (
              <div key={h.id} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate text-muted-foreground">
                  {format(new Date(h.created_at), "MMM d, yyyy h:mm a")} ·{" "}
                  {h.recorded_by}
                  {h.voided && h.owner_note && ` · ${h.owner_note}`}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span
                    className={`tabular-nums font-medium ${
                      h.voided ? "text-muted-foreground line-through" : ""
                    }`}
                  >
                    {formatCentavos(h.amount_centavos)}
                  </span>
                  {h.voided ? (
                    <Badge variant="outline">Voided</Badge>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Void payment"
                      disabled={busy}
                      onClick={() => setVoiding(h)}
                    >
                      <Undo2 className="size-3.5" />
                    </Button>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={voiding !== null}
        onOpenChange={(o) => !o && setVoiding(null)}
        title="Void this payment?"
        description="Use this for a mistake or typo. The balance goes straight back up, the entry stays in the history, and Admin is told."
        confirmLabel="Yes, void it"
        destructive
        onConfirm={async () => {
          if (!voiding) return;
          setBusy(true);
          const res = await voidUtangPayment(voiding.id, "Voided by the shop");
          setBusy(false);
          if (res.ok) {
            toast.success("Payment voided — balance restored");
            router.refresh();
          } else toast.error(res.error);
        }}
      />
    </Card>
  );
}

function RecordPaymentDialog({
  row,
  onClose,
}: {
  row: ReceivableRow | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [amount, setAmount] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (row) setAmount("");
  }, [row]);

  const balance = row?.balance_centavos ?? 0;
  const amountC = parsePesosToCentavos(amount || "0") ?? 0;
  const tooMuch = amountC > balance;

  async function onSave() {
    if (!row) return;
    if (amountC <= 0) {
      toast.error("Enter the amount the customer paid");
      return;
    }
    if (tooMuch) {
      toast.error(`That's more than the ${formatCentavos(balance)} balance`);
      return;
    }
    setBusy(true);
    const res = await recordUtangPayment({
      sale_id: row.sale_id,
      amount_centavos: amountC,
    });
    setBusy(false);
    if (res.ok) {
      toast.success(
        amountC === balance
          ? "Fully paid — utang settled"
          : `Payment recorded — balance now ${formatCentavos(balance - amountC)}`
      );
      onClose();
      router.refresh();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record payment</DialogTitle>
          <DialogDescription>
            {row?.customer_name ?? "Walk-in"} — balance {formatCentavos(balance)}.
            This applies right away and shows in Admin&apos;s receivables.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          <Label htmlFor="pay-amount">Amount paid ₱</Label>
          <Input
            id="pay-amount"
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
              onClick={() => setAmount((balance / 100).toFixed(2))}
            >
              Full balance ({formatCentavos(balance)})
            </Button>
            {tooMuch && (
              <p className="text-xs font-medium text-destructive">
                More than the {formatCentavos(balance)} owed
              </p>
            )}
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
