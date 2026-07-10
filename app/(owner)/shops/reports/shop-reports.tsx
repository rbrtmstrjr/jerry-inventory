"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
  Boxes,
  ClipboardCheck,
  Download,
  PhilippinePeso,
  Truck,
} from "lucide-react";

import { formatCentavos } from "@/lib/format";
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

export interface ShopReportData {
  from: string;
  to: string;
  shopFilter: string;
  shops: { id: string; name: string }[];
  shopNames: string[];
  totals: {
    revenue: number;
    stockValue: number;
    deliveredUnits: number;
    pending: number;
  };
  perShop: {
    shop: string;
    revenue: number;
    sales_count: number;
    units_sold: number;
    engines_sold: number;
    losses: number;
    opex: number;
    payroll: number;
    delivered_units: number;
    returned_units: number;
    stock_value: number;
    pending: number;
    net: number;
  }[];
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

export function ShopReports({ data }: { data: ShopReportData }) {
  const router = useRouter();

  function apply(next: { from?: string; to?: string; shop?: string }) {
    const p = new URLSearchParams({
      from: next.from ?? data.from,
      to: next.to ?? data.to,
      shop: next.shop ?? data.shopFilter,
    });
    router.push(`/shops/reports?${p.toString()}`);
  }

  const stats = [
    {
      label: "Revenue (approved)",
      value: formatCentavos(data.totals.revenue),
      hint: "in range",
      icon: PhilippinePeso,
    },
    {
      label: "Stock value now",
      value: formatCentavos(data.totals.stockValue),
      hint: "at selling price, on hand today",
      icon: Boxes,
    },
    {
      label: "Units delivered",
      value: `${data.totals.deliveredUnits}`,
      hint: "master → shops, in range",
      icon: Truck,
    },
    {
      label: "Awaiting approval",
      value: `${data.totals.pending}`,
      hint: "right now",
      icon: ClipboardCheck,
    },
  ];

  const csvRows = data.perShop.map((r) => ({
    shop: r.shop,
    revenue: (r.revenue / 100).toFixed(2),
    sales_count: r.sales_count,
    units_sold: r.units_sold,
    engines_sold: r.engines_sold,
    losses: (r.losses / 100).toFixed(2),
    op_expenses: (r.opex / 100).toFixed(2),
    payroll: (r.payroll / 100).toFixed(2),
    delivered_units: r.delivered_units,
    returned_units: r.returned_units,
    stock_value_now: (r.stock_value / 100).toFixed(2),
    rough_net: (r.net / 100).toFixed(2),
  }));

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
            disabled={csvRows.length === 0}
            onClick={() => downloadCsv(`shops_${data.from}_${data.to}.csv`, csvRows)}
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
            <CardTitle className="text-base">Revenue by shop</CardTitle>
            <CardDescription>Approved sales in range</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data.perShop} margin={{ left: 12, right: 12 }}>
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
                <Bar dataKey="revenue" name="Revenue" radius={[4, 4, 0, 0]} maxBarSize={48}>
                  {data.perShop.map((row) => (
                    <Cell
                      key={row.shop}
                      fill={SHOP_COLORS[data.shopNames.indexOf(row.shop) % SHOP_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stock value by shop</CardTitle>
            <CardDescription>On hand today, at selling price</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={data.perShop} margin={{ left: 12, right: 12 }}>
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
                <Bar dataKey="stock_value" name="Stock value" radius={[4, 4, 0, 0]} maxBarSize={48}>
                  {data.perShop.map((row) => (
                    <Cell
                      key={row.shop}
                      fill={SHOP_COLORS[data.shopNames.indexOf(row.shop) % SHOP_COLORS.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Full per-shop picture */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per-shop picture</CardTitle>
          <CardDescription>
            Flows use the date range; stock value and pending are as of now.
            Rough net = revenue − op. expenses − payroll − losses.
          </CardDescription>
        </CardHeader>
        <CardContent className="thin-scrollbar overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shop</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Engines</TableHead>
                <TableHead className="text-right">Losses</TableHead>
                <TableHead className="text-right">Op. exp.</TableHead>
                <TableHead className="text-right">Payroll</TableHead>
                <TableHead className="text-right">In / Out</TableHead>
                <TableHead className="text-right">Stock now</TableHead>
                <TableHead className="text-right">Rough net</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.perShop.map((r) => (
                <TableRow key={r.shop}>
                  <TableCell className="font-medium">
                    {r.shop}
                    {r.pending > 0 && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        ({r.pending} pending)
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.revenue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.sales_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.units_sold}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.engines_sold}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.losses)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.opex)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.payroll)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.delivered_units} / {r.returned_units}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.stock_value)}
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
