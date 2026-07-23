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
import { TabCountBadge } from "@/components/ui/tab-count-badge";
import { DataTable, SortableHeader } from "@/components/data-table/data-table";
import { RequestsPanel, type RequestRow } from "./requests-panel";
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

const TAB_VALUES = ["master", "shops", "requests", "thresholds"];

export function StockAlertsView({
  master,
  shopLow,
  products,
  overrides,
  shops,
  suppliers,
  requests,
  initialTab,
}: {
  master: MasterLowStockRow[];
  shopLow: ShopLowStockRow[];
  products: ProductThresholdRow[];
  overrides: OverrideRow[];
  shops: ShopOption[];
  suppliers: { id: string; name: string }[];
  requests: RequestRow[];
  /** Deep link (?tab=requests) — e.g. from a delivery-request notification. */
  initialTab?: string;
}) {
  const router = useRouter();
  const [shopFilter, setShopFilter] = React.useState("all");
  const [masterSupplier, setMasterSupplier] = React.useState("all");
  const [masterKind, setMasterKind] = React.useState<"all" | "part" | "engine_model">("all");
  const [selectedMaster, setSelectedMaster] = React.useState<MasterLowStockRow[]>([]);
  const colorByShopId = new Map(shops.map((s) => [s.id, s.color_key]));
  const openRequests = requests.filter((r) => r.status === "open").length;
  const defaultTab =
    initialTab && TAB_VALUES.includes(initialTab) ? initialTab : "master";

  // Converting a request happens on the Deliveries page (that's where stock
  // moves) — jump there with the request pre-filled into the New Delivery form.
  const convertRequest = (id: string) => router.push(`/deliveries?request=${id}`);

  const shopRows =
    shopFilter === "all" ? shopLow : shopLow.filter((r) => r.shop_id === shopFilter);

  // Master tab: order/print one supplier at a time. Options come from the
  // suppliers actually present in the low-stock list ("__none__" = unassigned).
  const masterSuppliers = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of master) {
      const key = r.supplier_id ?? "__none__";
      if (!m.has(key)) m.set(key, r.supplier_name ?? "No supplier set");
    }
    return [...m.entries()].sort((a, b) =>
      a[0] === "__none__" ? 1 : b[0] === "__none__" ? -1 : a[1].localeCompare(b[1])
    );
  }, [master]);
  const masterRows = master.filter(
    (r) =>
      (masterSupplier === "all" || (r.supplier_id ?? "__none__") === masterSupplier) &&
      (masterKind === "all" || r.kind === masterKind)
  );
  // Print EXACTLY what's ticked; if nothing is ticked, print the whole filtered
  // list. Either way the sheet is built from an explicit id list — so it's the
  // filter/selection result, never fixed to all products.
  const toPrint = selectedMaster.length > 0 ? selectedMaster : masterRows;
  const purchaseHref = `/stock-alerts/purchase-list?ids=${encodeURIComponent(
    toPrint.map((r) => `${r.kind}:${r.product_id}`).join(",")
  )}`;

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
      {/* Heading lives in the server page shell so it paints instantly while
          this streams; the view starts at the summary cards. */}
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

      <Tabs defaultValue={defaultTab}>
        <TabsList>
          <TabsTrigger value="master">
            Master<TabCountBadge count={master.length} />
          </TabsTrigger>
          <TabsTrigger value="shops">
            All shops<TabCountBadge count={shopLow.length} />
          </TabsTrigger>
          <TabsTrigger value="requests">
            Requests
            <TabCountBadge count={openRequests} />
          </TabsTrigger>
          <TabsTrigger value="thresholds">Reorder levels</TabsTrigger>
        </TabsList>

        {/* MASTER → purchase list. Tick specific items to order only those
            (tight budget), or filter by type/supplier and print the result. */}
        <TabsContent value="master" className="pt-2">
          <DataTable
            columns={masterColumns}
            data={masterRows}
            searchPlaceholder="Search product or supplier…"
            emptyMessage="Master stock is healthy — nothing to buy."
            enableSelection
            getRowId={(r) => `${r.kind}:${r.product_id}`}
            onSelectedChange={setSelectedMaster}
            filters={
              <>
                <Select
                  value={masterKind}
                  onValueChange={(v) =>
                    setMasterKind(v as "all" | "part" | "engine_model")
                  }
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="part">Parts</SelectItem>
                    <SelectItem value="engine_model">Engines</SelectItem>
                  </SelectContent>
                </Select>
                {masterSuppliers.length > 1 && (
                  <Select value={masterSupplier} onValueChange={setMasterSupplier}>
                    <SelectTrigger className="w-56">
                      <SelectValue placeholder="All suppliers" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All suppliers</SelectItem>
                      {masterSuppliers.map(([key, name]) => (
                        <SelectItem key={key} value={key}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </>
            }
            toolbar={
              toPrint.length > 0 ? (
                <Button asChild>
                  <Link href={purchaseHref} target="_blank">
                    <Printer className="size-4" />
                    {selectedMaster.length > 0
                      ? `Print ${selectedMaster.length} selected`
                      : `Print list (${masterRows.length})`}
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

        {/* REQUESTS → shops asking for stock; Convert jumps to Deliveries */}
        <TabsContent value="requests" className="pt-2">
          <RequestsPanel requests={requests} onConvert={convertRequest} />
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
/** Reorder-level rows revealed per scroll batch. Each row mounts a heavy Radix
 *  Select, so rendering all ~400 at once is what made this tab lag. */
const REORDER_PAGE = 40;

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
  const [visibleCount, setVisibleCount] = React.useState(REORDER_PAGE);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);

  const q = search.trim().toLowerCase();
  const rows = q
    ? products.filter((p) => p.name.toLowerCase().includes(q))
    : products;
  const visibleRows = rows.slice(0, visibleCount);

  // Scroll-down reveal: render a batch, reveal more as the sentinel nears the
  // bottom of the SCROLL CONTAINER (root: scrollRef, not the viewport). Reset
  // the batch whenever the search narrows the list.
  React.useEffect(() => {
    setVisibleCount(REORDER_PAGE);
  }, [q]);
  React.useEffect(() => {
    const el = sentinelRef.current;
    if (!el || visibleCount >= rows.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) setVisibleCount((v) => v + REORDER_PAGE);
      },
      { root: scrollRef.current, rootMargin: "300px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visibleCount, rows.length]);

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
      <CardContent
        ref={scrollRef}
        className="flex max-h-[26rem] flex-col gap-2 overflow-y-auto"
      >
        {visibleRows.map((p) => {
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
        {visibleCount < rows.length && (
          <div
            ref={sentinelRef}
            className="py-2 text-center text-xs text-muted-foreground"
          >
            Loading more… ({visibleRows.length} of {rows.length})
          </div>
        )}
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
