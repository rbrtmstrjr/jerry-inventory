"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  ArrowLeft,
  BadgeCheck,
  Banknote,
  FileText,
  Loader2,
  Lock,
  LockOpen,
  Save,
} from "lucide-react";
import { toast } from "sonner";

import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  approvePayPeriod,
  markPayrollPaid,
  savePayrollDays,
  setPayPeriodStatus,
} from "../actions";

export interface PeriodInfo {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  frequency: "weekly" | "semi_monthly" | "monthly";
  status: "open" | "finalized";
}

export interface EntryRow {
  id: string;
  staff_name: string;
  position: string | null;
  pay_type: "daily" | "monthly";
  pay_rate: number;
  shop_id: string;
  shop_name: string;
  days_worked: number;
  net_pay: number;
  status: "draft" | "approved" | "paid";
  date_paid: string | null;
}

const STATUS_BADGE: Record<
  EntryRow["status"],
  { label: string; variant: "default" | "secondary" | "outline" }
> = {
  draft: { label: "Draft", variant: "outline" },
  approved: { label: "Approved", variant: "secondary" },
  paid: { label: "Paid", variant: "default" },
};

export function PeriodDetail({
  period,
  entries,
  shops,
}: {
  period: PeriodInfo;
  entries: EntryRow[];
  shops: { id: string; name: string }[];
}) {
  const locked = period.status === "finalized";
  const [shopFilter, setShopFilter] = React.useState("all");
  const [days, setDays] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(entries.map((e) => [e.id, String(e.days_worked)]))
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmFinalize, setConfirmFinalize] = React.useState(false);

  const visible =
    shopFilter === "all"
      ? entries
      : entries.filter((e) => e.shop_id === shopFilter);

  const totalNet = entries.reduce((s, e) => s + e.net_pay, 0);
  const draftCount = entries.filter((e) => e.status === "draft").length;
  const approvedCount = entries.filter((e) => e.status === "approved").length;
  const paidCount = entries.filter((e) => e.status === "paid").length;

  const dirty = entries.some(
    (e) =>
      e.pay_type === "daily" &&
      e.status !== "paid" &&
      String(e.days_worked) !== (days[e.id] ?? "0")
  );

  async function onSaveDays() {
    const lines = entries
      .filter((e) => e.pay_type === "daily" && e.status !== "paid")
      .map((e) => ({
        entry_id: e.id,
        days_worked: parseFloat(days[e.id] || "0") || 0,
      }));
    setBusy("save");
    const res = await savePayrollDays({ period_id: period.id, lines });
    setBusy(null);
    if (res.ok) toast.success("Days saved — pay recomputed");
    else toast.error(res.error);
  }

  async function onApprove() {
    setBusy("approve");
    const res = await approvePayPeriod(period.id);
    setBusy(null);
    if (res.ok) toast.success(`${res.count} line(s) approved`);
    else toast.error(res.error);
  }

  async function onPayAll() {
    setBusy("payall");
    const res = await markPayrollPaid(period.id, "all");
    setBusy(null);
    if (res.ok) toast.success(`${res.count} line(s) marked paid`);
    else toast.error(res.error);
  }

  async function onPayOne(id: string) {
    setBusy(id);
    const res = await markPayrollPaid(period.id, [id]);
    setBusy(null);
    if (res.ok) toast.success("Marked paid");
    else toast.error(res.error);
  }

  async function onToggleLock() {
    setBusy("lock");
    const res = await setPayPeriodStatus(period.id, !locked);
    setBusy(null);
    if (res.ok) toast.success(locked ? "Period reopened" : "Period finalized");
    else toast.error(res.error);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" className="-ml-2 mb-1" asChild>
            <Link href="/payroll">
              <ArrowLeft className="size-4" /> Pay periods
            </Link>
          </Button>
          <h2 className="text-xl font-semibold tracking-tight">
            {period.label}
            {locked && (
              <Badge variant="secondary" className="ml-2">
                <Lock className="size-3" /> Finalized
              </Badge>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            {format(new Date(period.start_date), "MMM d")} –{" "}
            {format(new Date(period.end_date), "MMM d, yyyy")} · total{" "}
            <span className="font-medium tabular-nums text-foreground">
              {formatCentavos(totalNet)}
            </span>{" "}
            · {paidCount}/{entries.length} paid
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!locked && (
            <>
              <Button
                variant="outline"
                onClick={onSaveDays}
                disabled={busy !== null || !dirty}
              >
                {busy === "save" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Save className="size-4" />
                )}
                Save days
              </Button>
              <Button
                variant="outline"
                onClick={onApprove}
                disabled={busy !== null || draftCount === 0 || dirty}
              >
                {busy === "approve" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <BadgeCheck className="size-4" />
                )}
                Approve {draftCount > 0 ? `(${draftCount})` : ""}
              </Button>
              <Button
                onClick={onPayAll}
                disabled={busy !== null || approvedCount === 0}
              >
                {busy === "payall" ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Banknote className="size-4" />
                )}
                Mark all paid {approvedCount > 0 ? `(${approvedCount})` : ""}
              </Button>
            </>
          )}
          <Button
            variant={locked ? "outline" : "secondary"}
            onClick={() => (locked ? onToggleLock() : setConfirmFinalize(true))}
            disabled={busy !== null}
          >
            {busy === "lock" ? (
              <Loader2 className="size-4 animate-spin" />
            ) : locked ? (
              <LockOpen className="size-4" />
            ) : (
              <Lock className="size-4" />
            )}
            {locked ? "Reopen" : "Finalize"}
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Select value={shopFilter} onValueChange={setShopFilter}>
          <SelectTrigger className="w-52">
            <SelectValue />
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
        <span className="text-xs text-muted-foreground tabular-nums">
          {visible.length} of {entries.length} staff
        </span>
      </div>

      <div className="thin-scrollbar max-h-[62vh] overflow-auto rounded-md border">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)] [&_tr]:border-b-0">
            <TableRow>
              <TableHead>Staff</TableHead>
              <TableHead>Shop</TableHead>
              <TableHead>Rate</TableHead>
              <TableHead className="w-28">Days worked</TableHead>
              <TableHead className="text-right">Pay</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-40" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((e) => {
              const s = STATUS_BADGE[e.status];
              const editable = !locked && e.status !== "paid" && e.pay_type === "daily";
              return (
                <TableRow key={e.id}>
                  <TableCell>
                    <div className="font-medium">{e.staff_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {e.position ?? "—"}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{e.shop_name}</TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {formatCentavos(e.pay_rate)}
                    <span className="text-xs text-muted-foreground">
                      {e.pay_type === "daily" ? "/day" : "/mo"}
                    </span>
                  </TableCell>
                  <TableCell>
                    {e.pay_type === "daily" ? (
                      <Input
                        inputMode="decimal"
                        className="w-24"
                        value={days[e.id] ?? "0"}
                        disabled={!editable}
                        onChange={(ev) => {
                          const raw = ev.target.value.replace(/[^\d.]/g, "");
                          setDays((d) => ({ ...d, [e.id]: raw }));
                        }}
                        aria-label={`Days worked by ${e.staff_name}`}
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        salary
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatCentavos(e.net_pay)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={s.variant}>{s.label}</Badge>
                    {e.date_paid && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {format(new Date(e.date_paid), "MMM d")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {!locked && e.status === "approved" && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy !== null}
                          onClick={() => onPayOne(e.id)}
                        >
                          {busy === e.id ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Banknote className="size-4" />
                          )}
                          Pay
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/payroll/payslip/${e.id}`} target="_blank">
                          <FileText className="size-4" /> Payslip
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {dirty && !locked && (
        <p className="text-xs text-warning-foreground">
          Unsaved day changes — click “Save days” before approving.
        </p>
      )}

      <ConfirmDialog
        open={confirmFinalize}
        onOpenChange={setConfirmFinalize}
        title={`Finalize “${period.label}”?`}
        description="Locks the period against any further edits. You can reopen it later if something was wrong."
        confirmLabel="Finalize"
        onConfirm={onToggleLock}
      />
    </div>
  );
}
