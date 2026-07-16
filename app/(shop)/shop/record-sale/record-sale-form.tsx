"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Barcode,
  Loader2,
  Minus,
  Plus,
  Printer,
  ScanLine,
  Search,
  Send,
  ShoppingCart,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";
import { cn } from "@/lib/utils";
import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
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
  price_floor: number;
  price_mid: number;
  price_asking: number;
  agreedRaw: string; // pesos string — single source for the agreed price
}
type CartLine = CartPart | CartEngine;

const engineAgreed = (l: CartEngine) => parsePesosToCentavos(l.agreedRaw) ?? 0;

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
  const [tendered, setTendered] = React.useState("");
  const [paymentType, setPaymentType] = React.useState<"full" | "partial">("full");
  const [downpayment, setDownpayment] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [lastReceiptId, setLastReceiptId] = React.useState<string | null>(null);

  React.useEffect(() => {
    scanRef.current?.focus();
  }, []);

  // Draft survives a refresh or brief WiFi drop — restore once on mount.
  // v2: engine lines now carry tier prices + agreed price (old drafts ignored).
  const CART_KEY = "jm-sale-draft-v2";
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
    (s, l) => s + (l.kind === "part" ? l.price_centavos * l.qty : engineAgreed(l)),
    0
  );

  // cash/change helper (full payment only — informational, not stored)
  const tenderedCentavos = parsePesosToCentavos(tendered || "0");
  const change =
    tendered.trim() !== "" && tenderedCentavos !== null
      ? tenderedCentavos - total
      : null;

  // partial payment split
  const amountPaid =
    paymentType === "partial" ? parsePesosToCentavos(downpayment || "0") ?? 0 : total;
  const balanceDue = Math.max(0, total - amountPaid);

  // any engine negotiated below its floor?
  const belowFloor = cart.some(
    (l) => l.kind === "engine" && engineAgreed(l) < l.price_floor
  );

  function addPart(p: ShopStockRow) {
    setLastReceiptId(null);
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
    setLastReceiptId(null);
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
          price_floor: e.price_floor_centavos,
          price_mid: e.price_mid_centavos,
          price_asking: e.price_asking_centavos,
          // default the agreed price to the asking tier
          agreedRaw: (e.price_asking_centavos / 100).toFixed(2),
        },
      ];
    });
  }

  function setEngineAgreed(engineId: string, raw: string) {
    setCart((c) =>
      c.map((l) =>
        l.kind === "engine" && l.engine_id === engineId
          ? { ...l, agreedRaw: raw }
          : l
      )
    );
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
  const matches = q
    ? stock.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q) ||
          (p.barcode ?? "").toLowerCase().includes(q) ||
          (p.category ?? "").toLowerCase().includes(q)
      )
    : stock;
  const engineMatches = q
    ? engines.filter(
        (en) =>
          en.serial_number.toLowerCase().includes(q) ||
          `${en.brand} ${en.model}`.toLowerCase().includes(q)
      )
    : engines;

  async function onSubmit() {
    if (cart.length === 0) {
      toast.error("Scan or add at least one item");
      return;
    }
    if (hasEngine && custName.trim() === "") {
      toast.error("Engine sales need the customer's name (for the warranty)");
      return;
    }
    if (paymentType === "partial" && custName.trim() === "") {
      toast.error("Partial payment needs the customer's name — that's who owes the balance");
      return;
    }
    for (const l of cart) {
      if (l.kind === "part" && l.qty > l.available) {
        toast.error(`${l.name}: only ${l.available} ${l.unit} on hand`);
        return;
      }
      if (l.kind === "engine") {
        const agreed = engineAgreed(l);
        if (agreed <= 0) {
          toast.error(`${l.label}: enter an agreed price`);
          return;
        }
        if (agreed < l.price_floor) {
          toast.error(
            `${l.label}: ${formatCentavos(agreed)} is below the floor ${formatCentavos(l.price_floor)}`
          );
          return;
        }
      }
    }
    if (paymentType === "partial") {
      if (amountPaid <= 0) {
        toast.error("Enter the downpayment amount");
        return;
      }
      if (amountPaid > total) {
        toast.error("Downpayment can't be more than the total");
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
      engine_lines: cart
        .filter((l): l is CartEngine => l.kind === "engine")
        .map((l) => ({ engine_id: l.engine_id, agreed_price_centavos: engineAgreed(l) })),
      payment_type: paymentType,
      amount_paid_centavos: paymentType === "partial" ? amountPaid : null,
    });
    setSubmitting(false);

    if (res.ok) {
      toast.success("Sale saved — print the receipt for the customer");
      setLastReceiptId(res.id ?? null);
      setCart([]);
      setCustName("");
      setCustPhone("");
      setTendered("");
      setDownpayment("");
      setPaymentType("full");
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

        {/* Receipt-ready banner after a successful save */}
        {lastReceiptId && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-success/40 bg-success/5 px-4 py-3">
            <div>
              <p className="text-sm font-medium">Sale saved & receipt ready</p>
              <p className="text-xs text-muted-foreground">
                Print it for the buyer — the amount matches what the owner will
                review.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link href={`/receipt/${lastReceiptId}`} target="_blank">
                <Printer className="size-4" /> Print receipt
              </Link>
            </Button>
          </div>
        )}

        {/* One panel: scan on top, browse/search list below */}
        <Card className="overflow-hidden py-0 gap-0">
          <div className="border-b bg-muted/40 px-4 py-3">
            <form onSubmit={onScan} className="flex items-center gap-2">
              <ScanLine className="size-5 shrink-0 text-muted-foreground" />
              <Input
                ref={scanRef}
                value={scan}
                onChange={(e) => setScan(e.target.value)}
                placeholder="Scan barcode or serial, then Enter…"
                className="bg-background text-base"
                autoComplete="off"
              />
              <Button type="submit" variant="secondary">
                <Barcode className="size-4" /> Add
              </Button>
            </form>
          </div>

          <div className="flex flex-col gap-2 p-4">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="No scanner? Search or tap an item below…"
                className="pl-8"
                aria-label="Search shop stock"
              />
            </div>

            <div className="thin-scrollbar flex max-h-[52vh] flex-col gap-1.5 overflow-y-auto pr-1">
              {matches.map((p) => (
                <button
                  key={p.part_id}
                  type="button"
                  onClick={() => {
                    addPart(p);
                    toast.success(`${p.name} added`);
                  }}
                  disabled={p.qty === 0}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <ProductThumb path={p.image_path} alt={p.name} size={36} />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{p.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {p.qty} {p.unit} on hand
                        {fitmentHints[p.part_id] &&
                          ` · Fits: ${fitmentHints[p.part_id]}`}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 tabular-nums font-medium">
                    {formatCentavos(p.price_centavos)}
                  </span>
                </button>
              ))}

              {engineMatches.map((en) => (
                <button
                  key={en.engine_id}
                  type="button"
                  onClick={() => addEngine(en)}
                  className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80"
                >
                  <span className="flex min-w-0 items-center gap-2.5">
                    <ProductThumb
                      path={en.image_path}
                      alt={`${en.brand} ${en.model}`}
                      size={36}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {en.brand} {en.model}
                        {en.horsepower != null && ` — ${en.horsepower}HP`}
                      </span>
                      <span className="block truncate font-mono text-xs text-muted-foreground">
                        SN {en.serial_number}
                      </span>
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <Badge variant="secondary">Engine</Badge>
                    <span className="tabular-nums font-medium">
                      {formatCentavos(en.price_asking_centavos)}
                    </span>
                  </span>
                </button>
              ))}

              {matches.length + engineMatches.length === 0 && (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {q
                    ? "Nothing in your shop stock matches."
                    : "No stock delivered yet."}
                </p>
              )}
            </div>
          </div>
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
            <CardDescription>Saved as your current report.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {cart.length === 0 ? (
              <p className="rounded-md border border-dashed py-8 text-center text-sm text-muted-foreground">
                Scan or tap items on the left to add them.
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {cart.map((l) =>
                  l.kind === "part" ? (
                    <div
                      key={l.part_id}
                      className="flex items-center gap-2 rounded-md border px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{l.name}</div>
                        <div className="text-xs text-muted-foreground tabular-nums">
                          {formatCentavos(l.price_centavos)} × {l.qty} ={" "}
                          <span className="font-medium text-foreground">
                            {formatCentavos(l.price_centavos * l.qty)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label="Decrease"
                          onClick={() => setQty(l.part_id, l.qty - 1)}
                        >
                          <Minus className="size-3" />
                        </Button>
                        <span className="w-8 text-center tabular-nums text-sm">
                          {l.qty}
                        </span>
                        <Button
                          variant="outline"
                          size="icon-sm"
                          aria-label="Increase"
                          disabled={l.qty >= l.available}
                          onClick={() => setQty(l.part_id, l.qty + 1)}
                        >
                          <Plus className="size-3" />
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <EngineCartLine
                      key={l.engine_id}
                      line={l}
                      onAgreedChange={(raw) => setEngineAgreed(l.engine_id, raw)}
                      onRemove={() =>
                        setCart((c) =>
                          c.filter(
                            (x) =>
                              !(x.kind === "engine" && x.engine_id === l.engine_id)
                          )
                        )
                      }
                    />
                  )
                )}
              </div>
            )}

            {cart.length > 0 && (
              <>
                <div className="flex items-center justify-between border-t pt-3">
                  <span className="text-sm font-medium">Total</span>
                  <span className="text-lg font-bold tabular-nums">
                    {formatCentavos(total)}
                  </span>
                </div>

                {/* Payment type */}
                <div className="grid gap-2 rounded-md border p-3">
                  <Label className="text-sm">Payment</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant={paymentType === "full" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPaymentType("full")}
                    >
                      Full
                    </Button>
                    <Button
                      type="button"
                      variant={paymentType === "partial" ? "default" : "outline"}
                      size="sm"
                      onClick={() => setPaymentType("partial")}
                    >
                      Partial (downpayment)
                    </Button>
                  </div>

                  {paymentType === "full" ? (
                    <div className="grid gap-2">
                      <Label htmlFor="cash-tendered" className="text-xs">
                        Customer&apos;s cash ₱ (for change)
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          id="cash-tendered"
                          inputMode="decimal"
                          value={tendered}
                          onChange={(e) =>
                            setTendered(e.target.value.replace(/[^\d.]/g, ""))
                          }
                          placeholder="0.00"
                          className="text-base tabular-nums"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setTendered((total / 100).toFixed(2))}
                        >
                          Exact
                        </Button>
                      </div>
                      {change !== null &&
                        (change >= 0 ? (
                          <div className="flex items-center justify-between rounded-md bg-success/10 px-3 py-2">
                            <span className="text-sm font-medium text-success">
                              Change (sukli)
                            </span>
                            <span className="text-xl font-bold tabular-nums text-success">
                              {formatCentavos(change)}
                            </span>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between rounded-md bg-destructive/10 px-3 py-2">
                            <span className="text-sm font-medium text-destructive">
                              Kulang (short)
                            </span>
                            <span className="text-xl font-bold tabular-nums text-destructive">
                              {formatCentavos(-change)}
                            </span>
                          </div>
                        ))}
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      <Label htmlFor="downpayment" className="text-xs">
                        Downpayment ₱
                      </Label>
                      <Input
                        id="downpayment"
                        inputMode="decimal"
                        value={downpayment}
                        onChange={(e) =>
                          setDownpayment(e.target.value.replace(/[^\d.]/g, ""))
                        }
                        placeholder="0.00"
                        className="text-base tabular-nums"
                      />
                      <div className="flex items-center justify-between rounded-md bg-warning/10 px-3 py-2">
                        <span className="text-sm font-medium text-warning-foreground">
                          Balance due
                        </span>
                        <span className="text-xl font-bold tabular-nums">
                          {formatCentavos(balanceDue)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="grid gap-2 rounded-md bg-muted/40 p-3">
                  <Label htmlFor="cust-name">
                    Customer{" "}
                    {hasEngine
                      ? "(required for engine warranty)"
                      : paymentType === "partial"
                        ? "(required — who owes the balance)"
                        : "(optional)"}
                  </Label>
                  <Input
                    id="cust-name"
                    value={custName}
                    onChange={(e) => setCustName(e.target.value)}
                    placeholder="Customer name"
                    className="bg-background"
                  />
                  <Input
                    value={custPhone}
                    onChange={(e) => setCustPhone(e.target.value)}
                    placeholder="Phone (optional)"
                    aria-label="Customer phone"
                    className="bg-background"
                  />
                </div>

                <Button
                  onClick={onSubmit}
                  disabled={submitting || belowFloor}
                  className="self-end"
                >
                  {submitting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Send className="size-4" />
                  )}
                  Save sale
                </Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** Engine cart line: tier quick-picks + a negotiable agreed price with floor guard. */
function EngineCartLine({
  line,
  onAgreedChange,
  onRemove,
}: {
  line: CartEngine;
  onAgreedChange: (raw: string) => void;
  onRemove: () => void;
}) {
  const agreed = engineAgreed(line);
  const below = agreed < line.price_floor;
  const tiers = [
    { label: "Floor", value: line.price_floor },
    { label: "Mid", value: line.price_mid },
    { label: "Asking", value: line.price_asking },
  ];

  return (
    <div className="flex flex-col gap-2 rounded-md border px-3 py-2.5">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            <Badge variant="secondary" className="mr-1">
              Engine
            </Badge>
            {line.label}
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            SN {line.serial}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove engine"
          onClick={onRemove}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>

      {/* Tier quick-picks */}
      <div className="grid grid-cols-3 gap-1.5">
        {tiers.map((t) => (
          <button
            key={t.label}
            type="button"
            onClick={() => onAgreedChange((t.value / 100).toFixed(2))}
            className={cn(
              "rounded-md border px-2 py-1.5 text-center transition-colors hover:bg-accent",
              agreed === t.value && "border-primary bg-primary/10"
            )}
          >
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
              {t.label}
            </div>
            <div className="text-xs font-semibold tabular-nums">
              {formatCentavos(t.value)}
            </div>
          </button>
        ))}
      </div>

      {/* Agreed price */}
      <div className="grid gap-1.5">
        <Label htmlFor={`agreed-${line.engine_id}`} className="text-xs">
          Agreed price ₱
        </Label>
        <Input
          id={`agreed-${line.engine_id}`}
          inputMode="decimal"
          value={line.agreedRaw}
          onChange={(e) => onAgreedChange(e.target.value.replace(/[^\d.]/g, ""))}
          className={cn(
            "text-base tabular-nums",
            below && "border-destructive focus-visible:ring-destructive"
          )}
        />
        {below && (
          <p className="text-xs font-medium text-destructive">
            Below the floor {formatCentavos(line.price_floor)} — the owner won&apos;t
            allow this. Raise the price.
          </p>
        )}
      </div>
    </div>
  );
}
