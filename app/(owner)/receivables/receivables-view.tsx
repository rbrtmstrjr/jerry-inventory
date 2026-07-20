"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  CheckCircle2,
  ChevronDown,
  Download,
  Printer,
  Search,
  Store,
  Users,
  Wallet,
} from "lucide-react";

import type { ReceivableRow, ShopOption } from "@/lib/db-types";
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
import { DatePicker } from "@/components/date-picker";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export interface PaymentHistoryRow {
  id: string;
  sale_id: string;
  amount_centavos: number;
  created_at: string;
  /** soft-deleted = voided by the shop/owner; kept for the audit trail */
  voided: boolean;
  owner_note: string | null;
  recorded_by: string;
}

export function OwnerReceivablesView({
  rows,
  history,
  shops,
}: {
  rows: ReceivableRow[];
  history: PaymentHistoryRow[];
  shops: ShopOption[];
}) {
  const [search, setSearch] = React.useState("");
  const [shopFilter, setShopFilter] = React.useState("all");
  const [from, setFrom] = React.useState("");
  const [to, setTo] = React.useState("");
  const colorByShopId = React.useMemo(
    () => new Map(shops.map((s) => [s.id, s.color_key])),
    [shops]
  );

  const historyBySale = React.useMemo(() => {
    const m = new Map<string, PaymentHistoryRow[]>();
    for (const h of history) {
      const list = m.get(h.sale_id) ?? [];
      list.push(h);
      m.set(h.sale_id, list);
    }
    return m;
  }, [history]);

  const q = search.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    if (shopFilter !== "all" && r.shop_id !== shopFilter) return false;
    if (from && r.business_date < from) return false;
    if (to && r.business_date > to) return false;
    if (!q) return true;
    return (
      (r.customer_name ?? "").toLowerCase().includes(q) ||
      (r.customer_phone ?? "").toLowerCase().includes(q) ||
      (r.description ?? "").toLowerCase().includes(q) ||
      (r.receipt_no ?? "").toLowerCase().includes(q) ||
      r.shop_name.toLowerCase().includes(q)
    );
  });

  const open = filtered.filter((r) => r.balance_centavos > 0);
  const settled = filtered.filter((r) => r.balance_centavos <= 0);

  const totalOutstanding = open.reduce((s, r) => s + r.balance_centavos, 0);

  // per-shop and per-customer rollups (open only)
  const byShop = React.useMemo(() => {
    const m = new Map<
      string,
      { name: string; color_key: string | null; total: number; count: number }
    >();
    for (const r of open) {
      const e = m.get(r.shop_id) ?? {
        name: r.shop_name,
        color_key: colorByShopId.get(r.shop_id) ?? null,
        total: 0,
        count: 0,
      };
      e.total += r.balance_centavos;
      e.count += 1;
      m.set(r.shop_id, e);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [open, colorByShopId]);

  const byCustomer = React.useMemo(() => {
    const m = new Map<string, { name: string; total: number; count: number }>();
    for (const r of open) {
      const key = r.customer_id ?? `walkin-${r.sale_id}`;
      const e = m.get(key) ?? {
        name: r.customer_name ?? "Walk-in",
        total: 0,
        count: 0,
      };
      e.total += r.balance_centavos;
      e.count += 1;
      m.set(key, e);
    }
    return [...m.values()].sort((a, b) => b.total - a.total);
  }, [open]);

  const csvRows = open.map((r) => ({
    date: r.business_date,
    receipt_no: r.receipt_no ?? "",
    shop: r.shop_name,
    customer: r.customer_name ?? "Walk-in",
    phone: r.customer_phone ?? "",
    item: r.description ?? "",
    total: (r.total_centavos / 100).toFixed(2),
    downpayment: (r.amount_paid_centavos / 100).toFixed(2),
    paid_since: (r.paid_since_centavos / 100).toFixed(2),
    balance: (r.balance_centavos / 100).toFixed(2),
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Receivables</h1>
        <p className="text-sm text-muted-foreground">
          Every unpaid balance (utang) across all shops. Balances only drop when
          you approve a payment in the Approval Queue.
        </p>
      </div>

      {/* Totals */}
      <div className="grid gap-4 sm:grid-cols-3">
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
              across {open.length} open sale{open.length === 1 ? "" : "s"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardDescription>Shops owing</CardDescription>
            <Store className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{byShop.length}</div>
            <p className="text-xs text-muted-foreground">
              {byShop[0] ? `${byShop[0].name} highest` : "none"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardDescription>Customers owing</CardDescription>
            <Users className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">
              {byCustomer.length}
            </div>
            <p className="text-xs text-muted-foreground">
              {byCustomer[0]
                ? `${byCustomer[0].name} owes ${formatCentavos(byCustomer[0].total)}`
                : "none"}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Filters + export */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          variant="outline"
          disabled={csvRows.length === 0}
          onClick={() => downloadCsv("receivables.csv", csvRows)}
        >
          <Download className="size-4" /> CSV
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Customer, item, receipt…"
              className="w-56 pl-8"
              aria-label="Search receivables"
            />
          </div>
          <Select value={shopFilter} onValueChange={setShopFilter}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All shops" />
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
          <DatePicker
            value={from}
            onChange={setFrom}
            className="w-40"
            aria-label="From date"
          />
          <DatePicker
            value={to}
            onChange={setTo}
            className="w-40"
            aria-label="To date"
          />
        </div>
      </div>

      {/* Per-shop rollup */}
      {byShop.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {byShop.map((s) => (
            <div
              key={s.name}
              className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
            >
              <ShopBadge shop={s} variant="text" className="min-w-0 text-muted-foreground" />
              <span className="font-semibold tabular-nums">
                {formatCentavos(s.total)}
              </span>
            </div>
          ))}
        </div>
      )}

      <Tabs defaultValue="open">
        <TabsList>
          <TabsTrigger value="open">Open ({open.length})</TabsTrigger>
          <TabsTrigger value="settled">Fully paid ({settled.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="flex flex-col gap-3 pt-2">
          {open.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              No outstanding balances.
            </p>
          )}
          {open.map((r) => (
            <ReceivableCard
              key={r.sale_id}
              row={r}
              shopColorKey={colorByShopId.get(r.shop_id) ?? null}
              history={historyBySale.get(r.sale_id) ?? []}
            />
          ))}
        </TabsContent>

        <TabsContent value="settled" className="flex flex-col gap-3 pt-2">
          {settled.length === 0 && (
            <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              Nothing fully paid yet.
            </p>
          )}
          {settled.map((r) => (
            <ReceivableCard
              key={r.sale_id}
              row={r}
              shopColorKey={colorByShopId.get(r.shop_id) ?? null}
              history={historyBySale.get(r.sale_id) ?? []}
            />
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ReceivableCard({
  row,
  shopColorKey,
  history,
}: {
  row: ReceivableRow;
  shopColorKey: string | null;
  history: PaymentHistoryRow[];
}) {
  const [open, setOpen] = React.useState(false);
  const paidOff = row.balance_centavos <= 0;
  const live = history.filter((h) => !h.voided);
  const voided = history.filter((h) => h.voided);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle className="text-base">
              {row.customer_name ?? "Walk-in"}
              {paidOff && (
                <Badge variant="default" className="ml-2">
                  <CheckCircle2 className="size-3" /> Settled
                </Badge>
              )}
              {row.sale_status !== "approved" && !paidOff && (
                <Badge variant="outline" className="ml-2">
                  Sale {row.sale_status}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              <ShopBadge
                shop={{ name: row.shop_name, color_key: shopColorKey }}
                variant="text"
                className="align-middle"
              />
              {row.customer_phone && ` · ${row.customer_phone}`} ·{" "}
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
          <span className="text-success">
            Collected since {formatCentavos(row.paid_since_centavos)}
          </span>
          {voided.length > 0 && (
            <span className="text-warning-foreground">
              {voided.length} voided
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
            <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)}>
              <ChevronDown
                className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
              />
              Payment history ({live.length})
            </Button>
          )}
        </div>

        {open && history.length > 0 && (
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
                  {h.voided && <Badge variant="outline">Voided</Badge>}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
