"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Download, TrendingDown, TrendingUp } from "lucide-react";
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

import type { CashPosition, PnlResult, PnlShopRow } from "@/lib/pnl";
import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { DatePicker } from "@/components/date-picker";
import { PrintButton } from "@/components/shell/print-button";

export interface PnlViewData {
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  pnl: PnlResult;
  prev: {
    netIncome: number;
    revenue: number;
    grossProfit: number;
    cogs: number;
    shrinkage: number;
    opex: number;
    laborCost: number;
    netMarginPct: number;
  };
  cash: CashPosition;
  expenseByCategory: { name: string; amount: number }[];
  monthly: { label: string; netIncome: number; revenue: number; grossProfit: number }[];
  monthsTruncated: boolean;
  perShop: PnlShopRow[];
}

const PH = "Asia/Manila";
/** Today in PH. The business runs on PH days, so a report must start on one. */
const phToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: PH }).format(new Date());

function downloadCsv(filename: string, rows: Record<string, string | number>[]) {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => esc(r[h])).join(",")),
  ].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Pesos, for a CSV a bookkeeper opens in Excel. Centavos are our problem. */
const peso = (c: number) => (c / 100).toFixed(2);

/*
 * A tooltip component rather than a `formatter` prop — same as
 * /shops/reports. Recharts types `formatter`'s value as possibly undefined, so
 * a (v: number) => string never type-checks against it.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
function PesoTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{p.name}</span>
          <span className="tabular-nums">{formatCentavos(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function PctTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{p.name}</span>
          <span className="tabular-nums">{p.value}%</span>
        </div>
      ))}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function PnlView({ data }: { data: PnlViewData }) {
  const router = useRouter();
  const { pnl, prev, cash } = data;
  const [from, setFrom] = React.useState(data.from);
  const [to, setTo] = React.useState(data.to);

  function apply(next: { from?: string; to?: string }) {
    const p = new URLSearchParams({
      tab: "pnl",
      from: next.from ?? from,
      to: next.to ?? to,
    });
    router.push(`/reports?${p.toString()}`);
  }

  /**
   * Presets computed in PH time.
   *
   * Deliberately not `new Date().toISOString()`: the server runs in UTC and PH
   * is UTC+8, so between midnight and 8am an ISO-derived "today" is yesterday —
   * "This month" on the 1st would land you in last month. Every business_date in
   * the database is stamped in PH, so the picker must speak the same calendar.
   */
  function phParts(d = new Date()) {
    const [y, m, day] = new Intl.DateTimeFormat("en-CA", { timeZone: PH })
      .format(d)
      .split("-")
      .map(Number);
    return { y, m, day };
  }
  function setRange(f: string, t: string) {
    setFrom(f);
    setTo(t);
    apply({ from: f, to: t });
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

  function thisMonth() {
    const { y, m } = phParts();
    setRange(`${y}-${pad(m)}-01`, phToday());
  }
  function lastMonth() {
    const { y, m } = phParts();
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    setRange(`${py}-${pad(pm)}-01`, `${py}-${pad(pm)}-${pad(lastDay(py, pm))}`);
  }
  function thisQuarter() {
    const { y, m } = phParts();
    const qs = Math.floor((m - 1) / 3) * 3 + 1;
    setRange(`${y}-${pad(qs)}-01`, phToday());
  }
  function thisYear() {
    const { y } = phParts();
    setRange(`${y}-01-01`, phToday());
  }

  const delta = pnl.netIncome - prev.netIncome;
  const deltaPct =
    prev.netIncome !== 0
      ? Math.round((delta / Math.abs(prev.netIncome)) * 1000) / 10
      : null;
  const up = delta >= 0;

  // % of revenue, the column an accountant reads first.
  const ofRev = (v: number) =>
    pnl.revenue > 0 ? `${(Math.round((v / pnl.revenue) * 1000) / 10).toFixed(1)}%` : "—";

  const markupPct =
    pnl.cogs > 0 ? Math.round((pnl.grossProfit / pnl.cogs) * 1000) / 10 : 0;
  const engineMargin = pnl.engineRevenue - pnl.engineCogs;
  const partMargin = pnl.partRevenue - pnl.partCogs;

  const statement: {
    label: string;
    value: number;
    kind: "line" | "subtotal" | "total";
    hint?: string;
    href?: string;
  }[] = [
    { label: "Revenue", value: pnl.revenue, kind: "line", hint: "approved sales only" },
    { label: "Cost of goods sold", value: -pnl.cogs, kind: "line", hint: "actual cost of what sold" },
    { label: "Gross profit", value: pnl.grossProfit, kind: "subtotal" },
    {
      label: "Shop losses",
      value: -pnl.shopLosses,
      kind: "line",
      hint: "at cost — nasira / nawala / expired",
      href: "/approvals?type=loss",
    },
    {
      label: "Transit write-offs",
      value: -pnl.transitWriteoffs,
      kind: "line",
      hint: "at cost — lost between master and shop",
    },
    { label: "Shop expenses", value: -pnl.shopOpex, kind: "line", href: "/expenses" },
    {
      label: "Company overhead",
      value: -pnl.companyOverhead,
      kind: "line",
      hint: "never allocated to a shop",
      href: "/expenses",
    },
    {
      label: "Payroll",
      value: -pnl.laborCost,
      kind: "line",
      hint: `incl. ${formatCentavos(pnl.payrollEr)} employer share`,
      href: "/payroll/reports",
    },
    { label: "Net income", value: pnl.netIncome, kind: "total" },
  ];

  function exportCsv() {
    downloadCsv(`pnl_${data.from}_to_${data.to}.csv`, [
      ...statement.map((r) => ({
        line: r.label,
        amount_php: peso(r.value),
        pct_of_revenue: pnl.revenue > 0 ? ofRev(Math.abs(r.value)) : "",
      })),
      { line: "", amount_php: "", pct_of_revenue: "" },
      { line: "Gross margin %", amount_php: String(pnl.grossMarginPct), pct_of_revenue: "" },
      { line: "Net margin %", amount_php: String(pnl.netMarginPct), pct_of_revenue: "" },
      { line: "Markup on cost %", amount_php: String(markupPct), pct_of_revenue: "" },
      { line: "", amount_php: "", pct_of_revenue: "" },
      { line: "Earned (accrual)", amount_php: peso(cash.earned), pct_of_revenue: "" },
      { line: "Collected (cash in)", amount_php: peso(cash.collected), pct_of_revenue: "" },
      { line: "Still owed by customers", amount_php: peso(cash.outstanding), pct_of_revenue: "" },
      { line: "Owed to suppliers", amount_php: peso(cash.supplierPayables), pct_of_revenue: "" },
    ]);
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 print:hidden">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="pnl-from" className="text-xs">From</Label>
            <DatePicker
              id="pnl-from"
              value={from}
              onChange={(v) => {
                setFrom(v);
                apply({ from: v });
              }}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="pnl-to" className="text-xs">To</Label>
            <DatePicker
              id="pnl-to"
              value={to}
              onChange={(v) => {
                setTo(v);
                apply({ to: v });
              }}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            <Button variant="outline" size="sm" onClick={thisMonth}>This month</Button>
            <Button variant="outline" size="sm" onClick={lastMonth}>Last month</Button>
            <Button variant="outline" size="sm" onClick={thisQuarter}>This quarter</Button>
            <Button variant="outline" size="sm" onClick={thisYear}>This year</Button>
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv}>
            <Download className="size-4" /> Export CSV
          </Button>
          <PrintButton label="Print / Save as PDF" />
        </div>
      </div>

      {/* Headline */}
      <Card>
        <CardHeader className="pb-2">
          <CardDescription>
            Net income · {data.from} to {data.to} (Philippine dates)
          </CardDescription>
          <CardTitle
            className={`text-4xl tabular-nums ${pnl.netIncome < 0 ? "text-destructive" : ""}`}
          >
            {formatCentavos(pnl.netIncome)}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="text-muted-foreground">
            Net margin <strong className="text-foreground">{pnl.netMarginPct}%</strong>
          </span>
          <span className="flex items-center gap-1.5">
            {up ? (
              <TrendingUp className="size-4 text-primary" />
            ) : (
              <TrendingDown className="size-4 text-destructive" />
            )}
            <span className={up ? "" : "text-destructive"}>
              {up ? "+" : ""}
              {formatCentavos(delta)}
              {deltaPct !== null && ` (${up ? "+" : ""}${deltaPct}%)`}
            </span>
            <span className="text-muted-foreground">
              vs {data.prevFrom} – {data.prevTo}
            </span>
          </span>
        </CardContent>
      </Card>

      {/* The statement */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profit &amp; loss</CardTitle>
          <CardDescription>
            Revenue is what was <strong>earned</strong> — approved sales, including
            utang not yet collected. See Cash position below for what actually
            arrived.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 font-medium">Line</th>
                <th className="py-2 text-right font-medium">Amount</th>
                <th className="py-2 text-right font-medium">% of revenue</th>
              </tr>
            </thead>
            <tbody>
              {statement.map((r) => (
                <tr
                  key={r.label}
                  className={
                    r.kind === "total"
                      ? "border-t-2 font-semibold"
                      : r.kind === "subtotal"
                        ? "border-y font-medium"
                        : "border-b"
                  }
                >
                  <td className="py-2.5">
                    {r.href ? (
                      <Link href={r.href} className="underline-offset-4 hover:underline">
                        {r.label}
                      </Link>
                    ) : (
                      r.label
                    )}
                    {r.hint && (
                      <span className="ml-2 text-xs text-muted-foreground">{r.hint}</span>
                    )}
                  </td>
                  <td
                    className={`py-2.5 text-right tabular-nums ${
                      r.value < 0 && r.kind === "line"
                        ? "text-muted-foreground"
                        : r.value < 0
                          ? "text-destructive"
                          : ""
                    } ${r.kind === "total" ? "text-lg" : ""}`}
                  >
                    {formatCentavos(r.value)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                    {ofRev(Math.abs(r.value))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* The identity, on screen. If these two disagree, something is wrong. */}
          <p className="mt-4 rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            Reconciles to <Link href="/reports?tab=shops" className="underline underline-offset-4">Shop Reports</Link>:{" "}
            shop contributions {formatCentavos(pnl.shopNetTotal)} − overhead{" "}
            {formatCentavos(pnl.companyOverhead)} − shrinkage{" "}
            {formatCentavos(pnl.shrinkage)} ={" "}
            <strong className="text-foreground">{formatCentavos(pnl.netIncome)}</strong>.
            Shrinkage is subtracted here and not on that page: a shop is not
            blamed for stock that never sold, but the business still lost it.
          </p>
        </CardContent>
      </Card>

      {/* Cost vs selling */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What it cost vs what it sold for</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Sold for" value={formatCentavos(pnl.revenue)} />
            <Stat label="Cost of those goods" value={formatCentavos(pnl.cogs)} />
            <Stat
              label="Gross margin"
              value={formatCentavos(pnl.grossProfit)}
              hint={`${pnl.grossMarginPct}% of revenue`}
            />
            <Stat
              label="Markup on cost"
              value={`${markupPct}%`}
              hint="what you added to cost"
            />
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 font-medium">Type</th>
                <th className="py-2 text-right font-medium">Sold for</th>
                <th className="py-2 text-right font-medium">Cost</th>
                <th className="py-2 text-right font-medium">Margin</th>
                <th className="py-2 text-right font-medium">Margin %</th>
              </tr>
            </thead>
            <tbody>
              <Row
                name="Engines"
                rev={pnl.engineRevenue}
                cost={pnl.engineCogs}
                margin={engineMargin}
              />
              <Row
                name="Parts"
                rev={pnl.partRevenue}
                cost={pnl.partCogs}
                margin={partMargin}
              />
            </tbody>
          </table>

          <div className="rounded-md border p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <p className="text-sm font-medium">Discount given on engines</p>
                <p className="text-xs text-muted-foreground">
                  Asking price minus what your shops actually agreed, across{" "}
                  {pnl.engineDiscountLines} engine sale
                  {pnl.engineDiscountLines === 1 ? "" : "s"}.
                </p>
              </div>
              <p className="text-2xl font-semibold tabular-nums">
                {formatCentavos(pnl.engineDiscount)}
              </p>
            </div>
            {/* Never counted as zero — see the note in lib/pnl.ts. */}
            {pnl.engineDiscountUnknownLines > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                {pnl.engineDiscountUnknownLines} engine sale
                {pnl.engineDiscountUnknownLines === 1 ? " is" : "s are"} excluded:
                sold before tier pricing existed, so there was no asking price to
                negotiate against. They are not counted as zero discount.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Cash vs accrual */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cash position</CardTitle>
          <CardDescription>
            Earned is not the same as collected. This is the difference.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <Stat
            label="Earned"
            value={formatCentavos(cash.earned)}
            hint="approved sales in range"
          />
          <Stat
            label="Collected"
            value={formatCentavos(cash.collected)}
            hint="cash in: till + utang payments"
          />
          <Stat
            label="Still owed to you"
            value={formatCentavos(cash.outstanding)}
            hint="unpaid utang, as of today"
          />
          <div className="sm:col-span-3">
            <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
              Earned <strong className="text-foreground">{formatCentavos(cash.earned)}</strong> ·
              Collected <strong className="text-foreground">{formatCentavos(cash.collected)}</strong> ·
              Still owed <strong className="text-foreground">{formatCentavos(cash.outstanding)}</strong>.
              Net income above is what the business <em>earned</em>, not cash in
              hand — it counts utang the moment the sale is approved.
              {cash.supplierPayables > 0 && (
                <>
                  {" "}For context (not part of this P&amp;L), you owe suppliers{" "}
                  <strong className="text-foreground">
                    {formatCentavos(cash.supplierPayables)}
                  </strong>
                  .
                </>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        {data.monthly.length > 1 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Net income by month</CardTitle>
              <CardDescription>
                Monthly, not daily: overhead and payroll arrive on periods, so a
                daily line would be invented rather than measured.
                {data.monthsTruncated && " Showing the first 12 months of the range."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.monthly}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="label" fontSize={12} />
                  <YAxis fontSize={12} tickFormatter={(v) => `${Math.round(v / 100000)}k`} />
                  <Tooltip content={<PesoTooltip />} cursor={{ fill: "var(--muted)" }} />
                  <Bar dataKey="netIncome" name="Net income" radius={[4, 4, 0, 0]}>
                    {data.monthly.map((m) => (
                      <Cell
                        key={m.label}
                        fill={m.netIncome < 0 ? "var(--destructive)" : "var(--chart-1)"}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where the money went</CardTitle>
            <CardDescription>Revenue, and everything subtracted from it.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart
                layout="vertical"
                data={[
                  { name: "Revenue", v: pnl.revenue },
                  { name: "COGS", v: pnl.cogs },
                  { name: "Shrinkage", v: pnl.shrinkage },
                  { name: "Expenses", v: pnl.opex },
                  { name: "Payroll", v: pnl.laborCost },
                ]}
                margin={{ left: 20 }}
              >
                <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" fontSize={12} tickFormatter={(v) => `${Math.round(v / 100000)}k`} />
                <YAxis type="category" dataKey="name" fontSize={12} width={70} />
                <Tooltip content={<PesoTooltip />} cursor={{ fill: "var(--muted)" }} />
                <Bar dataKey="v" name="Amount" radius={[0, 4, 4, 0]}>
                  {["var(--chart-1)", "var(--chart-2)", "var(--chart-4)", "var(--chart-3)", "var(--chart-5)"].map(
                    (c, i) => (
                      <Cell key={i} fill={c} />
                    )
                  )}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {data.expenseByCategory.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Expense composition</CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart layout="vertical" data={data.expenseByCategory.slice(0, 8)} margin={{ left: 30 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" fontSize={12} tickFormatter={(v) => `${Math.round(v / 100000)}k`} />
                  <YAxis type="category" dataKey="name" fontSize={12} width={110} />
                  <Tooltip content={<PesoTooltip />} cursor={{ fill: "var(--muted)" }} />
                  <Bar dataKey="amount" name="Spent" fill="var(--chart-3)" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {data.perShop.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Gross margin by shop</CardTitle>
              <CardDescription>Which branch protects its margin best.</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.perShop}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="shop" fontSize={12} />
                  <YAxis fontSize={12} tickFormatter={(v) => `${v}%`} />
                  <Tooltip content={<PctTooltip />} cursor={{ fill: "var(--muted)" }} />
                  <Bar dataKey="gross_margin_pct" name="Gross margin %" fill="var(--chart-2)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Per-shop reconciliation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-shop contribution</CardTitle>
          <CardDescription>
            Each branch&apos;s contribution, then overhead and shrinkage taken
            once at the bottom — never spread across the shops.{" "}
            <Link href="/reports?tab=shops" className="underline underline-offset-4">
              Full shop breakdown
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                <th className="py-2 font-medium">Shop</th>
                <th className="py-2 text-right font-medium">Revenue</th>
                <th className="py-2 text-right font-medium">Gross profit</th>
                <th className="py-2 text-right font-medium">Losses</th>
                <th className="py-2 text-right font-medium">Net contribution</th>
              </tr>
            </thead>
            <tbody>
              {data.perShop.map((s) => (
                <tr key={s.shop_id} className="border-b">
                  <td className="py-2.5">
                    {s.shop}
                    {s.closed && (
                      <Badge variant="secondary" className="ml-2">Closed</Badge>
                    )}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{formatCentavos(s.revenue)}</td>
                  <td className="py-2.5 text-right tabular-nums">{formatCentavos(s.gross_profit)}</td>
                  <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                    {formatCentavos(s.losses)}
                  </td>
                  <td
                    className={`py-2.5 text-right font-medium tabular-nums ${
                      s.net_contribution < 0 ? "text-destructive" : ""
                    }`}
                  >
                    {formatCentavos(s.net_contribution)}
                  </td>
                </tr>
              ))}
              <tr className="border-y font-medium">
                <td className="py-2.5" colSpan={4}>All shops — net contribution</td>
                <td className="py-2.5 text-right tabular-nums">
                  {formatCentavos(pnl.shopNetTotal)}
                </td>
              </tr>
              <tr className="border-b">
                <td className="py-2.5 text-muted-foreground" colSpan={4}>
                  − Company overhead (belongs to no shop)
                </td>
                <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                  {formatCentavos(-pnl.companyOverhead)}
                </td>
              </tr>
              <tr className="border-b">
                <td className="py-2.5 text-muted-foreground" colSpan={4}>
                  − Shrinkage (shop losses + transit write-offs, at cost)
                </td>
                <td className="py-2.5 text-right tabular-nums text-muted-foreground">
                  {formatCentavos(-pnl.shrinkage)}
                </td>
              </tr>
              <tr className="border-t-2 font-semibold">
                <td className="py-2.5" colSpan={4}>Net income</td>
                <td
                  className={`py-2.5 text-right text-lg tabular-nums ${
                    pnl.netIncome < 0 ? "text-destructive" : ""
                  }`}
                >
                  {formatCentavos(pnl.netIncome)}
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Row({
  name,
  rev,
  cost,
  margin,
}: {
  name: string;
  rev: number;
  cost: number;
  margin: number;
}) {
  const pct = rev > 0 ? Math.round((margin / rev) * 1000) / 10 : 0;
  return (
    <tr className="border-b">
      <td className="py-2.5">{name}</td>
      <td className="py-2.5 text-right tabular-nums">{formatCentavos(rev)}</td>
      <td className="py-2.5 text-right tabular-nums">{formatCentavos(cost)}</td>
      <td className="py-2.5 text-right tabular-nums">{formatCentavos(margin)}</td>
      <td className="py-2.5 text-right tabular-nums">{rev > 0 ? `${pct}%` : "—"}</td>
    </tr>
  );
}
