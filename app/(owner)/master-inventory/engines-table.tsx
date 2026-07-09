"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { EngineModel, EngineRow } from "@/lib/db-types";
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
import { softDeleteEngine } from "./actions";
import { EngineFormDialog } from "./engine-form-dialog";

const STATUS_BADGE: Record<
  EngineRow["status"],
  { label: string; variant: "default" | "secondary" | "destructive" | "outline" }
> = {
  in_master: { label: "In master", variant: "secondary" },
  delivered: { label: "At shop", variant: "default" },
  sold: { label: "Sold", variant: "outline" },
  returned: { label: "Returned", variant: "secondary" },
};

export function EnginesTable({
  engines,
  models,
}: {
  engines: EngineRow[];
  models: EngineModel[];
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<EngineRow | null>(null);
  const [deleting, setDeleting] = React.useState<EngineRow | null>(null);
  const [view, setView] = usePersistedView("jm-view-owner-engines");
  const [cardSearch, setCardSearch] = React.useState("");

  function RowActions({ engine, onImage }: { engine: EngineRow; onImage?: boolean }) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant={onImage ? "secondary" : "ghost"}
            size={onImage ? "icon-sm" : "icon"}
            aria-label={`Actions for ${engine.serial_number}`}
            className={onImage ? "bg-background/80 backdrop-blur-sm" : undefined}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setEditing(engine);
              setDialogOpen(true);
            }}
          >
            <Pencil className="size-4" /> Edit
          </DropdownMenuItem>
          {engine.status === "in_master" && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleting(engine)}
              >
                <Trash2 className="size-4" /> Remove
              </DropdownMenuItem>
            </>
          )}
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
      <Plus className="size-4" /> Add Engine
    </Button>
  );

  const q = cardSearch.trim().toLowerCase();
  const cardEngines = q
    ? engines.filter(
        (e) =>
          e.serial_number.toLowerCase().includes(q) ||
          `${e.brand} ${e.model}`.toLowerCase().includes(q)
      )
    : engines;

  const columns: ColumnDef<EngineRow>[] = [
    {
      accessorKey: "serial_number",
      header: ({ column }) => <SortableHeader column={column}>Serial</SortableHeader>,
      cell: ({ getValue }) => (
        <span className="font-mono text-sm">{getValue<string>()}</span>
      ),
    },
    {
      id: "model",
      accessorFn: (e) => `${e.brand} ${e.model}`,
      header: ({ column }) => <SortableHeader column={column}>Model</SortableHeader>,
      cell: ({ row }) => (
        <div>
          <div className="font-medium">
            {row.original.brand} {row.original.model}
          </div>
          {row.original.horsepower != null && (
            <div className="text-xs text-muted-foreground">
              {row.original.horsepower} HP
            </div>
          )}
        </div>
      ),
    },
    {
      accessorKey: "condition",
      header: "Condition",
      cell: ({ getValue }) =>
        getValue<string>() === "brand_new" ? "Brand new" : "Second hand",
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => {
        const s = STATUS_BADGE[row.original.status];
        return (
          <div>
            <Badge variant={s.variant}>{s.label}</Badge>
            {row.original.shop_name && (
              <div className="mt-0.5 text-xs text-muted-foreground">
                {row.original.shop_name}
              </div>
            )}
          </div>
        );
      },
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
      id: "actions",
      header: "",
      cell: ({ row }) => <RowActions engine={row.original} />,
    },
  ];

  return (
    <>
      {view === "table" ? (
        <DataTable
          columns={columns}
          data={engines}
          searchPlaceholder="Search serial or model…"
          emptyMessage="No engines yet — add one, or log a receiving."
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
                placeholder="Search serial or model…"
                className="pl-8"
                aria-label="Search engines"
              />
            </div>
            <div className="ml-auto flex items-center gap-2">
              <ViewToggle value={view} onChange={setView} />
              {addButton}
            </div>
          </div>

          {cardEngines.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search />
                </EmptyMedia>
                <EmptyDescription>
                  {q ? `Nothing matches “${cardSearch}”.` : "No engines yet."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {cardEngines.map((e) => {
                const s = STATUS_BADGE[e.status];
                return (
                  <div
                    key={e.id}
                    className="flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
                  >
                    <div className="relative">
                      <ProductCardImage
                        path={e.image_path}
                        alt={`${e.brand} ${e.model}`}
                        className={e.status === "sold" ? "grayscale" : undefined}
                      />
                      <div className="absolute right-1.5 top-1.5">
                        <RowActions engine={e} onImage />
                      </div>
                      <Badge variant={s.variant} className="absolute bottom-1.5 left-1.5">
                        {s.label}
                      </Badge>
                    </div>
                    <div className="flex flex-1 flex-col gap-1 p-3">
                      <div className="line-clamp-2 text-sm font-medium">
                        {e.brand} {e.model}
                        {e.horsepower != null && ` — ${e.horsepower}HP`}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        SN {e.serial_number}
                      </div>
                      <div className="mt-auto flex items-baseline justify-between pt-1.5">
                        <span className="text-base font-semibold tabular-nums">
                          {formatCentavos(e.price_centavos)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {e.condition === "brand_new" ? "Brand new" : "Second hand"}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted-foreground tabular-nums">
            {cardEngines.length} of {engines.length} engines
          </p>
        </div>
      )}
      <EngineFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        models={models}
        engine={editing}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={`Remove engine ${deleting?.serial_number}?`}
        description="Only engines still in master stock can be removed. History stays in the ledger."
        confirmLabel="Remove"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          const res = await softDeleteEngine(deleting.id);
          if (res.ok) toast.success(`${deleting.serial_number} removed`);
          else toast.error(res.error);
        }}
      />
    </>
  );
}
