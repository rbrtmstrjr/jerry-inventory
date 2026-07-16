"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import {
  CircleAlert,
  Printer,
  ScanLine,
  ShieldCheck,
  ShieldX,
  User,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";

export interface ShopWarrantyRow {
  id: string;
  engine_id: string;
  shop_id: string;
  shop_name: string;
  serial_number: string;
  condition: string | null;
  brand: string | null;
  model: string | null;
  horsepower: number | null;
  stroke: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  sold_on: string;
  months: number;
  expires_on: string;
  days_left: number;
  active: boolean;
  expiring_soon: boolean;
  sale_id: string;
  receipt_no: string | null;
}

function statusOf(r: ShopWarrantyRow) {
  if (!r.active) return "expired" as const;
  if (r.expiring_soon) return "expiring" as const;
  return "active" as const;
}

function StatusBadge({ r }: { r: ShopWarrantyRow }) {
  const s = statusOf(r);
  if (s === "expired")
    return (
      <Badge variant="destructive" className="gap-1">
        <ShieldX className="size-3" /> Expired
      </Badge>
    );
  if (s === "expiring")
    return (
      <Badge variant="outline" className="gap-1 border-warning/50 bg-warning/10 text-warning-foreground">
        <CircleAlert className="size-3" /> Expiring soon
      </Badge>
    );
  return (
    <Badge variant="default" className="gap-1">
      <ShieldCheck className="size-3" /> Active
    </Badge>
  );
}

export function ShopWarrantiesView({ rows }: { rows: ShopWarrantyRow[] }) {
  const scanRef = React.useRef<HTMLInputElement>(null);
  const [lookup, setLookup] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [open, setOpen] = React.useState<ShopWarrantyRow | null>(null);

  // keyboard-wedge scanners type then press Enter — keep the box focused
  React.useEffect(() => {
    scanRef.current?.focus();
  }, []);

  const q = lookup.trim().toLowerCase();
  const matches = rows.filter((r) => {
    if (status !== "all" && statusOf(r) !== status) return false;
    if (!q) return true;
    return (
      r.serial_number.toLowerCase().includes(q) ||
      (r.customer_name ?? "").toLowerCase().includes(q) ||
      `${r.brand ?? ""} ${r.model ?? ""}`.toLowerCase().includes(q)
    );
  });

  // A serial we can't find is either not ours or doesn't exist — we never say
  // which, and we never query another shop's data to find out.
  const notOurs = q.length >= 4 && matches.length === 0;

  const columns: ColumnDef<ShopWarrantyRow>[] = [
    {
      accessorKey: "serial_number",
      header: "Serial",
      cell: ({ row }) => (
        <span className="font-mono text-sm">{row.original.serial_number}</span>
      ),
    },
    {
      id: "model",
      accessorFn: (r) => `${r.brand ?? ""} ${r.model ?? ""}`,
      header: "Engine",
      cell: ({ row }) => (
        <span>
          {row.original.brand} {row.original.model}
          {row.original.horsepower != null && (
            <span className="text-muted-foreground"> — {row.original.horsepower}HP</span>
          )}
        </span>
      ),
    },
    {
      accessorKey: "customer_name",
      header: "Customer",
      cell: ({ row }) => (
        <div>
          <div>{row.original.customer_name ?? "—"}</div>
          {row.original.customer_phone && (
            <div className="text-xs text-muted-foreground">
              {row.original.customer_phone}
            </div>
          )}
        </div>
      ),
    },
    {
      accessorKey: "sold_on",
      header: ({ column }) => <SortableHeader column={column}>Sold</SortableHeader>,
      cell: ({ getValue }) => format(new Date(getValue<string>()), "MMM d, yyyy"),
    },
    {
      accessorKey: "expires_on",
      header: ({ column }) => <SortableHeader column={column}>Expires</SortableHeader>,
      cell: ({ row }) => (
        <div>
          <div>{format(new Date(row.original.expires_on), "MMM d, yyyy")}</div>
          <div className="text-xs text-muted-foreground">
            {row.original.days_left >= 0
              ? `${row.original.days_left} day(s) left`
              : `${Math.abs(row.original.days_left)} day(s) ago`}
          </div>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge r={row.original} />,
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setOpen(row.original)}>
            View
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/shop/warranties/${row.original.id}/certificate`} target="_blank">
              <Printer className="size-4" />
            </Link>
          </Button>
        </div>
      ),
    },
  ];

  const expiring = rows.filter((r) => statusOf(r) === "expiring").length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Warranties</h1>
        <p className="text-sm text-muted-foreground">
          Engines your shop sold. Look up a serial when a customer comes in.
          View and print only — anything else, call Admin.
        </p>
      </div>

      {/* Serial lookup — the counter use case */}
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
        <div className="flex items-center gap-2">
          <ScanLine className="size-5 shrink-0 text-muted-foreground" />
          <Input
            ref={scanRef}
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            placeholder="Scan or type the engine serial (or customer / model)…"
            className="bg-background text-base"
            autoComplete="off"
            aria-label="Look up a warranty by serial"
          />
          {lookup && (
            <Button variant="outline" onClick={() => setLookup("")}>
              Clear
            </Button>
          )}
        </div>
        {notOurs && (
          <div className="flex items-start gap-2 rounded-md bg-warning/10 p-3">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning-foreground" />
            <p className="text-sm text-warning-foreground">
              <span className="font-medium">
                This engine wasn&apos;t sold by this shop.
              </span>{" "}
              Please contact Admin — they can look it up across all branches.
            </p>
          </div>
        )}
      </div>

      {expiring > 0 && (
        <p className="rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
          <span className="font-medium">
            {expiring} warrant{expiring === 1 ? "y" : "ies"} expiring soon.
          </span>{" "}
          Worth a heads-up to the customer.
        </p>
      )}

      <DataTable
        columns={columns}
        data={matches}
        searchPlaceholder="Filter this list…"
        emptyMessage={
          q ? "No warranty matches that." : "No warranties yet — sell an engine first."
        }
        rowClassName={(r) =>
          statusOf(r) === "expiring" ? "bg-warning/5" : undefined
        }
        toolbar={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="expiring">Expiring soon</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
        }
      />

      <DetailDialog row={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/** Read-only. No edit / void / extend / claim actions exist for a shop. */
function DetailDialog({
  row,
  onClose,
}: {
  row: ShopWarrantyRow | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Warranty
            {row && <StatusBadge r={row} />}
          </DialogTitle>
          <DialogDescription>
            {row?.brand} {row?.model}
            {row?.horsepower != null && ` — ${row.horsepower}HP`}
          </DialogDescription>
        </DialogHeader>

        {row && (
          <div className="flex flex-col gap-3 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Serial">
                <span className="font-mono">{row.serial_number}</span>
              </Field>
              <Field label="Condition at sale">
                {row.condition === "brand_new" ? "Brand new" : "Second hand"}
              </Field>
              <Field label="Sold on">
                {format(new Date(row.sold_on), "MMM d, yyyy")}
              </Field>
              <Field label="Expires">
                {format(new Date(row.expires_on), "MMM d, yyyy")}
                <div className="text-xs text-muted-foreground">
                  {row.months} month{row.months === 1 ? "" : "s"} ·{" "}
                  {row.days_left >= 0
                    ? `${row.days_left} day(s) left`
                    : `expired ${Math.abs(row.days_left)} day(s) ago`}
                </div>
              </Field>
            </div>

            <div className="rounded-md border p-2.5">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Customer
              </div>
              <div className="flex items-center gap-1.5 font-medium">
                <User className="size-3.5 text-muted-foreground" />
                {row.customer_name ?? "—"}
              </div>
              {row.customer_phone && (
                <div className="text-muted-foreground">{row.customer_phone}</div>
              )}
              {row.customer_address && (
                <div className="text-xs text-muted-foreground">
                  {row.customer_address}
                </div>
              )}
            </div>

            <p className="rounded-md bg-accent p-2 text-xs text-accent-foreground">
              View only. For a claim, extension, or any correction, contact
              Admin.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {row && (
            <Button asChild>
              <Link href={`/shop/warranties/${row.id}/certificate`} target="_blank">
                <Printer className="size-4" /> Print certificate
              </Link>
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
