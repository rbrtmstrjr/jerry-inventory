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

import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import type { EntryContribution, RemittanceTotal } from "@/lib/db-types";
import {
  AGENCY_LABEL,
  AGENCY_ORDER,
  byAgency,
  employerShare,
} from "@/lib/contributions";
import { Badge } from "@/components/ui/badge";
import { ShopBadge } from "@/components/shop-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  saveEntryContributions,
  savePayrollDays,
  savePayrollVale,
  setPayPeriodStatus,
} from "../actions";

export interface PeriodInfo {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  frequency: "weekly" | "semi_monthly" | "monthly";
  status: "open" | "finalized";
  /** semi-monthly per-run choice: does this run withhold gov benefits? null =
   *  legacy (date/split setting). */
  deduct_contributions: boolean | null;
}

export interface EntryRow {
  id: string;
  staff_name: string;
  position: string | null;
  pay_type: "daily" | "monthly";
  pay_rate: number;
  shop_id: string;
  shop_name: string;
  shop_color_key: string | null;
  days_worked: number;
  gross_pay: number;
  /** Computed by the DB as gross − employee shares. Read it, never recompute it. */
  net_pay: number;
  contributions_enabled: boolean;
  /** Frozen snapshot rows — one per agency, or empty when not enrolled. */
  contributions: EntryContribution[];
  /** Cash-advance (vale) deducted on this payslip (frozen). */
  vale_centavos: number;
  /** Staffer's outstanding advance balance (Σ advances − Σ vale). */
  advance_balance: number;
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
  remittance,
}: {
  period: PeriodInfo;
  entries: EntryRow[];
  shops: { id: string; name: string }[];
  remittance: RemittanceTotal[];
}) {
  const locked = period.status === "finalized";
  const [shopFilter, setShopFilter] = React.useState("all");
  const [days, setDays] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(entries.map((e) => [e.id, String(e.days_worked)]))
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmFinalize, setConfirmFinalize] = React.useState(false);
  const [valeFor, setValeFor] = React.useState<EntryRow | null>(null);
  const [contribFor, setContribFor] = React.useState<EntryRow | null>(null);

  const visible =
    shopFilter === "all"
      ? entries
      : entries.filter((e) => e.shop_id === shopFilter);

  const totalGross = entries.reduce((s, e) => s + e.gross_pay, 0);
  const totalNet = entries.reduce((s, e) => s + e.net_pay, 0);
  const totalVale = entries.reduce((s, e) => s + e.vale_centavos, 0);
  // Summing frozen snapshots — not recomputing anything from the rate book.
  const totalEE = remittance.reduce((s, r) => s + r.ee_total_centavos, 0);
  const totalER = remittance.reduce((s, r) => s + r.er_total_centavos, 0);
  const remitByAgency = Object.fromEntries(remittance.map((r) => [r.agency, r]));
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
            {format(new Date(period.end_date), "MMM d, yyyy")} · net{" "}
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

      {period.deduct_contributions === false && (
        <p className="rounded-md border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          Government benefits are <span className="font-medium">not withheld</span>{" "}
          on this run — they&apos;re deducted in full on the month&apos;s other
          semi-monthly run.
        </p>
      )}

      <div className="thin-scrollbar max-h-[62vh] overflow-auto rounded-md border">
        <Table>
          {/* The grouped header carries the whole point: the middle three
              columns come OFF the worker's pay; the employer column does not. */}
          <TableHeader className="sticky top-0 z-10 bg-card shadow-[inset_0_-1px_0_var(--border)] [&_tr]:border-b-0">
            <TableRow>
              <TableHead rowSpan={2}>Staff</TableHead>
              <TableHead rowSpan={2}>Shop</TableHead>
              <TableHead rowSpan={2}>Rate</TableHead>
              <TableHead rowSpan={2} className="w-28">
                Days worked
              </TableHead>
              <TableHead rowSpan={2} className="text-right">
                Gross
              </TableHead>
              <TableHead colSpan={3} className="border-x text-center">
                Employee share — deducted
              </TableHead>
              <TableHead rowSpan={2} className="text-right">
                Vale
                <div className="text-[10px] font-normal normal-case text-muted-foreground">
                  cash advance
                </div>
              </TableHead>
              <TableHead rowSpan={2} className="text-right">
                Net pay
              </TableHead>
              <TableHead rowSpan={2} className="border-l text-right">
                Employer cost
                <div className="text-[10px] font-normal normal-case text-muted-foreground">
                  not deducted
                </div>
              </TableHead>
              <TableHead rowSpan={2}>Status</TableHead>
              <TableHead rowSpan={2} className="w-40" />
            </TableRow>
            <TableRow>
              {AGENCY_ORDER.map((a, i) => (
                <TableHead
                  key={a}
                  className={`text-right text-xs font-normal ${
                    i === 0 ? "border-l" : ""
                  } ${i === AGENCY_ORDER.length - 1 ? "border-r" : ""}`}
                >
                  {AGENCY_LABEL[a]}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((e) => {
              const s = STATUS_BADGE[e.status];
              const editable = !locked && e.status !== "paid" && e.pay_type === "daily";
              const contrib = byAgency(e.contributions);
              const erTotal = employerShare(e.contributions);
              return (
                <TableRow key={e.id}>
                  <TableCell>
                    <div className="font-medium">{e.staff_name}</div>
                    <div className="text-xs text-muted-foreground">
                      {e.position ?? "—"}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">
                    <ShopBadge shop={{ name: e.shop_name, color_key: e.shop_color_key }} />
                  </TableCell>
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
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatCentavos(e.gross_pay)}
                  </TableCell>
                  {AGENCY_ORDER.map((a, i) => {
                    const c = contrib[a];
                    // enrolled staff with a snapshot row can have this edited
                    const canEditContrib =
                      !locked && e.status !== "paid" && !!c;
                    const label = c ? (
                      c.ee_amount_centavos > 0 ? (
                        `−${formatCentavos(c.ee_amount_centavos)}`
                      ) : (
                        formatCentavos(0)
                      )
                    ) : null;
                    return (
                      <TableCell
                        key={a}
                        className={`text-right text-sm tabular-nums ${
                          i === 0 ? "border-l" : ""
                        } ${i === AGENCY_ORDER.length - 1 ? "border-r" : ""}`}
                      >
                        {label === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : canEditContrib ? (
                          <button
                            type="button"
                            className="tabular-nums underline decoration-dotted underline-offset-2 hover:text-primary"
                            onClick={() => setContribFor(e)}
                            title="Edit government contribution"
                          >
                            {label}
                          </button>
                        ) : (
                          <span>{label}</span>
                        )}
                      </TableCell>
                    );
                  })}
                  <TableCell className="text-right text-sm tabular-nums">
                    {e.vale_centavos > 0 ? (
                      <span className="text-warning-foreground">
                        −{formatCentavos(e.vale_centavos)}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {!locked && e.status !== "paid" &&
                      (e.advance_balance > 0 || e.vale_centavos > 0) && (
                        <button
                          type="button"
                          className="block w-full text-right text-[11px] text-primary underline-offset-2 hover:underline"
                          onClick={() => setValeFor(e)}
                        >
                          {e.vale_centavos > 0 ? "Edit" : "Deduct"}
                        </button>
                      )}
                    {e.advance_balance > 0 && (
                      <div className="text-[10px] text-muted-foreground">
                        {formatCentavos(e.advance_balance)} left
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums font-medium">
                    {formatCentavos(e.net_pay)}
                    {!e.contributions_enabled && (
                      <div className="text-[10px] font-normal text-muted-foreground">
                        not enrolled
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="border-l text-right text-sm tabular-nums text-muted-foreground">
                    {erTotal > 0 ? formatCentavos(erTotal) : "—"}
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

      {/* Period totals. Every figure is a sum of frozen snapshots. */}
      <div className="rounded-md border">
        <div className="border-b px-4 py-3">
          <h3 className="text-sm font-semibold">Period totals</h3>
          <p className="text-xs text-muted-foreground">
            Employee shares come out of gross pay. Employer shares are the
            business’s own cost — they are remitted alongside, never deducted
            from anyone’s pay.
          </p>
        </div>

        <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <div className="text-xs uppercase text-muted-foreground">Gross</div>
            <div className="text-lg font-semibold tabular-nums">
              {formatCentavos(totalGross)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">
              Employee deductions
            </div>
            <div className="text-lg font-semibold tabular-nums">
              −{formatCentavos(totalEE)}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">
              Vale (advances)
            </div>
            <div className="text-lg font-semibold tabular-nums">
              {totalVale > 0 ? `−${formatCentavos(totalVale)}` : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase text-muted-foreground">
              Net pay to staff
            </div>
            <div className="text-lg font-semibold tabular-nums">
              {formatCentavos(totalNet)}
            </div>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agency</TableHead>
              <TableHead className="text-right">Staff</TableHead>
              <TableHead className="text-right">Employee (deducted)</TableHead>
              <TableHead className="text-right">
                Employer (business cost)
              </TableHead>
              <TableHead className="text-right">Total to remit</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {AGENCY_ORDER.map((a) => {
              const r = remitByAgency[a];
              return (
                <TableRow key={a}>
                  <TableCell className="font-medium">{AGENCY_LABEL[a]}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r?.staff_count ?? 0}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r?.ee_total_centavos ?? 0)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {formatCentavos(r?.er_total_centavos ?? 0)}
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatCentavos(r?.total_centavos ?? 0)}
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow className="bg-muted/40">
              <TableCell className="font-semibold">All agencies</TableCell>
              <TableCell />
              <TableCell className="text-right font-semibold tabular-nums">
                {formatCentavos(totalEE)}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                {formatCentavos(totalER)}
              </TableCell>
              <TableCell className="text-right font-semibold tabular-nums">
                {formatCentavos(totalEE + totalER)}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>

        <p className="border-t px-4 py-3 text-xs text-muted-foreground">
          Total cash out this period:{" "}
          <span className="font-medium tabular-nums text-foreground">
            {formatCentavos(totalNet + totalEE + totalER)}
          </span>{" "}
          — {formatCentavos(totalNet)} net pay to staff plus{" "}
          {formatCentavos(totalEE + totalER)} remitted to the agencies.
        </p>
      </div>

      <ConfirmDialog
        open={confirmFinalize}
        onOpenChange={setConfirmFinalize}
        title={`Finalize “${period.label}”?`}
        description="Locks the period against any further edits. You can reopen it later if something was wrong."
        confirmLabel="Finalize"
        onConfirm={onToggleLock}
      />

      <ValeDialog
        entry={valeFor}
        periodId={period.id}
        onClose={() => setValeFor(null)}
      />

      <ContributionsDialog
        entry={contribFor}
        periodId={period.id}
        onClose={() => setContribFor(null)}
      />
    </div>
  );
}

/** Edit the three government employee-share amounts for one enrolled staffer —
 *  the probationary override. Prefilled from the current snapshot; Save writes
 *  all three (₱0 = withheld nothing this period), and net recomputes. */
function ContributionsDialog({
  entry,
  periodId,
  onClose,
}: {
  entry: EntryRow | null;
  periodId: string;
  onClose: () => void;
}) {
  const [amounts, setAmounts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!entry) return;
    const c = byAgency(entry.contributions);
    setAmounts(
      Object.fromEntries(
        AGENCY_ORDER.map((a) => [
          a,
          ((c[a]?.ee_amount_centavos ?? 0) / 100).toFixed(2),
        ])
      )
    );
  }, [entry]);

  async function onSave() {
    if (!entry) return;
    const payload: Record<string, number> = {};
    for (const a of AGENCY_ORDER) {
      payload[a] = parsePesosToCentavos(amounts[a] || "0") ?? 0;
    }
    setBusy(true);
    const res = await saveEntryContributions(entry.id, periodId, payload);
    setBusy(false);
    if (res.ok) {
      toast.success("Contributions updated — net recomputed");
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Dialog open={entry !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Government contributions — {entry?.staff_name}</DialogTitle>
          <DialogDescription>
            Employee share deducted this period. Set to ₱0 for a staffer still on
            probation. Employer share and the rate book are unchanged.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {AGENCY_ORDER.map((a) => (
            <div key={a} className="grid grid-cols-[7rem_1fr] items-center gap-2">
              <Label htmlFor={`contrib-${a}`}>{AGENCY_LABEL[a]} ₱</Label>
              <Input
                id={`contrib-${a}`}
                inputMode="decimal"
                value={amounts[a] ?? ""}
                onChange={(ev) =>
                  setAmounts((m) => ({
                    ...m,
                    [a]: ev.target.value.replace(/[^\d.]/g, ""),
                  }))
                }
                className="tabular-nums"
              />
            </div>
          ))}
          <button
            type="button"
            className="self-start text-xs text-primary underline-offset-2 hover:underline"
            onClick={() =>
              setAmounts(Object.fromEntries(AGENCY_ORDER.map((a) => [a, "0.00"])))
            }
          >
            Set all to ₱0 (probation)
          </button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Set how much of a staffer's outstanding vale to deduct on this payslip.
 *  The server caps it to available net + the balance and returns what applied. */
function ValeDialog({
  entry,
  periodId,
  onClose,
}: {
  entry: EntryRow | null;
  periodId: string;
  onClose: () => void;
}) {
  const [amount, setAmount] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (entry) {
      setAmount(entry.vale_centavos > 0 ? (entry.vale_centavos / 100).toFixed(2) : "");
    }
  }, [entry]);

  const requested = parsePesosToCentavos(amount || "0") ?? 0;

  async function onSave() {
    if (!entry) return;
    setBusy(true);
    const res = await savePayrollVale(entry.id, periodId, requested);
    setBusy(false);
    if (res.ok) {
      const applied = res.count ?? 0;
      toast.success(
        applied < requested
          ? `Deducted ${formatCentavos(applied)} — capped to available net / balance`
          : `Vale deduction set to ${formatCentavos(applied)}`
      );
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Dialog open={entry !== null} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Vale deduction — {entry?.staff_name}</DialogTitle>
          <DialogDescription>
            Outstanding balance {formatCentavos(entry?.advance_balance ?? 0)}.
            Deducted from this payslip; anything over the available net carries to
            the next period.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1.5">
          <Label htmlFor="vale-amt">Deduct this period ₱</Label>
          <Input
            id="vale-amt"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            placeholder="0.00"
            className="tabular-nums"
            autoFocus
          />
          <button
            type="button"
            className="self-start text-xs text-primary underline-offset-2 hover:underline"
            onClick={() => setAmount(((entry?.advance_balance ?? 0) / 100).toFixed(2))}
          >
            Full balance ({formatCentavos(entry?.advance_balance ?? 0)})
          </button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
