"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Barcode,
  Loader2,
  Minus,
  Plus,
  ScanLine,
  Send,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { formatCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProductThumb } from "@/components/product-image";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { recordSale } from "../actions";

interface CartPart {
  kind: "part";
  part_id: string;
  name: string;
  unit: string;
  price_centavos: number;
  available: number;
  qty: number;
}
interface CartEngine {
  kind: "engine";
  engine_id: string;
  label: string;
  serial: string;
  price_centavos: number;
}
type CartLine = CartPart | CartEngine;

export function RecordSaleForm({
  stock,
  engines,
  fitmentHints = {},
}: {
  stock: ShopStockRow[];
  engines: ShopEngineRow[];
  /** part_id → "Yamaha Enduro E40GMHL 40HP, …" */
  fitmentHints?: Record<string, string>;
}) {
  const router = useRouter();
  const scanRef = React.useRef<HTMLInputElement>(null);
  const [scan, setScan] = React.useState("");
  const [search, setSearch] = React.useState("");
  const [cart, setCart] = React.useState<CartLine[]>([]);
  const [custName, setCustName] = React.useState("");
  const [custPhone, setCustPhone] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  // Keep the scan box focused — keyboard-wedge scanners type + press Enter.
  React.useEffect(() => {
    scanRef.current?.focus();
  }, []);

  // Draft survives a refresh or brief WiFi drop — restore once on mount.
  const CART_KEY = "jm-sale-draft";
  React.useEffect(() => {
    try {
      const raw = localStorage.getItem(CART_KEY);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (Array.isArray(draft.cart) && draft.cart.length > 0) {
        setCart(draft.cart);
        setCustName(draft.custName ?? "");
        setCustPhone(draft.custPhone ?? "");
        toast.info("Restored your unsent sale draft");
      }
    } catch {
      /* corrupted draft — ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  React.useEffect(() => {
    try {
      if (cart.length === 0) localStorage.removeItem(CART_KEY);
      else localStorage.setItem(CART_KEY, JSON.stringify({ cart, custName, custPhone }));
    } catch {
      /* storage full/blocked — non-fatal */
    }
  }, [cart, custName, custPhone]);

  const hasEngine = cart.some((l) => l.kind === "engine");
  const total = cart.reduce(
    (s, l) => s + (l.kind === "part" ? l.price_centavos * l.qty : l.price_centavos),
    0
  );

  function addPart(p: ShopStockRow) {
    setCart((c) => {
      const existing = c.find(
        (l): l is CartPart => l.kind === "part" && l.part_id === p.part_id
      );
      if (existing) {
        return c.map((l) =>
          l.kind === "part" && l.part_id === p.part_id ? { ...l, qty: l.qty + 1 } : l
        );
      }
      return [
        ...c,
        {
          kind: "part",
          part_id: p.part_id,
          name: p.name,
          unit: p.unit,
          price_centavos: p.price_centavos,
          available: p.qty,
          qty: 1,
        },
      ];
    });
  }

  function addEngine(e: ShopEngineRow) {
    setCart((c) => {
      if (c.some((l) => l.kind === "engine" && l.engine_id === e.engine_id)) {
        toast.info("That engine is already in the sale");
        return c;
      }
      return [
        ...c,
        {
          kind: "engine",
          engine_id: e.engine_id,
          serial: e.serial_number,
          label: `${e.brand} ${e.model}${e.horsepower != null ? ` ${e.horsepower}HP` : ""}`,
          price_centavos: e.price_centavos,
        },
      ];
    });
  }

  function onScan(e: React.FormEvent) {
    e.preventDefault();
    const code = scan.trim();
    setScan("");
    if (!code) return;

    const part = stock.find(
      (p) => p.barcode?.toLowerCase() === code.toLowerCase()
    );
    if (part) {
      addPart(part);
      toast.success(`${part.name} added`);
      return;
    }
    const engine = engines.find(
      (en) => en.serial_number.toLowerCase() === code.toLowerCase()
    );
    if (engine) {
      addEngine(engine);
      toast.success(`Engine ${engine.serial_number} added`);
      return;
    }
    toast.error(`No match for "${code}" in your shop stock`);
  }

  function setQty(partId: string, qty: number) {
    if (qty <= 0) {
      setCart((c) => c.filter((l) => !(l.kind === "part" && l.part_id === partId)));
      return;
    }
    setCart((c) =>
      c.map((l) => (l.kind === "part" && l.part_id === partId ? { ...l, qty } : l))
    );
  }

  const q = search.trim().toLowerCase();
  const matches =
    q.length >= 2
      ? [
          ...stock
            .filter(
              (p) =>
                p.name.toLowerCase().includes(q) ||
                (p.sku ?? "").toLowerCase().includes(q) ||
                (p.barcode ?? "").toLowerCase().includes(q)
            )
            .slice(0, 6),
        ]
      : [];
  const engineMatches =
    q.length >= 2
      ? engines
          .filter(
            (en) =>
              en.serial_number.toLowerCase().includes(q) ||
              `${en.brand} ${en.model}`.toLowerCase().includes(q)
          )
          .slice(0, 4)
      : [];

  async function onSubmit() {
    if (cart.length === 0) {
      toast.error("Scan or add at least one item");
      return;
    }
    if (hasEngine && custName.trim() === "") {
      toast.error("Engine sales need the customer's name (for the warranty)");
      return;
    }
    for (const l of cart) {
      if (l.kind === "part" && l.qty > l.available) {
        toast.error(`${l.name}: only ${l.available} ${l.unit} on hand`);
        return;
      }
    }

    setSubmitting(true);
    const res = await recordSale({
      customer_id: null,
      customer: custName.trim()
        ? { name: custName.trim(), phone: custPhone.trim() || undefined }
        : null,
      part_lines: cart
        .filter((l): l is CartPart => l.kind === "part")
        .map((l) => ({ part_id: l.part_id, qty: l.qty })),
      engine_ids: cart
        .filter((l): l is CartEngine => l.kind === "engine")
        .map((l) => l.engine_id),
    });
    setSubmitting(false);

    if (res.ok) {
      toast.success("Sale recorded — sent to the owner for approval");
      setCart([]);
      setCustName("");
      setCustPhone("");
      router.refresh();
      scanRef.current?.focus();
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="flex flex-col gap-4 lg:col-span-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Record Sale</h1>
          <p className="text-sm text-muted-foreground">
            Scan a barcode / engine serial, or search. Nothing deducts until
            the owner approves.
          </p>
        </div>

        {/* Scan box */}
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={onScan} className="flex items-center gap-2">
              <ScanLine className="size-5 shrink-0 text-muted-foreground" />
              <Input
                ref={scanRef}
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                placeholder="Scan barcode or serial, then Enter…"
                className="text-base"
                autoComplete="off"
              />
              <Button type="submit" variant="secondary">
                <Barcode className="size-4" /> Add
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Search fallback */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">No scanner? Search</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type at least 2 letters…"
            />
            {matches.map((p) => (
              <button
                key={p.part_id}
                type="button"
                onClick={() => {
                  addPart(p);
                  toast.success(`${p.name} added`);
                }}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <ProductThumb path={p.image_path} alt={p.name} size={36} />
                  <span className="min-w-0">
                    {p.name}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {p.qty} {p.unit} on hand
                    </span>
                    {fitmentHints[p.part_id] && (
                      <span className="block truncate text-xs text-accent-foreground">
                        Fits: {fitmentHints[p.part_id]}
                      </span>
                    )}
                  </span>
                </span>
                <span className="tabular-nums font-medium">
                  {formatCentavos(p.price_centavos)}
                </span>
              </button>
            ))}
            {engineMatches.map((en) => (
              <button
                key={en.engine_id}
                type="button"
                onClick={() => addEngine(en)}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <ProductThumb
                    path={en.image_path}
                    alt={`${en.brand} ${en.model}`}
                    size={36}
                  />
                  <span className="min-w-0">
                    <Badge variant="secondary" className="mr-2">
                      Engine
                    </Badge>
                    {en.brand} {en.model}
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {en.serial_number}
                    </span>
                  </span>
                </span>
                <span className="tabular-nums font-medium">
                  {formatCentavos(en.price_centavos)}
                </span>
              </button>
            ))}
            {q.length >= 2 && matches.length + engineMatches.length === 0 && (
              <p className="px-1 text-sm text-muted-foreground">
                Nothing in your shop stock matches.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cart */}
      <div className="lg:col-span-2">
        <Card className="lg:sticky lg:top-20">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShoppingCart className="size-4" /> Sale ({cart.length} line
              {cart.length === 1 ? "" : "s"})
            </CardTitle>
            <CardDescription>
              Submitted to the owner as PENDING.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {cart.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Scan or search to add items.
              </p>
            )}
            {cart.map((l) =>
              l.kind === "part" ? (
                <div key={l.part_id} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{l.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatCentavos(l.price_centavos)} × {l.qty} ={" "}
                      {formatCentavos(l.price_centavos * l.qty)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7"
                      aria-label="Decrease"
                      onClick={() => setQty(l.part_id, l.qty - 1)}
                    >
                      <Minus className="size-3" />
                    </Button>
                    <span className="w-8 text-center tabular-nums text-sm">{l.qty}</span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-7"
                      aria-label="Increase"
                      onClick={() => setQty(l.part_id, l.qty + 1)}
                    >
                      <Plus className="size-3" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div key={l.engine_id} className="flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">
                      <Badge variant="secondary" className="mr-1">
                        Engine
                      </Badge>
                      {l.label}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      SN {l.serial} · {formatCentavos(l.price_centavos)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label="Remove engine"
                    onClick={() =>
                      setCart((c) =>
                        c.filter(
                          (x) => !(x.kind === "engine" && x.engine_id === l.engine_id)
                        )
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )
            )}

            {cart.length > 0 && (
              <>
                <div className="flex items-center justify-between border-t pt-3">
                  <span className="text-sm font-medium">Total</span>
                  <span className="text-lg font-bold tabular-nums">
                    {formatCentavos(total)}
                  </span>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="cust-name">
                    Customer {hasEngine ? "(required for engine warranty)" : "(optional)"}
                  </Label>
                  <Input
                    id="cust-name"
                    value={custName}
                    onChange={(e) => setCustName(e.target.value)}
                    placeholder="Customer name"
                  />
                  <Input
                    value={custPhone}
                    onChange={(e) => setCustPhone(e.target.value)}
                    placeholder="Phone (optional)"
                    aria-label="Customer phone"
                  />
                </div>

                <Button onClick={onSubmit} disabled={submitting} className="w-full">
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Submit for approval
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
