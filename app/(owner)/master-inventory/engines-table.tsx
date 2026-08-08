"use client";

import * as React from "react";
import Link from "next/link";
import { type ColumnDef } from "@tanstack/react-table";
import { Cog, MoreHorizontal, PackagePlus, Pencil, Trash2 } from "lucide-react";
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
import {
  ServerDataTable,
  ServerSortableHeader,
  ServerSearchInput,
  ServerPaginationBar,
} from "@/components/data-table/server-data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ShopBadge } from "@/components/shop-badge";
import { ProductCardImage } from "@/components/product-image";
import { ViewToggle, usePersistedView } from "@/components/view-toggle";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { Search } from "lucide-react";
import { softDeleteEngine } from "./actions";
import { EngineFormDialog } from "./engine-form-dialog";
import { AddEngineDialog } from "./add-engine-dialog";
import { ModelManagerDialog } from "./reference-data-dialogs";

type StatusBadge = {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
};

const STATUS_BADGE: Record<EngineRow["status"], StatusBadge> = {
  in_master: { label: "In master", variant: "secondary" },
  // 0027. Stock sent toward a shop and not yet confirmed — an ordinary state,
  // and the one that was missing: `STATUS_BADGE[status].variant` on an
  // in-transit engine threw and took the whole Engines tab to the error
  // boundary for every role.
  in_transit: { label: "In transit", variant: "secondary" },
  delivered: { label: "At shop", variant: "default" },
  sold: { label: "Sold", variant: "outline" },
  returned: { label: "Returned", variant: "secondary" },
  // 0069. Set by a warranty replacement — the defective unit goes back to
  // master and is deliberately not sellable.
  defective: { label: "Defective", variant: "destructive" },
};

/** Never index STATUS_BADGE directly.
 *
 *  The map is keyed on EngineRow["status"], so tsc will now force it to cover
 *  every enum value — but a migration can add one before this file is updated,
 *  and a missing key must degrade to a readable badge, not crash the page. */
function statusBadge(status: string): StatusBadge {
  return (
    STATUS_BADGE[status as EngineRow["status"]] ?? {
      label: status.replace(/_/g, " "),
      variant: "outline",
    }
  );
}

export function EnginesTable({
  engines,
  models,
  suppliers,
  priceLocked = false,
  retireLocked = false,
  total,
  page,
  pageSize,
  q,
}: {
  engines: EngineRow[];
  models: EngineModel[];
  suppliers: { id: string; name: string }[];
  /** 0100: admin edits everything EXCEPT the selling price (Gerry-only). */
  priceLocked?: boolean;
  /** 0102: removing an in-master serial / retiring a model is Gerry-only. */
  retireLocked?: boolean;
  /** Server-paginated: `engines` is ONE page, not the whole registry. */
  total: number;
  page: number;
  pageSize: number;
  q: string;
}) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [addOpen, setAddOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<EngineRow | null>(null);
  const [deleting, setDeleting] = React.useState<EngineRow | null>(null);
  const [view, setView] = usePersistedView("jm-view-owner-engines");
  const [modelMgrOpen, setModelMgrOpen] = React.useState(false);
  const modelsById = React.useMemo(
    () => new Map(models.map((m) => [m.id, m])),
    [models]
  );

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
          {engine.status === "in_master" && !retireLocked && (
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

  // Add engine = a supplier-less receiving through fn_receive_stock (0059);
  // creation still only via the definer function (0049 lockdown intact).
  const toolbarButtons = (
    <>
      <Button variant="outline" onClick={() => setModelMgrOpen(true)}>
        <Cog className="size-4" /> Models
      </Button>
      <Button onClick={() => setAddOpen(true)}>
        <PackagePlus className="size-4" /> Add engine
      </Button>
    </>
  );

  // Cards show the same server page as the table — search/paging live in the
  // URL, so a card search hits the whole registry, not just this page.
  const cardEngines = engines;

  const columns: ColumnDef<EngineRow>[] = [
    {
      accessorKey: "serial_number",
      header: () => <ServerSortableHeader column="serial_number">Serial</ServerSortableHeader>,
      cell: ({ getValue }) => (
        <span className="font-mono text-sm">{getValue<string>()}</span>
      ),
    },
    {
      id: "model",
      accessorFn: (e) => `${e.brand} ${e.model}`,
      header: () => <ServerSortableHeader column="model">Model</ServerSortableHeader>,
      cell: ({ row }) => (
        <div>
          <div className="flex items-center gap-1.5 font-medium">
            {row.original.brand} {row.original.model}
            {modelsById.get(row.original.engine_model_id)?.is_serialized === false && (
              <Badge variant="outline" className="text-muted-foreground">no serials</Badge>
            )}
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
        const s = statusBadge(row.original.status);
        return (
          <div className="flex flex-wrap items-center gap-1">
            <Badge variant={s.variant}>{s.label}</Badge>
            {row.original.shop_name && (
              <ShopBadge
                shop={{
                  name: row.original.shop_name,
                  color_key: row.original.shop_color_key,
                }}
              />
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "cost_centavos",
      header: () => <ServerSortableHeader column="cost_centavos">Cost</ServerSortableHeader>,
      cell: ({ getValue }) => (
        <span className="tabular-nums">{formatCentavos(getValue<number>())}</span>
      ),
    },
    {
      accessorKey: "price_centavos",
      header: () => <ServerSortableHeader column="price_centavos">Price</ServerSortableHeader>,
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <span className="tabular-nums font-medium">
            {formatCentavos(row.original.price_centavos)}
          </span>
          {row.original.price_centavos <= row.original.cost_centavos && (
            <Badge variant="destructive">Below cost</Badge>
          )}
        </div>
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
        <ServerDataTable
          columns={columns}
          data={engines}
          total={total}
          page={page}
          pageSize={pageSize}
          q={q}
          searchPlaceholder="Search serial or model…"
          emptyMessage="No engines yet — click Add engine, or receive from a supplier (Suppliers → Receiving)."
          toolbar={
            <>
              <ViewToggle value={view} onChange={setView} />
              {toolbarButtons}
            </>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <ServerSearchInput q={q} placeholder="Search serial or model…" />
            <div className="ml-auto flex items-center gap-2">
              <ViewToggle value={view} onChange={setView} />
              {toolbarButtons}
            </div>
          </div>

          {cardEngines.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search />
                </EmptyMedia>
                <EmptyDescription>
                  {q ? (
                    `Nothing matches “${q}”.`
                  ) : (
                    <>
                      No engines yet — click{" "}
                      <button className="underline" onClick={() => setAddOpen(true)}>
                        Add engine
                      </button>
                      , or receive from a{" "}
                      <Link className="underline" href="/suppliers?tab=receiving">
                        supplier
                      </Link>
                      .
                    </>
                  )}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {cardEngines.map((e) => {
                const s = statusBadge(e.status);
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
                      <div className="absolute bottom-1.5 left-1.5 flex flex-wrap items-center gap-1">
                        <Badge variant={s.variant}>{s.label}</Badge>
                        {modelsById.get(e.engine_model_id)?.is_serialized === false && (
                          <Badge variant="outline" className="text-muted-foreground">no serials</Badge>
                        )}
                        {e.shop_name && (
                          <ShopBadge
                            shop={{ name: e.shop_name, color_key: e.shop_color_key }}
                          />
                        )}
                      </div>
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
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-base font-semibold tabular-nums">
                            {formatCentavos(e.price_centavos)}
                          </span>
                          {e.price_centavos <= e.cost_centavos && (
                            <Badge variant="destructive">Below cost</Badge>
                          )}
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
          <ServerPaginationBar
            total={total}
            page={page}
            pageSize={pageSize}
            noun="engines"
          />
        </div>
      )}
      <EngineFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        models={models}
        engine={editing}
        priceLocked={priceLocked}
      />
      <AddEngineDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        models={models}
        suppliers={suppliers}
      />
      <ModelManagerDialog
        open={modelMgrOpen}
        models={models}
        retireLocked={retireLocked}
        onClose={() => setModelMgrOpen(false)}
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
