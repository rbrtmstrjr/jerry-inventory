"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Banknote, Download, TriangleAlert, Users, Wallet } from "lucide-react";

import { formatCentavos } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { Badge } from "@/components/ui/badge";
import { ShopBadge } from "@/components/shop-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
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
import { DatePicker } from "@/components/date-picker";
import { PrintButton } from "@/components/shell/print-button";

export interface PayrollReportData {
  from: string;
  to: string;
  shopFilter: string;
  shops: { id: string; name: string }[];
  totals: {
    total: number;
    paid: number;
    unpaid: number;
    headcount: number;
    periods: number;
  };
  byShop: {
    shop: string;
    color_key: string | null;
    total: number;
    headcount: number;
    paid: number;
    unpaid: number;
  }[];
  byPosition: { position: string; total: number; headcount: number }[];
  /**
   * Government contributions, read from the frozen per-entry snapshot.
   * `ee` is withheld from the staff member's pay; `er` is the employer's own
   * cost on top of gross. The agency receives `ee + er`.
   */
  remittance: {
    periods: {
      period_id: string;
      period: string;
      agencies: {
        agency: string;
        staff_count: number;
        ee: number;
        er: number;
        total: number;
      }[];
      ee: number;
      er: number;
      total: number;
    }[];
    byAgency: { agency: string; ee: number; er: number; total: number }[];
    totals: { ee: number; er: number; total: number };
    /** True when a shop filter is on — the totals are then a subset, not the remittance. */
    shopFiltered: boolean;
  };
  rows: {
    period: string;
    staff: string;
    position: string;
    shop: string;
    shop_color_key: string | null;
    pay_type: string;
    days_worked: number;
    net_pay: number;
    status: string;
    date_paid: string;
  }[];
}

/** Display names for the agency enum. Labels, not rates. */
const AGENCY_LABEL: Record<string, string> = {
  sss: "SSS",
  philhealth: "PhilHealth",
  pagibig: "Pag-IBIG",
};
const agencyLabel = (a: string) => AGENCY_LABEL[a] ?? a;

const pesos = (c: number) => (c / 100).toFixed(2);

export function PayrollReports({ data }: { data: PayrollReportData }) {
  const router = useRouter();

  function apply(next: { from?: string; to?: string; shop?: string }) {
    const p = new URLSearchParams({
      from: next.from ?? data.from,
      to: next.to ?? data.to,
      shop: next.shop ?? data.shopFilter,
    });
    router.push(`/payroll/reports?${p.toString()}`);
  }

  const stats = [
    {
      label: "Total payroll",
      value: formatCentavos(data.totals.total),
      hint: `${data.totals.periods} period(s) in range`,
      icon: Wallet,
    },
    {
      label: "Paid out",
      value: formatCentavos(data.totals.paid),
      hint: "status: paid",
      icon: Banknote,
    },
    {
      label: "Not yet paid",
      value: formatCentavos(data.totals.unpaid),
      hint: "draft + approved",
      icon: Banknote,
    },
    {
      label: "Payslip lines",
      value: `${data.rows.length}`,
      hint: "staff × periods",
      icon: Users,
    },
  ];

  const rm = data.remittance;

  /**
   * One row per period × agency — the shape a bookkeeper files from — followed
   * by each period's all-agency subtotal, then the range roll-up.
   */
  function exportRemittanceCsv() {
    const rows: Record<string, string | number>[] = [];
    for (const p of rm.periods) {
      for (const a of p.agencies) {
        rows.push({
          period: p.period,
          agency: agencyLabel(a.agency),
          staff: a.staff_count,
          employee_share: pesos(a.ee),
          employer_share: pesos(a.er),
          total_to_remit: pesos(a.total),
        });
      }
      rows.push({
        period: p.period,
        agency: "ALL AGENCIES",
        staff: "",
        employee_share: pesos(p.ee),
        employer_share: pesos(p.er),
        total_to_remit: pesos(p.total),
      });
    }
    if (rm.periods.length > 1) {
      for (const a of rm.byAgency) {
        rows.push({
          period: `RANGE TOTAL ${data.from}..${data.to}`,
          agency: agencyLabel(a.agency),
          staff: "",
          employee_share: pesos(a.ee),
          employer_share: pesos(a.er),
          total_to_remit: pesos(a.total),
        });
      }
      rows.push({
        period: `RANGE TOTAL ${data.from}..${data.to}`,
        agency: "ALL AGENCIES",
        staff: "",
        employee_share: pesos(rm.totals.ee),
        employer_share: pesos(rm.totals.er),
        total_to_remit: pesos(rm.totals.total),
      });
    }
    if (rm.shopFiltered) {
      rows.push({
        period: "NOTE",
        agency: "Filtered to one shop — NOT the full amount to remit",
        staff: "",
        employee_share: "",
        employer_share: "",
        total_to_remit: "",
      });
    }
    downloadCsv(`remittances_${data.from}_${data.to}.csv`, rows);
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Filters + export */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 print:hidden">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label className="text-xs">From</Label>
            <DatePicker value={data.from} onChange={(v) => apply({ from: v })} />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">To</Label>
            <DatePicker value={data.to} onChange={(v) => apply({ to: v })} />
          </div>
          <Select value={data.shopFilter} onValueChange={(v) => apply({ shop: v })}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All shops</SelectItem>
              {data.shops.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={data.rows.length === 0}
            onClick={() =>
              downloadCsv(
                `payroll_${data.from}_${data.to}.csv`,
                // color key is a UI concern — keep it out of the CSV
                data.rows.map(({ shop_color_key: _sck, ...r }) => ({
                  ...r,
                  net_pay: (r.net_pay / 100).toFixed(2),
                }))
              )
            }
          >
            <Download className="size-4" /> CSV
          </Button>
          <PrintButton label="Print / Save PDF" />
        </div>
      </div>

      {/* Stat tiles */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">{s.label}</CardTitle>
              <s.icon className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-semibold tabular-nums">{s.value}</div>
              <p className="text-xs text-muted-foreground">{s.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Government remittances — the payoff */}
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
          <div className="space-y-1.5">
            <CardTitle className="text-base">
              Government remittances — SSS · PhilHealth · Pag-IBIG
            </CardTitle>
            <CardDescription>
              Employee share is withheld from pay; employer share is the
              business&apos;s own cost on top of gross. The agency receives both
              — <strong>total to remit</strong> is the figure handed over.
              Amounts are the frozen per-payslip snapshot, so they always tie
              out to the payslips already issued.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="print:hidden"
            disabled={rm.periods.length === 0}
            onClick={exportRemittanceCsv}
          >
            <Download className="size-4" /> CSV
          </Button>
        </CardHeader>
        <CardContent className="thin-scrollbar overflow-x-auto">
          {rm.shopFiltered && (
            <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-500" />
              <span>
                Filtered to one shop. Contributions are remitted for the{" "}
                <strong>whole business</strong> in one payment — these totals are
                a subset, not the amount to hand the agency. Choose{" "}
                <em>All shops</em> for the remittance figure.
              </span>
            </div>
          )}

          {rm.periods.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No contributions in this range.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Agency</TableHead>
                  <TableHead className="text-right">Staff</TableHead>
                  <TableHead className="text-right">Employee share</TableHead>
                  <TableHead className="text-right">Employer share</TableHead>
                  <TableHead className="text-right">Total to remit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rm.periods.map((p) => (
                  <React.Fragment key={p.period_id}>
                    {p.agencies.map((a, i) => (
                      <TableRow key={a.agency}>
                        <TableCell className="text-sm font-medium">
                          {i === 0 ? p.period : ""}
                        </TableCell>
                        <TableCell className="text-sm">
                          {agencyLabel(a.agency)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {a.staff_count}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCentavos(a.ee)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCentavos(a.er)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatCentavos(a.total)}
                        </TableCell>
                      </TableRow>
                    ))}
                    {/* What leaves the bank for this period, all agencies. */}
                    <TableRow className="border-t bg-muted/40">
                      <TableCell colSpan={2} className="text-sm font-semibold">
                        {p.period} — all agencies
                      </TableCell>
                      <TableCell />
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatCentavos(p.ee)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatCentavos(p.er)}
                      </TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">
                        {formatCentavos(p.total)}
                      </TableCell>
                    </TableRow>
                  </React.Fragment>
                ))}

                {/* Range roll-up — only meaningful once more than one period is in view. */}
                {rm.periods.length > 1 && (
                  <>
                    {rm.byAgency.map((a, i) => (
                      <TableRow
                        key={a.agency}
                        className={i === 0 ? "border-t-2" : undefined}
                      >
                        <TableCell className="text-sm text-muted-foreground">
                          {i === 0 ? "Range total" : ""}
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          {agencyLabel(a.agency)}
                        </TableCell>
                        <TableCell />
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCentavos(a.ee)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {formatCentavos(a.er)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {formatCentavos(a.total)}
                        </TableCell>
                      </TableRow>
                    ))}
                    <TableRow className="border-t bg-muted/40">
                      <TableCell colSpan={2} className="font-semibold">
                        Range total — all agencies
                      </TableCell>
                      <TableCell />
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatCentavos(rm.totals.ee)}
                      </TableCell>
                      <TableCell className="text-right font-medium tabular-nums">
                        {formatCentavos(rm.totals.er)}
                      </TableCell>
                      <TableCell className="text-right text-base font-semibold tabular-nums">
                        {formatCentavos(rm.totals.total)}
                      </TableCell>
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          )}

          <p className="mt-3 text-xs text-muted-foreground">
            Employer share ({formatCentavos(rm.totals.er)} in range) is{" "}
            <strong>not</strong> deducted from anyone&apos;s pay — it is a cost
            of employing, on top of gross. Employee share (
            {formatCentavos(rm.totals.ee)}) is already reflected in net pay.
            Rates come from the effective-dated rate book in Settings.
          </p>
        </CardContent>
      </Card>

      {/* Breakdown tables */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">By shop</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byShop.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No payroll in this range.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Shop</TableHead>
                    <TableHead className="text-right">Headcount</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Unpaid</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byShop.map((r) => (
                    <TableRow key={r.shop}>
                      <TableCell className="font-medium">
                        <ShopBadge shop={{ name: r.shop, color_key: r.color_key }} />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{r.headcount}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCentavos(r.paid)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCentavos(r.unpaid)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatCentavos(r.total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">By position</CardTitle>
          </CardHeader>
          <CardContent>
            {data.byPosition.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No payroll in this range.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Position</TableHead>
                    <TableHead className="text-right">Headcount</TableHead>
                    <TableHead className="text-right">Total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.byPosition.map((r) => (
                    <TableRow key={r.position}>
                      <TableCell className="font-medium">{r.position}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.headcount}</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        {formatCentavos(r.total)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Detail lines */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Payslip lines ({data.rows.length})</CardTitle>
        </CardHeader>
        <CardContent className="thin-scrollbar max-h-96 overflow-auto">
          {data.rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No payroll in this range.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Period</TableHead>
                  <TableHead>Staff</TableHead>
                  <TableHead>Shop</TableHead>
                  <TableHead className="text-right">Days</TableHead>
                  <TableHead className="text-right">Net pay</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((r, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{r.period}</TableCell>
                    <TableCell>
                      <div className="text-sm font-medium">{r.staff}</div>
                      <div className="text-xs text-muted-foreground">{r.position}</div>
                    </TableCell>
                    <TableCell className="text-sm">
                      <ShopBadge
                        shop={{ name: r.shop, color_key: r.shop_color_key }}
                        variant="text"
                      />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.pay_type === "daily" ? r.days_worked : "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {formatCentavos(r.net_pay)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={r.status === "paid" ? "default" : "secondary"}>
                        {r.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
