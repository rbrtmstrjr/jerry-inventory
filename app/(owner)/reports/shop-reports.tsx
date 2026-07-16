"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
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
  Boxes,
  Building2,
  Download,
  PhilippinePeso,
  TrendingUp,
} from "lucide-react";

import { formatCentavos } from "@/lib/format";
import { downloadCsv } from "@/lib/csv";
import { Badge } from "@/components/ui/badge";
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
  shops: { id: string; name: string; closed: boolean }[];
  shopNames: string[];
  totals: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    grossMarginPct: number;
    /** Σ of every shop's net contribution — before company overhead. */
    shopNet: number;
    /** Overhead belonging to no shop. Subtracted once, never allocated. */
    companyOverhead: number;
    businessNet: number;
    /** Σ gross pay + employer gov share across shops. */
    laborCost: number;
    /** The employer-share portion of laborCost. */
    employerShare: number;
    losses: number;
    stockValue: number;
    deliveredUnits: number;
    pending: number;
  };
  perShop: {
    shop: string;
    /** Shut down, but still had activity in this range — its money still counts. */
    closed: boolean;
    revenue: number;
    cogs: number;
    gross_profit: number;
    gross_margin_pct: number;
    sales_count: number;
    units_sold: number;
    engines_sold: number;
    losses: number;
    opex: number;
    /** Σ gross_pay — before the employee share is withheld. */
    payroll_gross: number;
    /** Σ employer SSS/PhilHealth/Pag-IBIG share — a cost on top of gross. */
    payroll_er: number;
    /** payroll_gross + payroll_er — what the staff actually cost the business. */
    labor_cost: number;
    net_contribution: number;
    net_margin_pct: number;
    delivered_units: number;
    returned_units: number;
    stock_value: number;
    pending: number;
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

const pesos = (c: number) => (c / 100).toFixed(2);

export function ShopReports({ data }: { data: ShopReportData }) {
  const router = useRouter();

  function apply(next: { from?: string; to?: string; shop?: string }) {
    const p = new URLSearchParams({
      tab: "shops",
      from: next.from ?? data.from,
      to: next.to ?? data.to,
      shop: next.shop ?? data.shopFilter,
    });
    router.push(`/reports?${p.toString()}`);
  }

  const t = data.totals;

  const stats = [
    {
      label: "Revenue (approved)",
      raw: t.revenue,
      hint: "in range",
      icon: PhilippinePeso,
    },
    {
      label: "Gross profit",
      raw: t.grossProfit,
      hint: `${t.grossMarginPct}% margin · after ${formatCentavos(t.cogs)} COGS`,
      icon: TrendingUp,
    },
    {
      label: "Shop net contribution",
      raw: t.shopNet,
      hint: `after shop expenses + ${formatCentavos(t.laborCost)} labor cost`,
      icon: Boxes,
    },
    {
      label: "Business net",
      raw: t.businessNet,
      hint: `after ${formatCentavos(t.companyOverhead)} company overhead`,
      icon: Building2,
    },
  ];

  const csvRows = data.perShop.map((r) => ({
    shop: r.shop,
    status: r.closed ? "closed" : "open",
    revenue: pesos(r.revenue),
    cogs: pesos(r.cogs),
    gross_profit: pesos(r.gross_profit),
    gross_margin_pct: r.gross_margin_pct,
    shop_expenses: pesos(r.opex),
    payroll_gross: pesos(r.payroll_gross),
    employer_gov_share: pesos(r.payroll_er),
    labor_cost: pesos(r.labor_cost),
    net_contribution: pesos(r.net_contribution),
    net_margin_pct: r.net_margin_pct,
    losses_not_in_net: pesos(r.losses),
    sales_count: r.sales_count,
    units_sold: r.units_sold,
    engines_sold: r.engines_sold,
    delivered_units: r.delivered_units,
    returned_units: r.returned_units,
    stock_value_now: pesos(r.stock_value),
  }));

  /** Overhead is a business-level line, so it rides along as its own CSV row. */
  function exportCsv() {
    const blank = Object.fromEntries(
      Object.keys(csvRows[0] ?? {}).map((k) => [k, ""])
    ) as Record<string, string | number>;
    downloadCsv(`shop_profitability_${data.from}_${data.to}.csv`, [
      ...csvRows,
      { ...blank, shop: "TOTAL (shops)", net_contribution: pesos(t.shopNet) },
      {
        ...blank,
        shop: "Company overhead (not allocated)",
        net_contribution: pesos(-t.companyOverhead),
      },
      { ...blank, shop: "BUSINESS NET", net_contribution: pesos(t.businessNet) },
    ]);
  }

  const negative = (v: number) => (v < 0 ? "text-destructive" : "");

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
                  {s.closed && " (closed)"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" disabled={csvRows.length === 0} onClick={exportCsv}>
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
              <div className={`text-2xl font-semibold tabular-nums ${negative(s.raw)}`}>
                {formatCentavos(s.raw)}
              </div>
              <p className="text-xs text-muted-foreground">{s.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Profit by shop</CardTitle>
            <CardDescription>
              Gross profit (after COGS) vs net contribution (after shop expenses
              and labor cost)
            </CardDescription>
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
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(v) => (
                    <span className="text-muted-foreground">{v}</span>
                  )}
                />
                <Bar
                  dataKey="gross_profit"
                  name="Gross profit"
                  fill="var(--chart-2)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={32}
                />
                <Bar
                  dataKey="net_contribution"
                  name="Net contribution"
                  fill="var(--chart-4)"
                  radius={[4, 4, 0, 0]}
                  maxBarSize={32}
                />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

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
      </div>

      {/* Profitability — the payoff */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profitability by shop</CardTitle>
          <CardDescription>
            Revenue − COGS = gross profit; − shop expenses − labor cost = net
            contribution. <strong>Labor cost</strong> is gross pay plus the
            employer&apos;s SSS/PhilHealth/Pag-IBIG share — what the staff cost
            the business, not what they took home. Company overhead belongs to
            no shop, so it is subtracted once at the bottom and never spread
            across branches.
          </CardDescription>
        </CardHeader>
        <CardContent className="thin-scrollbar overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shop</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">COGS</TableHead>
                <TableHead className="text-right">Gross profit</TableHead>
                <TableHead className="text-right">GM %</TableHead>
                <TableHead className="text-right">Shop exp.</TableHead>
                <TableHead className="text-right">Labor cost</TableHead>
                <TableHead className="text-right">Net contribution</TableHead>
                <TableHead className="text-right">NM %</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.perShop.map((r) => (
                <TableRow key={r.shop}>
                  <TableCell className="font-medium">
                    {r.shop}
                    {r.closed && (
                      <Badge variant="outline" className="ml-1.5 font-normal">
                        Closed
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.revenue)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    −{formatCentavos(r.cogs)}
                  </TableCell>
                  <TableCell className={`text-right tabular-nums ${negative(r.gross_profit)}`}>
                    {formatCentavos(r.gross_profit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.gross_margin_pct}%
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    −{formatCentavos(r.opex)}
                  </TableCell>
                  {/* Show what is inside the number: gross is only part of it. */}
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    −{formatCentavos(r.labor_cost)}
                    {r.payroll_er > 0 && (
                      <div className="text-xs">
                        incl. {formatCentavos(r.payroll_er)} employer share
                      </div>
                    )}
                  </TableCell>
                  <TableCell
                    className={`text-right font-semibold tabular-nums ${negative(
                      r.net_contribution
                    )}`}
                  >
                    {formatCentavos(r.net_contribution)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.net_margin_pct}%
                  </TableCell>
                </TableRow>
              ))}

              {/* Reconciliation: Σ shop net − company overhead = business net */}
              <TableRow className="border-t-2">
                <TableCell className="font-semibold">All shops</TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {formatCentavos(t.revenue)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  −{formatCentavos(t.cogs)}
                </TableCell>
                <TableCell className={`text-right font-medium tabular-nums ${negative(t.grossProfit)}`}>
                  {formatCentavos(t.grossProfit)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {t.grossMarginPct}%
                </TableCell>
                <TableCell colSpan={2} />
                <TableCell className={`text-right font-semibold tabular-nums ${negative(t.shopNet)}`}>
                  {formatCentavos(t.shopNet)}
                </TableCell>
                <TableCell />
              </TableRow>
              <TableRow>
                <TableCell colSpan={7} className="text-muted-foreground">
                  Company-wide overhead
                  <span className="ml-1.5 text-xs">
                    — not allocated to any shop
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  −{formatCentavos(t.companyOverhead)}
                </TableCell>
                <TableCell />
              </TableRow>
              <TableRow className="border-t bg-muted/40">
                <TableCell colSpan={7} className="font-semibold">
                  Business net
                </TableCell>
                <TableCell
                  className={`text-right text-base font-semibold tabular-nums ${negative(
                    t.businessNet
                  )}`}
                >
                  {formatCentavos(t.businessNet)}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableBody>
          </Table>
          <p className="mt-3 text-xs text-muted-foreground">
            Labor cost ({formatCentavos(t.laborCost)} in range) is gross pay plus{" "}
            {formatCentavos(t.employerShare)} of employer SSS/PhilHealth/Pag-IBIG
            contributions — a real cost of employing that never appears on a
            payslip&apos;s net. The employee&apos;s own share is already inside
            gross, so it is counted once here and not added again.
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            Losses ({formatCentavos(t.losses)} in range) and transit write-offs
            are tracked separately and are <strong>not</strong> subtracted here —
            they are stock that never sold, not a cost of what did.
          </p>
        </CardContent>
      </Card>

      {/* Volume / stock context */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Activity by shop</CardTitle>
          <CardDescription>
            Flows use the date range; stock value and pending are as of now.
          </CardDescription>
        </CardHeader>
        <CardContent className="thin-scrollbar overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Shop</TableHead>
                <TableHead className="text-right">Sales</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Engines</TableHead>
                <TableHead className="text-right">Losses</TableHead>
                <TableHead className="text-right">In / Out</TableHead>
                <TableHead className="text-right">Stock now</TableHead>
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
                  <TableCell className="text-right tabular-nums">{r.sales_count}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.units_sold}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.engines_sold}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.losses)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {r.delivered_units} / {r.returned_units}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatCentavos(r.stock_value)}
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
