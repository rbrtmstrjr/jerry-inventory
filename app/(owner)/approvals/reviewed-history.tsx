"use client";

import * as React from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { format } from "date-fns";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  HandCoins,
  History,
  Search,
  ShoppingCart,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DatePicker } from "@/components/date-picker";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ReviewedDetailSheet } from "./reviewed-detail-sheet";

export interface ReviewedItemRow {
  item_type: "sale" | "loss" | "utang_payment";
  id: string;
  shop_id: string;
  shop_name: string;
  status: "approved" | "rejected" | "questioned";
  reviewed_at: string | null;
  event_at: string;
  event_date: string;
  created_at: string;
  business_date: string;
  amount_centavos: number;
  summary: string;
  customer_id: string | null;
  customer_name: string | null;
  owner_note: string | null;
  batch_id: string | null;
}

export const TYPE_META: Record<
  ReviewedItemRow["item_type"],
  { label: string; icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  sale: {
    label: "Sale",
    icon: ShoppingCart,
    className: "border-primary/40 bg-primary/10 text-foreground",
  },
  loss: {
    label: "Loss",
    icon: AlertTriangle,
    className: "border-warning/50 bg-warning/10 text-warning-foreground",
  },
  utang_payment: {
    label: "Payment",
    icon: HandCoins,
    className: "border-success/40 bg-success/10 text-foreground",
  },
};

export const STATUS_META: Record<
  ReviewedItemRow["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  approved: { label: "Approved", variant: "default" },
  rejected: { label: "Rejected", variant: "destructive" },
  questioned: { label: "Questioned", variant: "outline" },
};

export function TypeBadge({ type }: { type: ReviewedItemRow["item_type"] }) {
  const m = TYPE_META[type];
  const Icon = m.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 font-medium", m.className)}>
      <Icon className="size-3" /> {m.label}
    </Badge>
  );
}

interface Filters {
  shop: string;
  type: string;
  status: string;
  from: string;
  to: string;
  q: string;
  page: number;
}

export function ReviewedHistory({
  rows,
  total,
  pageSize,
  shops,
  filters,
  openItem,
}: {
  rows: ReviewedItemRow[];
  total: number;
  pageSize: number;
  shops: { id: string; name: string }[];
  filters: Filters;
  /** "<type>:<id>" from the URL — makes the drawer deep-linkable */
  openItem: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [search, setSearch] = React.useState(filters.q);

  /** Write filter state into the URL so it survives refresh/share. */
  const setParam = React.useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(params.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === "" || v === "all") next.delete(k);
        else next.set(k, v);
      }
      // any filter change resets paging
      if (!("page" in patch)) next.delete("page");
      router.push(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router]
  );

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const activeFilters =
    (filters.shop !== "all" ? 1 : 0) +
    (filters.type !== "all" ? 1 : 0) +
    (filters.status !== "all" ? 1 : 0) +
    (filters.from ? 1 : 0) +
    (filters.to ? 1 : 0) +
    (filters.q ? 1 : 0);

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <History className="size-5" /> Reviewed History
        </h2>
        <p className="text-sm text-muted-foreground">
          Everything already decided — sales, losses and utang payments. Click a
          row to inspect it. Read-only.
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label className="text-xs">Shop</Label>
          <Select
            value={filters.shop}
            onValueChange={(v) => setParam({ shop: v })}
          >
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
        </div>

        <div className="grid gap-1.5">
          <Label className="text-xs">Type</Label>
          <Select value={filters.type} onValueChange={(v) => setParam({ type: v })}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="sale">Sales</SelectItem>
              <SelectItem value="loss">Losses</SelectItem>
              <SelectItem value="utang_payment">Utang payments</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label className="text-xs">Status</Label>
          <Select
            value={filters.status}
            onValueChange={(v) => setParam({ status: v })}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="questioned">Questioned</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label className="text-xs">Reviewed from</Label>
          <DatePicker
            value={filters.from}
            onChange={(v) => setParam({ from: v })}
            className="w-40"
          />
        </div>
        <div className="grid gap-1.5">
          <Label className="text-xs">to</Label>
          <DatePicker
            value={filters.to}
            onChange={(v) => setParam({ to: v })}
            className="w-40"
          />
        </div>

        <form
          className="grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setParam({ q: search });
          }}
        >
          <Label className="text-xs">Search</Label>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Customer, serial, product, receipt…"
              className="w-64 pl-8"
              aria-label="Search reviewed history"
            />
          </div>
        </form>

        {activeFilters > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              setParam({ shop: null, type: null, status: null, from: null, to: null, q: null });
            }}
          >
            <X className="size-3.5" /> Clear ({activeFilters})
          </Button>
        )}
      </div>

      {/* List */}
      <div className="overflow-hidden rounded-md border">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Shop</th>
              <th className="px-3 py-2 font-medium">Reviewed</th>
              <th className="px-3 py-2 font-medium">Summary</th>
              <th className="px-3 py-2 text-right font-medium">Amount</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-10 text-center text-muted-foreground">
                  {activeFilters > 0
                    ? "Nothing matches those filters."
                    : "Nothing reviewed yet."}
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={`${r.item_type}:${r.id}`}
                tabIndex={0}
                role="button"
                aria-label={`Open ${TYPE_META[r.item_type].label} detail`}
                onClick={() => setParam({ item: `${r.item_type}:${r.id}` })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setParam({ item: `${r.item_type}:${r.id}` });
                  }
                }}
                className="cursor-pointer border-t transition-colors hover:bg-accent focus:bg-accent focus:outline-none"
              >
                <td className="px-3 py-2">
                  <TypeBadge type={r.item_type} />
                </td>
                <td className="px-3 py-2 text-muted-foreground">{r.shop_name}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                  {format(new Date(r.event_at), "MMM d, yyyy h:mm a")}
                </td>
                <td className="max-w-xs px-3 py-2">
                  <span className="line-clamp-1">{r.summary}</span>
                  {r.customer_name && (
                    <span className="block text-xs text-muted-foreground">
                      {r.customer_name}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">
                  {formatCentavos(r.amount_centavos)}
                </td>
                <td className="px-3 py-2">
                  <Badge variant={STATUS_META[r.status].variant}>
                    {STATUS_META[r.status].label}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination (server-side — the list is never fetched unbounded) */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {total === 0
            ? "0 items"
            : `${(filters.page - 1) * pageSize + 1}–${Math.min(filters.page * pageSize, total)} of ${total}`}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={filters.page <= 1}
            onClick={() => setParam({ page: String(filters.page - 1) })}
          >
            <ChevronLeft className="size-4" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {filters.page} of {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={filters.page >= pageCount}
            onClick={() => setParam({ page: String(filters.page + 1) })}
          >
            Next <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      <ReviewedDetailSheet
        openItem={openItem}
        onClose={() => setParam({ item: null })}
      />
    </section>
  );
}
