"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import {
  Barcode,
  MoreHorizontal,
  Pencil,
  Plus,
  Printer,
  Puzzle,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import type { Category, EngineModel, PartRow } from "@/lib/db-types";
import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ProductCardImage } from "@/components/product-image";
import { ViewToggle, usePersistedView } from "@/components/view-toggle";
import { Input } from "@/components/ui/input";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { Search } from "lucide-react";
import { generateInternalBarcode, softDeletePart } from "./actions";
import { PartFormDialog } from "./part-form-dialog";
import { FitmentDialog } from "./fitment-dialog";

export function PartsTable({
  parts,
  categories,
  models,
  fitmentsByPart,
}: {
  parts: PartRow[];
  categories: Category[];
  models: EngineModel[];
  fitmentsByPart: Record<string, string[]>;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<PartRow | null>(null);
  const [fitmentFor, setFitmentFor] = React.useState<PartRow | null>(null);
  const [deleting, setDeleting] = React.useState<PartRow | null>(null);
  const [view, setView] = usePersistedView("jm-view-owner-parts");
  const [cardSearch, setCardSearch] = React.useState("");

  async function onGenerateBarcode(part: PartRow) {
    const res = await generateInternalBarcode(part.id);
    if (res.ok) toast.success(`Barcode ${res.barcode} assigned to ${part.name}`);
    else toast.error(res.error);
  }

  function RowActions({ part, onImage }: { part: PartRow; onImage?: boolean }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={onImage ? "secondary" : "ghost"}
            size={onImage ? "icon-sm" : "icon"}
            aria-label={`Actions for ${part.name}`}
            className={onImage ? "bg-background/80 backdrop-blur-sm" : undefined}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setEditing(part);
              setDialogOpen(true);
            }}
          >
            <Pencil className="size-4" /> Edit
          </DropdownMenuItem>
          {!part.barcode && (
            <DropdownMenuItem onClick={() => onGenerateBarcode(part)}>
              <Barcode className="size-4" /> Generate internal barcode
            </DropdownMenuItem>
          )}
          {part.barcode && (
            <DropdownMenuItem asChild>
              <Link href={`/master-inventory/labels?ids=${part.id}`}>
                <Printer className="size-4" /> Print label
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => setFitmentFor(part)}>
            <Puzzle className="size-4" /> Fitment
            {(fitmentsByPart[part.id]?.length ?? 0) > 0 &&
              ` (${fitmentsByPart[part.id].length})`}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(part)}>
            <Trash2 className="size-4" /> Remove product
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  const addButton = (
    <Button
      onClick={() => {
        setEditing(null);
        setDialogOpen(true);
      }}
    >
      <Plus className="size-4" /> Add Part
    </Button>
  );

  const q = cardSearch.trim().toLowerCase();
  const cardParts = q
    ? parts.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q) ||
          (p.barcode ?? "").toLowerCase().includes(q) ||
          (p.category_name ?? "").toLowerCase().includes(q)
      )
    : parts;

  const columns: ColumnDef<PartRow>[] = [
    {
      accessorKey: "name",
      header: ({ column }) => <SortableHeader column={column}>Item</SortableHeader>,
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.name}</div>
          {row.original.sku && (
            <div className="text-xs text-muted-foreground">
              SKU {row.original.sku}
            </div>
          )}
        </div>
      ),
    },
    {
      accessorKey: "category_name",
      header: "Category",
      cell: ({ getValue }) =>
        getValue<string | null>() ?? <span className="text-muted-foreground">—</span>,
    },
    {
      accessorKey: "barcode",
      header: "Barcode",
      cell: ({ getValue }) => {
        const v = getValue<string | null>();
        return v ? (
          <span className="font-mono text-xs">{v}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        );
      },
    },
    {
      accessorKey: "master_qty",
      header: ({ column }) => (
        <SortableHeader column={column}>Master Qty</SortableHeader>
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.master_qty} {row.original.unit}
        </span>
      ),
    },
    {
      accessorKey: "cost_centavos",
      header: ({ column }) => <SortableHeader column={column}>Cost</SortableHeader>,
      cell: ({ getValue }) => (
        <span className="tabular-nums">{formatCentavos(getValue<number>())}</span>
      ),
    },
    {
      accessorKey: "price_centavos",
      header: ({ column }) => <SortableHeader column={column}>Price</SortableHeader>,
      cell: ({ getValue }) => (
        <span className="tabular-nums font-medium">
          {formatCentavos(getValue<number>())}
        </span>
      ),
    },
    {
      id: "margin",
      header: "Margin",
      cell: ({ row }) => {
        const { cost_centavos: c, price_centavos: p } = row.original;
        if (p === 0) return <span className="text-muted-foreground">—</span>;
        const pct = Math.round(((p - c) / p) * 100);
        return <Badge variant={pct < 0 ? "destructive" : "secondary"}>{pct}%</Badge>;
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => <RowActions part={row.original} />,
    },
  ];

  return (
    <>
      {view === "table" ? (
        <DataTable
          columns={columns}
          data={parts}
          searchPlaceholder="Search name, SKU, barcode…"
          emptyMessage="No products yet — add them in bulk with Bulk Add, or add one item here."
          toolbar={
            <>
              <ViewToggle value={view} onChange={setView} />
              {addButton}
            </>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full max-w-xs">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={cardSearch}
                onChange={(e) => setCardSearch(e.target.value)}
                placeholder="Search name, SKU, barcode…"
                className="pl-8"
                aria-label="Search parts"
              />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ViewToggle value={view} onChange={setView} />
              {addButton}
            </div>
          </div>

          {cardParts.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search />
                </EmptyMedia>
                <EmptyDescription>
                  {q ? `Nothing matches “${cardSearch}”.` : "No parts yet."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {cardParts.map((p) => {
                const out = p.master_qty === 0;
                const low = !out && p.reorder_level > 0 && p.master_qty <= p.reorder_level;
                const margin =
                  p.price_centavos > 0
                    ? Math.round(
                        ((p.price_centavos - p.cost_centavos) / p.price_centavos) * 100
                      )
                    : null;
                return (
                  <div
                    key={p.id}
                    className="group flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
                  >
                    <div className="relative">
                      <ProductCardImage
                        path={p.image_path}
                        alt={p.name}
                        className={out ? "grayscale" : undefined}
                      />
                      <div className="absolute right-1.5 top-1.5">
                        <RowActions part={p} onImage />
                      </div>
                      {out ? (
                        <Badge variant="destructive" className="absolute bottom-1.5 left-1.5">
                          Out of stock
                        </Badge>
                      ) : low ? (
                        <Badge variant="destructive" className="absolute bottom-1.5 left-1.5">
                          Low
                        </Badge>
                      ) : null}
                    </div>
                    <div className="flex flex-1 flex-col gap-1 p-3">
                      <div className="line-clamp-2 text-sm font-medium">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {p.category_name ?? "—"}
                      </div>
                      <div className="mt-auto flex items-baseline justify-between pt-1.5">
                        <span className="text-base font-semibold tabular-nums">
                          {formatCentavos(p.price_centavos)}
                        </span>
                        {margin !== null && (
                          <span className="text-xs text-muted-foreground">
                            {margin}% margin
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between border-t pt-1.5 text-xs">
                        <span className="text-muted-foreground">Stock</span>
                        <span className={`tabular-nums font-medium ${out ? "text-destructive" : ""}`}>
                          {p.master_qty} {p.unit}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground tabular-nums">
            {cardParts.length} of {parts.length} items
          </p>
        </div>
      )}
      <PartFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        categories={categories}
        part={editing}
      />
      <FitmentDialog
        part={fitmentFor}
        models={models}
        currentFitments={fitmentFor ? (fitmentsByPart[fitmentFor.id] ?? []) : []}
        onClose={() => setFitmentFor(null)}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove “${deleting?.name}”?`}
        description="Its history stays in the ledger, but it disappears from product and shop stock lists."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const res = await softDeletePart(deleting.id);
          if (res.ok) toast.success(`${deleting.name} removed`);
          else toast.error(res.error);
        }}
      />
    </>
  );
}
