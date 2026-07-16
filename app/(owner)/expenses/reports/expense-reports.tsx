"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Building2, Download, ReceiptText, Store, Truck } from "lucide-react";

import { formatCentavos } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
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

export interface ExpenseReportData {
  from: string;
  to: string;
  shopFilter: string;
  shops: { id: string; name: string }[];
  totals: {
    total: number;
    company: number;
    shop: number;
    deliveryLinked: number;
    count: number;
  };
  byCategory: { category: string; total: number }[];
  byMonth: { month: string; total: number }[];
  byShop: { shop: string; total: number }[];
  shopNames: string[];
  costOfBusiness: {
    shop: string;
    revenue: number;
    opex: number;
    payroll: number;
    losses: number;
    net: number;
  }[];
  csvRows: Record<string, string | number>[];
}

const SHOP_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const pesoTick = (v: number) => `₱${Math.round(v / 100).toLocaleString()}`;

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
/* eslint-enable @typescript-eslint/no-explicit-any */

export function ExpenseReports({ data }: { data: ExpenseReportData }) {
  const router = useRouter();

  function apply(next: { from?: string; to?: string; shop?: string }) {
    const p = new URLSearchParams({
      from: next.from ?? data.from,
      to: next.to ?? data.to,
      shop: next.shop ?? data.shopFilter,
    });
    router.push(`/expenses/reports?${p.toString()}`);
  }

  const stats = [
    {
      label: "Total expenses",
      value: formatCentavos(data.totals.total),
      hint: `${data.totals.count} expense(s)`,
      icon: ReceiptText,
    },
    {
      label: "Shop-scoped",
      value: formatCentavos(data.totals.shop),
      hint: "tied to a branch",
      icon: Store,
    },
    {
      label: "Company-wide",
      value: formatCentavos(data.totals.company),
      hint: "general costs",
      icon: Building2,
    },
    {
      label: "Delivery-linked",
      value: formatCentavos(data.totals.deliveryLinked),
      hint: "gas, pakyaw, freight on runs",
      icon: Truck,
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
            disabled={data.csvRows.length === 0}
            onClick={() =>
              downloadCsv(`expenses_${data.from}_${data.to}.csv`, data.csvRows)
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

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Where the money goes</CardTitle>
            <CardDescription>By category, in range</CardDescription>
          </CardHeader>
          <CardContent>
            {data.byCategory.length === 0 ? (
              <p className="flex h-56 items-center justify-center text-sm text-muted-foreground">
                No expenses in this range.
              </p>
            ) : (
              <ResponsiveContainer
                width="100%"
                height={Math.max(180, data.byCategory.length * 34)}
              >
                <BarChart data={data.byCategory} layout="vertical" margin={{ left: 12, right: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis
                    type="number"
                    tickFormatter={pesoTick}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="category"
                    width={160}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                  />
                  <Tooltip content={<PesoTooltip />} cursor={{ fill: "var(--muted)" }} />
                  <Bar dataKey="total" name="Spent" fill="var(--chart-1)" radius={[0, 4, 4, 0]} maxBarSize={22} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-shop comparison</CardTitle>
            <CardDescription>Shop-scoped expenses only</CardDescription>
          </CardHeader>
          <CardContent>
            {data.byShop.length === 0 ? (
              <p className="flex h-56 items-center justify-center text-sm text-muted-foreground">
                No shop-scoped expenses in this range.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={data.byShop} margin={{ left: 12, right: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="shop"
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                  />
                  <YAxis
                    tickFormatter={pesoTick}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={70}
                  />
                  <Tooltip content={<PesoTooltip />} cursor={{ fill: "var(--muted)" }} />
                  <Bar dataKey="total" name="Expenses" radius={[4, 4, 0, 0]} maxBarSize={48}>
                    {data.byShop.map((row) => (
                      <Cell
                        key={row.shop}
                        fill={SHOP_COLORS[data.shopNames.indexOf(row.shop) % SHOP_COLORS.length]}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Monthly trend</CardTitle>
            <CardDescription>Total expenses per month</CardDescription>
          </CardHeader>
          <CardContent>
            {data.byMonth.length === 0 ? (
              <p className="flex h-44 items-center justify-center text-sm text-muted-foreground">
                No expenses in this range.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <AreaChart data={data.byMonth} margin={{ left: 12, right: 12, top: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tickFormatter={(m) => format(new Date(m + "-01T00:00:00"), "MMM yyyy")}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                  />
                  <YAxis
                    tickFormatter={pesoTick}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    width={70}
                  />
                  <Tooltip
                    content={<PesoTooltip />}
                    labelFormatter={(l) => format(new Date(String(l) + "-01T00:00:00"), "MMMM yyyy")}
                  />
                  <Area
                    type="monotone"
                    dataKey="total"
                    name="Expenses"
                    stroke="var(--chart-1)"
                    fill="var(--chart-1)"
                    fillOpacity={0.25}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cost of doing business */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Cost of doing business (per shop)</CardTitle>
          <CardDescription>
            Read-only rollup: approved revenue vs operating expenses, payroll, and
            approved losses in this range. Rough picture — not an accounting statement.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shop</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Op. expenses</TableHead>
                <TableHead className="text-right">Payroll</TableHead>
                <TableHead className="text-right">Losses</TableHead>
                <TableHead className="text-right">Rough net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.costOfBusiness.map((r) => (
                <TableRow key={r.shop}>
                  <TableCell className="font-medium">{r.shop}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.revenue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.opex)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.payroll)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.losses)}
                  </TableCell>
                  <TableCell
                    className={`text-right tabular-nums font-semibold ${
                      r.net < 0 ? "text-destructive" : ""
                    }`}
                  >
                    {formatCentavos(r.net)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
