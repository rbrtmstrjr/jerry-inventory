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
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  AlertTriangle,
  Anchor,
  ClipboardCheck,
  Download,
  PhilippinePeso,
  Truck,
} from "lucide-react";

import { formatCentavos } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { isShopColorKey, shopColorVars } from "@/lib/shop-colors";
import type { ShopOption } from "@/lib/db-types";
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
import { PrintButton } from "@/components/shell/print-button";
import { DatePicker } from "@/components/date-picker";
import { ph_today } from "@/lib/ph-date";

export interface ReportData {
  from: string;
  to: string;
  shopFilter: string;
  shops: ShopOption[];
  totals: {
    revenue: number;
    salesCount: number;
    lossValue: number;
    lossCount: number;
    /** shrinkage BETWEEN master and a shop — never mixed into lossValue */
    transitLossValue: number;
    transitLossQty: number;
    enginesSold: number;
    pendingCount: number;
  };
  trend: Record<string, string | number>[];
  shopNames: string[];
  byShop: { shop: string; revenue: number; count: number }[];
  byReason: { reason: string; value: number; qty: number }[];
  topParts: { name: string; qty: number; revenue: number }[];
  enginesSold: { description: string; shop: string; date: string; price_centavos: number }[];
  lowStock: { part: string; shop: string; qty: number; reorder_level: number }[];
  salesCsv: Record<string, string | number>[];
  lossesCsv: Record<string, string | number>[];
  transitLosses: {
    date: string;
    shop: string;
    item: string;
    qty: number;
    value_centavos: number;
    reason: string;
  }[];
}

const REASON_LABEL: Record<string, string> = {
  nasira: "Nasira (damaged)",
  nawala: "Nawala (missing)",
  expired: "Expired",
  sample: "Sample / libre",
  correction: "Correction",
};

/** Fixed categorical assignment: shop → chart slot, by shop list order. */
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
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full" style={{ background: p.color ?? p.fill }} />
            <span className="text-muted-foreground">{p.name}</span>
          </span>
          <span className="tabular-nums">{formatCentavos(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

function QtyTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md">
      <div className="mb-1 font-medium">{label}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex justify-between gap-4">
          <span className="text-muted-foreground">{p.name}</span>
          <span className="tabular-nums">{p.value}</span>
        </div>
      ))}
    </div>
  );
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function ReportsView({ data }: { data: ReportData }) {
  const router = useRouter();
  const [from, setFrom] = React.useState(data.from);
  const [to, setTo] = React.useState(data.to);

  // Shop identity color; colorless shops keep their chart-N slot as before
  const colorKeyByName = new Map(data.shops.map((s) => [s.name, s.color_key]));
  const seriesColor = (name: string) => {
    const key = colorKeyByName.get(name);
    return isShopColorKey(key)
      ? shopColorVars(key).strong
      : SHOP_COLORS[data.shopNames.indexOf(name) % SHOP_COLORS.length];
  };
  const badgeShop = (name: string) => ({
    name,
    color_key: colorKeyByName.get(name) ?? null,
  });

  function apply(next: { from?: string; to?: string; shop?: string }) {
    const p = new URLSearchParams({
      from: next.from ?? from,
      to: next.to ?? to,
      shop: next.shop ?? data.shopFilter,
    });
    router.push(`/reports?${p.toString()}`);
  }

  function preset(days: number) {
    const today = ph_today();
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (days - 1));
    const f = d.toISOString().slice(0, 10);
    setFrom(f);
    setTo(today);
    apply({ from: f, to: today });
  }

  const stats = [
    {
      label: "Revenue (approved)",
      value: formatCentavos(data.totals.revenue),
      hint: `${data.totals.salesCount} sale${data.totals.salesCount === 1 ? "" : "s"}`,
      icon: PhilippinePeso,
    },
    {
      label: "Engines sold",
      value: `${data.totals.enginesSold}`,
      hint: "serials in this range",
      icon: Anchor,
    },
    {
      label: "Shrinkage at shops",
      value: formatCentavos(data.totals.lossValue),
      hint: `${data.totals.lossCount} write-off line${data.totals.lossCount === 1 ? "" : "s"} · at cost`,
      icon: AlertTriangle,
    },
    {
      label: "Lost in transit",
      value: formatCentavos(data.totals.transitLossValue),
      hint: `${data.totals.transitLossQty} unit(s) never reached a shop · at cost`,
      icon: Truck,
    },
    {
      label: "Awaiting approval",
      value: `${data.totals.pendingCount}`,
      hint: "not in these figures yet",
      icon: ClipboardCheck,
    },
  ];

  const dateTick = (d: string) => format(new Date(d + "T00:00:00"), "MMM d");

  return (
    <div className="flex flex-col gap-6">
      <div className="print:hidden">
        <h1 className="text-2xl font-semibold tracking-tight">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Approved figures only — any date range.
        </p>
      </div>

      {/* Toolbar: filters (left) → export (right) */}
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3 print:hidden">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor="rep-from" className="text-xs">From</Label>
            <DatePicker
              id="rep-from"
              value={from}
              onChange={(v) => {
                setFrom(v);
                apply({ from: v });
              }}
            />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="rep-to" className="text-xs">To</Label>
            <DatePicker
              id="rep-to"
              value={to}
              onChange={(v) => {
                setTo(v);
                apply({ to: v });
              }}
            />
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
          <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => preset(1)}>Today</Button>
            <Button variant="outline" size="sm" onClick={() => preset(7)}>7d</Button>
            <Button variant="outline" size="sm" onClick={() => preset(30)}>30d</Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => downloadCsv(`sales_${data.from}_${data.to}.csv`, data.salesCsv)}
            disabled={data.salesCsv.length === 0}
          >
            <Download className="size-4" /> Sales CSV
          </Button>
          <Button
            variant="outline"
            onClick={() => downloadCsv(`losses_${data.from}_${data.to}.csv`, data.lossesCsv)}
            disabled={data.lossesCsv.length === 0}
          >
            <Download className="size-4" /> Losses CSV
          </Button>
          <PrintButton label="Print / Save PDF" />
        </div>
      </div>

      {/* Range header (visible in print) */}
      <p className="hidden text-sm text-muted-foreground print:block">
        Jerry&apos;s Marine — Report {format(new Date(data.from), "MMM d, yyyy")} to{" "}
        {format(new Date(data.to), "MMM d, yyyy")}
      </p>

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
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Sales trend</CardTitle>
            <CardDescription>Approved revenue per day, by shop</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={data.trend} margin={{ left: 12, right: 12, top: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={dateTick}
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
                  labelFormatter={(l) => dateTick(String(l))}
                />
                <Legend
                  formatter={(v) => (
                    <span style={{ color: "var(--foreground)", fontSize: 12 }}>{v}</span>
                  )}
                />
                {data.shopNames.map((name) => (
                  <Area
                    key={name}
                    type="monotone"
                    dataKey={name}
                    stackId="rev"
                    stroke={seriesColor(name)}
                    fill={seriesColor(name)}
                    fillOpacity={0.25}
                    strokeWidth={2}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Sales by shop</CardTitle>
            <CardDescription>Approved revenue in range</CardDescription>
          </CardHeader>
          <CardContent>
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
                <Bar dataKey="revenue" name="Revenue" radius={[4, 4, 0, 0]} maxBarSize={48}>
                  {data.byShop.map((row) => (
                    <Cell key={row.shop} fill={seriesColor(row.shop)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Losses by reason</CardTitle>
            <CardDescription>Write-off value (at cost) in range</CardDescription>
          </CardHeader>
          <CardContent>
            {data.byReason.length === 0 ? (
              <p className="flex h-60 items-center justify-center text-sm text-muted-foreground">
                No approved losses in this range.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart
                  data={data.byReason.map((r) => ({ ...r, label: REASON_LABEL[r.reason] ?? r.reason }))}
                  layout="vertical"
                  margin={{ left: 12, right: 12 }}
                >
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
                    dataKey="label"
                    width={130}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                  />
                  <Tooltip content={<PesoTooltip />} cursor={{ fill: "var(--muted)" }} />
                  <Bar
                    dataKey="value"
                    name="Write-off value"
                    fill="var(--chart-4)"
                    radius={[0, 4, 4, 0]}
                    maxBarSize={22}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Top-selling parts</CardTitle>
            <CardDescription>By quantity sold in range (top 10)</CardDescription>
          </CardHeader>
          <CardContent>
            {data.topParts.length === 0 ? (
              <p className="flex h-40 items-center justify-center text-sm text-muted-foreground">
                No approved part sales in this range.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(160, data.topParts.length * 34)}>
                <BarChart data={data.topParts} layout="vertical" margin={{ left: 12, right: 12 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" horizontal={false} />
                  <XAxis
                    type="number"
                    allowDecimals={false}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={220}
                    tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                  />
                  <Tooltip content={<QtyTooltip />} cursor={{ fill: "var(--muted)" }} />
                  <Bar
                    dataKey="qty"
                    name="Qty sold"
                    fill="var(--chart-1)"
                    radius={[0, 4, 4, 0]}
                    maxBarSize={22}
                  />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Engines sold + low stock */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Engines sold ({data.enginesSold.length})</CardTitle>
            <CardDescription>With serials, in range</CardDescription>
          </CardHeader>
          <CardContent className="max-h-72 overflow-auto">
            {data.enginesSold.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">None in this range.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Engine</TableHead>
                    <TableHead>Shop</TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">Price</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.enginesSold.map((e, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{e.description}</TableCell>
                      <TableCell className="text-sm">
                        <ShopBadge shop={badgeShop(e.shop)} variant="text" />
                      </TableCell>
                      <TableCell className="text-sm">{dateTick(e.date)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCentavos(e.price_centavos)}
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
            <CardTitle className="text-base">
              Low stock <Badge variant="destructive" className="ml-1">{data.lowStock.length}</Badge>
            </CardTitle>
            <CardDescription>At or below reorder level (current, all shops)</CardDescription>
          </CardHeader>
          <CardContent className="max-h-72 overflow-auto">
            {data.lowStock.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nothing is low right now.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead>Shop</TableHead>
                    <TableHead className="text-right">On hand / reorder</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.lowStock.map((r, i) => (
                    <TableRow key={i}>
                      <TableCell className="text-sm">{r.part}</TableCell>
                      <TableCell className="text-sm">
                        <ShopBadge shop={badgeShop(r.shop)} variant="text" />
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className="font-semibold text-destructive">{r.qty}</span> / {r.reorder_level}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

    </div>
  );
}
