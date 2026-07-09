"use client";

import * as React from "react";
import { type ColumnDef } from "@tanstack/react-table";
import { Anchor, Boxes, PhilippinePeso, Search } from "lucide-react";

import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { ProductCardImage } from "@/components/product-image";
import { ViewToggle, usePersistedView } from "@/components/view-toggle";

/** Owner's read-only view of one shop's on-hand stock. */
export function ShopStockReadonly({
  stock,
  engines,
}: {
  stock: ShopStockRow[];
  engines: ShopEngineRow[];
}) {
  const [view, setView] = usePersistedView("jm-view-owner-shopstock");
  const [cardSearch, setCardSearch] = React.useState("");

  const q = cardSearch.trim().toLowerCase();
  const cardStock = q
    ? stock.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          (s.barcode ?? "").toLowerCase().includes(q) ||
          (s.category ?? "").toLowerCase().includes(q)
      )
    : stock;

  const totalUnits = stock.reduce((s, r) => s + r.qty, 0);
  const stockValue =
    stock.reduce((s, r) => s + r.qty * r.price_centavos, 0) +
    engines.reduce((s, e) => s + e.price_centavos, 0);
  const lowCount = stock.filter(
    (s) => s.reorder_level > 0 && s.qty <= s.reorder_level
  ).length;

  const stats = [
    {
      label: "Part units on hand",
      value: `${totalUnits}`,
      hint: `${stock.length} item line(s)${lowCount > 0 ? ` · ${lowCount} low` : ""}`,
      icon: Boxes,
    },
    {
      label: "Engines on hand",
      value: `${engines.length}`,
      hint: "by serial",
      icon: Anchor,
    },
    {
      label: "Stock value (at selling price)",
      value: formatCentavos(stockValue),
      hint: "parts + engines",
      icon: PhilippinePeso,
    },
  ];

  const columns: ColumnDef<ShopStockRow>[] = [
    {
      accessorKey: "name",
      header: ({ column }) => <SortableHeader column={column}>Item</SortableHeader>,
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.name}</div>
          <div className="text-xs text-muted-foreground">
            {row.original.category ?? ""}
            {row.original.barcode ? ` · ${row.original.barcode}` : ""}
          </div>
        </div>
      ),
    },
    {
      accessorKey: "qty",
      header: ({ column }) => <SortableHeader column={column}>On hand</SortableHeader>,
      cell: ({ row }) => {
        const low =
          row.original.qty <= row.original.reorder_level &&
          row.original.reorder_level > 0;
        return (
          <span className={`tabular-nums ${low ? "font-semibold text-destructive" : ""}`}>
            {row.original.qty} {row.original.unit}
            {low && (
              <Badge variant="destructive" className="ml-2">
                Low
              </Badge>
            )}
          </span>
        );
      },
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
      id: "value",
      header: "Line value",
      cell: ({ row }) => (
        <span className="tabular-nums text-muted-foreground">
          {formatCentavos(row.original.qty * row.original.price_centavos)}
        </span>
      ),
    },
  ];

  const engineColumns: ColumnDef<ShopEngineRow>[] = [
    {
      accessorKey: "serial_number",
      header: "Serial",
      cell: ({ getValue }) => (
        <span className="font-mono text-sm">{getValue<string>()}</span>
      ),
    },
    {
      id: "model",
      accessorFn: (e) => `${e.brand} ${e.model}`,
      header: ({ column }) => <SortableHeader column={column}>Model</SortableHeader>,
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
      accessorKey: "condition",
      header: "Condition",
      cell: ({ getValue }) =>
        getValue<string>() === "brand_new" ? "Brand new" : "Second hand",
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
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-3">
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

      <Tabs defaultValue="parts">
        <TabsList>
          <TabsTrigger value="parts">Parts &amp; Goods ({stock.length})</TabsTrigger>
          <TabsTrigger value="engines">Engines ({engines.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="parts" className="pt-2">
          {view === "table" ? (
            <DataTable
              columns={columns}
              data={stock}
              searchPlaceholder="Search item, barcode…"
              emptyMessage="Nothing delivered to this shop yet."
              rowClassName={(r) =>
                r.qty <= r.reorder_level && r.reorder_level > 0
                  ? "bg-destructive/5"
                  : undefined
              }
              toolbar={<ViewToggle value={view} onChange={setView} />}
            />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative w-full max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={cardSearch}
                    onChange={(e) => setCardSearch(e.target.value)}
                    placeholder="Search item, barcode…"
                    className="pl-8"
                    aria-label="Search stock"
                  />
                </div>
                <div className="ml-auto">
                  <ViewToggle value={view} onChange={setView} />
                </div>
              </div>

              {cardStock.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Search />
                    </EmptyMedia>
                    <EmptyDescription>
                      {q
                        ? `Nothing matches “${cardSearch}”.`
                        : "Nothing delivered to this shop yet."}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {cardStock.map((s) => {
                    const out = s.qty === 0;
                    const low = !out && s.reorder_level > 0 && s.qty <= s.reorder_level;
                    return (
                      <div
                        key={s.part_id}
                        className="flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
                      >
                        <div className="relative">
                          <ProductCardImage
                            path={s.image_path}
                            alt={s.name}
                            className={out ? "grayscale" : undefined}
                          />
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
                          <div className="line-clamp-2 text-sm font-medium">{s.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {s.category ?? "—"}
                          </div>
                          <div className="mt-auto flex items-baseline justify-between border-t pt-1.5">
                            <span className="text-base font-semibold tabular-nums">
                              {formatCentavos(s.price_centavos)}
                            </span>
                            <span
                              className={`text-xs tabular-nums ${
                                out ? "font-medium text-destructive" : "text-muted-foreground"
                              }`}
                            >
                              {s.qty} {s.unit}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground tabular-nums">
                {cardStock.length} of {stock.length} items
              </p>
            </div>
          )}
        </TabsContent>
        <TabsContent value="engines" className="pt-2">
          {view === "table" ? (
            <DataTable
              columns={engineColumns}
              data={engines}
              searchPlaceholder="Search serial or model…"
              emptyMessage="No engines at this shop right now."
              toolbar={<ViewToggle value={view} onChange={setView} />}
            />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex justify-end">
                <ViewToggle value={view} onChange={setView} />
              </div>
              {engines.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <Search />
                    </EmptyMedia>
                    <EmptyDescription>
                      No engines at this shop right now.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {engines.map((e) => (
                    <div
                      key={e.engine_id}
                      className="flex flex-col overflow-hidden rounded-lg border bg-card transition-shadow hover:shadow-md"
                    >
                      <ProductCardImage
                        path={e.image_path}
                        alt={`${e.brand} ${e.model}`}
                      />
                      <div className="flex flex-1 flex-col gap-1 p-3">
                        <div className="line-clamp-2 text-sm font-medium">
                          {e.brand} {e.model}
                          {e.horsepower != null && ` — ${e.horsepower}HP`}
                        </div>
                        <div className="font-mono text-xs text-muted-foreground">
                          SN {e.serial_number}
                        </div>
                        <div className="mt-auto flex items-baseline justify-between border-t pt-1.5">
                          <span className="text-base font-semibold tabular-nums">
                            {formatCentavos(e.price_centavos)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {e.condition === "brand_new" ? "Brand new" : "Second hand"}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
