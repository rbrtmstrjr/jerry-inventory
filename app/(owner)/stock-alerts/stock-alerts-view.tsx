"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ColumnDef } from "@tanstack/react-table";
import { Loader2, Package, Printer, Store, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { MasterLowStockRow, ShopLowStockRow, ShopOption } from "@/lib/db-types";
import { Badge } from "@/components/ui/badge";
import { ShopBadge } from "@/components/shop-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { removeShopOverride, setProductThreshold, setShopOverride } from "./actions";

export interface ProductThresholdRow {
  kind: "part" | "engine_model";
  id: string;
  name: string;
  unit: string;
  reorder_level: number;
  preferred_supplier_id: string | null;
}

export interface OverrideRow {
  id: string;
  shop_id: string;
  shop_name: string;
  shop_color_key: string | null;
  kind: "part" | "engine_model";
  product_id: string;
  product_name: string;
  reorder_level: number;
  default_level: number;
}

const KindBadge = ({ kind }: { kind: "part" | "engine_model" }) => (
  <Badge variant="secondary">{kind === "part" ? "Part" : "Engine"}</Badge>
);

export function StockAlertsView({
  master,
  shopLow,
  products,
  overrides,
  shops,
  suppliers,
}: {
  master: MasterLowStockRow[];
  shopLow: ShopLowStockRow[];
  products: ProductThresholdRow[];
  overrides: OverrideRow[];
  shops: ShopOption[];
  suppliers: { id: string; name: string }[];
}) {
  const [shopFilter, setShopFilter] = React.useState("all");
  const colorByShopId = new Map(shops.map((s) => [s.id, s.color_key]));

  const shopRows =
    shopFilter === "all" ? shopLow : shopLow.filter((r) => r.shop_id === shopFilter);

  const masterColumns: ColumnDef<MasterLowStockRow>[] = [
    {
      accessorKey: "name",
      header: ({ column }) => <SortableHeader column={column}>Product</SortableHeader>,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <KindBadge kind={row.original.kind} />
          <span className="font-medium">{row.original.name}</span>
        </div>
      ),
    },
    {
      accessorKey: "on_hand",
      header: ({ column }) => <SortableHeader column={column}>On hand</SortableHeader>,
      cell: ({ row }) => (
        <span className="tabular-nums font-semibold text-destructive">
          {row.original.on_hand} {row.original.unit}
        </span>
      ),
    },
    {
      accessorKey: "threshold",
      header: ({ column }) => <SortableHeader column={column}>Reorder at</SortableHeader>,
      cell: ({ getValue }) => <span className="tabular-nums">{getValue<number>()}</span>,
    },
    {
      accessorKey: "shortfall",
      header: ({ column }) => <SortableHeader column={column}>Short by</SortableHeader>,
      cell: ({ getValue }) => (
        <span className="tabular-nums font-medium">{getValue<number>()}</span>
      ),
    },
    {
      accessorKey: "supplier_name",
      header: "Supplier",
      cell: ({ row }) =>
        row.original.supplier_name ? (
          <span>{row.original.supplier_name}</span>
        ) : (
          <span className="text-xs text-muted-foreground">— set one</span>
        ),
    },
  ];

  const shopColumns: ColumnDef<ShopLowStockRow>[] = [
    {
      accessorKey: "shop_name",
      header: ({ column }) => <SortableHeader column={column}>Shop</SortableHeader>,
      cell: ({ row }) => (
        <ShopBadge
          shop={{
            name: row.original.shop_name,
            color_key: colorByShopId.get(row.original.shop_id) ?? null,
          }}
        />
      ),
    },
    {
      accessorKey: "name",
      header: ({ column }) => <SortableHeader column={column}>Product</SortableHeader>,
      cell: ({ row }) => (
        <div className="flex items-center gap-2">
          <KindBadge kind={row.original.kind} />
          <span className="font-medium">{row.original.name}</span>
        </div>
      ),
    },
    {
      accessorKey: "on_hand",
      header: ({ column }) => <SortableHeader column={column}>On hand</SortableHeader>,
      cell: ({ row }) => (
        <span className="tabular-nums font-semibold text-destructive">
          {row.original.on_hand} {row.original.unit}
        </span>
      ),
    },
    {
      accessorKey: "threshold",
      header: "Reorder at",
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.threshold}
          {row.original.threshold_is_override && (
            <Badge variant="outline" className="ml-2">
              shop override
            </Badge>
          )}
        </span>
      ),
    },
    {
      accessorKey: "shortfall",
      header: ({ column }) => <SortableHeader column={column}>Short by</SortableHeader>,
      cell: ({ getValue }) => (
        <span className="tabular-nums font-medium">{getValue<number>()}</span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Stock Alerts</h1>
        <p className="text-sm text-muted-foreground">
          Master shortages are bought from a supplier. Shop shortages are fixed
          by delivering from master.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardDescription>Master items low</CardDescription>
            <Package className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{master.length}</div>
            <p className="text-xs text-muted-foreground">buy from suppliers</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardDescription>Shop items low</CardDescription>
            <Store className="size-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold tabular-nums">{shopLow.length}</div>
            <p className="text-xs text-muted-foreground">
              across {new Set(shopLow.map((r) => r.shop_id)).size} shop(s) — deliver
              from master
            </p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="master">
        <TabsList>
          <TabsTrigger value="master">Master ({master.length})</TabsTrigger>
          <TabsTrigger value="shops">All shops ({shopLow.length})</TabsTrigger>
          <TabsTrigger value="thresholds">Reorder levels</TabsTrigger>
        </TabsList>

        {/* MASTER → purchase list */}
        <TabsContent value="master" className="pt-2">
          <DataTable
            columns={masterColumns}
            data={master}
            searchPlaceholder="Search product or supplier…"
            emptyMessage="Master stock is healthy — nothing to buy."
            toolbar={
              master.length > 0 ? (
                <Button asChild>
                  <Link href="/stock-alerts/purchase-list" target="_blank">
                    <Printer className="size-4" /> Print purchase list
                  </Link>
                </Button>
              ) : null
            }
          />
        </TabsContent>

        {/* ALL SHOPS → deliver */}
        <TabsContent value="shops" className="pt-2">
          <DataTable
            columns={shopColumns}
            data={shopRows}
            searchPlaceholder="Search shop or product…"
            emptyMessage="No shop shortages."
            toolbar={
              <Select value={shopFilter} onValueChange={setShopFilter}>
                <SelectTrigger className="w-52">
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
            }
          />
        </TabsContent>

        {/* THRESHOLDS */}
        <TabsContent value="thresholds" className="flex flex-col gap-6 pt-2">
          <ThresholdEditor products={products} suppliers={suppliers} />
          <OverrideEditor
            products={products}
            shops={shops}
            overrides={overrides}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Default reorder level + preferred supplier per product. */
function ThresholdEditor({
  products,
  suppliers,
}: {
  products: ProductThresholdRow[];
  suppliers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [search, setSearch] = React.useState("");
  const [busy, setBusy] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Record<string, { level: string; supplier: string }>>({});

  const q = search.trim().toLowerCase();
  const rows = q
    ? products.filter((p) => p.name.toLowerCase().includes(q))
    : products;

  const valueFor = (p: ProductThresholdRow) =>
    draft[p.id] ?? {
      level: String(p.reorder_level),
      supplier: p.preferred_supplier_id ?? "none",
    };

  async function save(p: ProductThresholdRow) {
    const v = valueFor(p);
    const level = parseInt(v.level || "0", 10);
    if (isNaN(level) || level < 0) {
      toast.error("Reorder level must be 0 or more");
      return;
    }
    setBusy(p.id);
    const res = await setProductThreshold({
      kind: p.kind,
      id: p.id,
      reorder_level: level,
      preferred_supplier_id: v.supplier === "none" ? null : v.supplier,
    });
    setBusy(null);
    if (res.ok) {
      toast.success(`${p.name} updated`);
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-semibold">Default reorder levels</p>
            <CardDescription>
              Used for master, and for any shop without its own override. 0 = no
              alerts for that product.
            </CardDescription>
          </div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search product…"
            className="w-56"
            aria-label="Search products"
          />
        </div>
      </CardHeader>
      <CardContent className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto">
        {rows.map((p) => {
          const v = valueFor(p);
          return (
            <div
              key={p.id}
              className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <KindBadge kind={p.kind} />
                <span className="truncate text-sm font-medium">{p.name}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Label htmlFor={`lvl-${p.id}`} className="text-xs text-muted-foreground">
                  Reorder at
                </Label>
                <Input
                  id={`lvl-${p.id}`}
                  inputMode="numeric"
                  value={v.level}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      [p.id]: { ...v, level: e.target.value.replace(/\D/g, "") },
                    }))
                  }
                  className="w-20 tabular-nums"
                />
              </div>
              <Select
                value={v.supplier}
                onValueChange={(s) =>
                  setDraft((d) => ({ ...d, [p.id]: { ...v, supplier: s } }))
                }
              >
                <SelectTrigger className="w-44">
                  <SelectValue placeholder="Supplier" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No preferred supplier</SelectItem>
                  {suppliers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button size="sm" disabled={busy === p.id} onClick={() => save(p)}>
                {busy === p.id && <Loader2 className="size-3.5 animate-spin" />}
                Save
              </Button>
            </div>
          );
        })}
        {rows.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No products match.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Per-shop overrides — "default X, this shop Y". */
function OverrideEditor({
  products,
  shops,
  overrides,
}: {
  products: ProductThresholdRow[];
  shops: { id: string; name: string }[];
  overrides: OverrideRow[];
}) {
  const router = useRouter();
  const [shopId, setShopId] = React.useState("");
  const [productKey, setProductKey] = React.useState("");
  const [level, setLevel] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  async function add() {
    const product = products.find((p) => `${p.kind}:${p.id}` === productKey);
    if (!shopId || !product) {
      toast.error("Pick a shop and a product");
      return;
    }
    const n = parseInt(level || "", 10);
    if (isNaN(n) || n < 0) {
      toast.error("Enter a reorder level");
      return;
    }
    setBusy(true);
    const res = await setShopOverride({
      shop_id: shopId,
      kind: product.kind,
      product_id: product.id,
      reorder_level: n,
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Override saved");
      setProductKey("");
      setLevel("");
      router.refresh();
    } else toast.error(res.error);
  }

  async function drop(id: string) {
    setBusy(true);
    const res = await removeShopOverride(id);
    setBusy(false);
    if (res.ok) {
      toast.success("Override removed — back to the default");
      router.refresh();
    } else toast.error(res.error);
  }

  return (
    <Card>
      <CardHeader>
        <p className="font-semibold">Per-shop overrides</p>
        <CardDescription>
          A branch usually needs a smaller buffer than master. An override wins
          over the product default for that shop only.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-2 rounded-md border p-3">
          <div className="grid gap-1.5">
            <Label className="text-xs">Shop</Label>
            <Select value={shopId} onValueChange={setShopId}>
              <SelectTrigger className="w-48">
                <SelectValue placeholder="Pick a shop" />
              </SelectTrigger>
              <SelectContent>
                {shops.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Product</Label>
            <Select value={productKey} onValueChange={setProductKey}>
              <SelectTrigger className="w-64">
                <SelectValue placeholder="Pick a product" />
              </SelectTrigger>
              <SelectContent>
                {products.map((p) => (
                  <SelectItem key={`${p.kind}:${p.id}`} value={`${p.kind}:${p.id}`}>
                    {p.name} (default {p.reorder_level})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Reorder at</Label>
            <Input
              inputMode="numeric"
              value={level}
              onChange={(e) => setLevel(e.target.value.replace(/\D/g, ""))}
              className="w-24 tabular-nums"
              placeholder="0"
            />
          </div>
          <Button onClick={add} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Set override
          </Button>
        </div>

        {overrides.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No overrides — every shop uses the product defaults.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {overrides.map((o) => (
              <div
                key={o.id}
                className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm"
              >
                <ShopBadge shop={{ name: o.shop_name, color_key: o.shop_color_key }} />
                <span className="min-w-0 flex-1 truncate font-medium">
                  {o.product_name}
                </span>
                <span className="text-xs text-muted-foreground">
                  default {o.default_level} →{" "}
                  <span className="font-semibold text-foreground">
                    this shop {o.reorder_level}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Remove override"
                  disabled={busy}
                  onClick={() => drop(o.id)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
