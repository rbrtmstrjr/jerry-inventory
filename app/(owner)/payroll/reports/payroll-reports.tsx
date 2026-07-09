"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Banknote, Download, Users, Wallet } from "lucide-react";

import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
    total: number;
    headcount: number;
    paid: number;
    unpaid: number;
  }[];
  byPosition: { position: string; total: number; headcount: number }[];
  rows: {
    period: string;
    staff: string;
    position: string;
    shop: string;
    pay_type: string;
    days_worked: number;
    net_pay: number;
    status: string;
    date_paid: string;
  }[];
}

function downloadCsv(filename: string, rows: Record<string, string | number>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

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
                data.rows.map((r) => ({
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
                      <TableCell className="font-medium">{r.shop}</TableCell>
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
                    <TableCell className="text-sm">{r.shop}</TableCell>
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
