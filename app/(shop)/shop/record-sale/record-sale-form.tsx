"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  BadgePercent,
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
  X,
} from "lucide-react";
import { toast } from "sonner";

import type { ShopEngineRow, ShopStockRow } from "@/lib/db-types";

import { cn } from "@/lib/utils";
import {
  formatCentavos,
  formatQty,
  parsePesosToCentavos,
  parseQty,
  parseQtyInput,
  sanitizeQtyInput,
} from "@/lib/format";
import { useUnits } from "@/components/unit-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProductThumb, ProductCardImage } from "@/components/product-image";
import { ViewToggle, usePersistedView } from "@/components/view-toggle";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { lookupDiscountCard, recordSale, type SukiCardInfo } from "../actions";

/**
 * A sellable line on the picker.
 *
 * `qty` is the SHELF — what a physical count would find. `available` is what is
 * genuinely still sellable: the shelf minus everything already committed to a
 * sale this shop recorded but the owner has not approved yet.
 *
 * The two differ because stock only moves on approval. Without the split, four
 * sales recorded against one 3 kg bag each looked affordable on its own and the
 * owner's whole batch then failed atomically at approval, naming only the last
 * line. The picker clamps on `available`; `committed` is shown so the cashier
 * knows WHY the number is lower than the bag in front of them.
 */
export type StockOption = ShopStockRow & {
  available: number;
  committed: number;
};

interface CartPart {
  kind: "part";
  part_id: string;
  name: string;
  unit: string;
  cost_centavos: number;
  price_centavos: number; // catalog selling price
  priceRaw: string; // pesos string — the editable per-unit price
  available: number;
  qty: number;
}
interface CartEngine {
  kind: "engine";
  engine_id: string;
  label: string;
  serial: string;
  cost_centavos: number;
  price_centavos: number; // catalog selling price
  agreedRaw: string; // pesos string — the editable per-unit price
}
type CartLine = CartPart | CartEngine;

const partPrice = (l: CartPart) => parsePesosToCentavos(l.priceRaw) ?? 0;
const engineAgreed = (l: CartEngine) => parsePesosToCentavos(l.agreedRaw) ?? 0;

/** Suki card price — mirrors the server exactly: pct off the catalog price,
    never at/below cost (capped at cost + 1). The server re-derives and clamps,
    so this is only the preview/UX. */
const sukiPrice = (catalog: number, cost: number, pct: number) =>
  Math.max(Math.round((catalog * (100 - pct)) / 100), cost + 1);

// How the customer paid — same four values as a shop expense's method.
type PaymentMethod = "cash" | "gcash" | "bank" | "other";
const PAYMENT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "gcash", label: "GCash" },
  { value: "bank", label: "Bank" },
  { value: "other", label: "Other" },
];

const AUTO_PRINT_KEY = "jm-sale-autoprint";
// The scan box is focused imperatively from several places, including the
// price rows further down the tree — an id avoids drilling a ref through them.
const SCAN_INPUT_ID = "scan-box";

/**
 * Print the 58mm receipt without leaving Record Sale: load `/receipt/[id]` into
 * an off-screen iframe and fire its own print dialog. Same origin, so the
 * receipt's route-scoped `@page { size: 58mm }` governs the job. With the
 * thermal printer set as default + kiosk printing on, it prints with no dialog.
 */
function printReceiptInPlace(id: string, onDone?: () => void) {
  document.getElementById("jm-receipt-print-frame")?.remove();
  const iframe = document.createElement("iframe");
  iframe.id = "jm-receipt-print-frame";
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;";
  iframe.src = `/receipt/${id}`;
  iframe.onload = () => {
    const win = iframe.contentWindow;
    if (!win) return;
    // printing needs focus INSIDE the frame, which steals it from the scan
    // input the caller just focused — and when the frame goes, focus lands on
    // <body>. Hand it back so the next barcode scan still lands somewhere.
    // run once: the 60s fallback below fires even on a normal print, and a
    // second onDone() would yank focus to the scan box a minute later — while
    // the cashier may be typing the NEXT sale's customer name.
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      iframe.remove();
      onDone?.();
    };
    const remove = () => setTimeout(finish, 500);
    win.addEventListener("afterprint", remove);
    win.focus();
    win.print();
    setTimeout(finish, 60_000); // fallback if afterprint never fires
  };
  document.body.appendChild(iframe);
}

export function RecordSaleForm({
  stock,
  engines,
  fitmentHints = {},
}: {
  stock: StockOption[];
  engines: ShopEngineRow[];
  /** part_id → "Yamaha Enduro E40GMHL 40HP, …" */
  fitmentHints?: Record<string, string>;
}) {
  const router = useRouter();
  const scanRef = React.useRef<HTMLInputElement>(null);
  const [scan, setScan] = React.useState("");
  const [search, setSearch] = React.useState("");
  // list ⇄ card-grid; card view shows images so staff can recognise by photo
  const [view, setView] = usePersistedView("jm-record-sale-view");
  const [cart, setCart] = React.useState<CartLine[]>([]);
  /**
   * A typed quantity was just reduced to what is on the shelf, and the cashier
   * has not seen the corrected number yet.
   *
   * Clicking Save BLURS the quantity box first, so the clamp and the save used
   * to land in one gesture: type 13465 against 2.1, press Save, get a toast
   * that reads like a refusal — and a sale recorded at 2.1 anyway. The
   * save-time `l.qty > l.available` guard could never catch it, because setQty
   * had already clamped the value legal. So the correction now costs one
   * deliberate second press.
   */
  const [qtyCorrected, setQtyCorrected] = React.useState(false);
  const [custName, setCustName] = React.useState("");
  const [custPhone, setCustPhone] = React.useState("");
  const [tendered, setTendered] = React.useState("");
  const [paymentType, setPaymentType] = React.useState<"full" | "partial">("full");
  const [paymentMethod, setPaymentMethod] =
    React.useState<PaymentMethod>("cash");
  const [downpayment, setDownpayment] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  // "Print receipt on save" — defaults ON, remembers the cashier's last choice.
  // Starts true on both server + first client render (no hydration flip); the
  // stored preference is applied in the effect below.
  const [autoPrint, setAutoPrint] = React.useState(true);
  // Suki card (0072) — once applied, every line's price drops to the card
  // price (its max); the cashier can still go LOWER, never higher.
  const [suki, setSuki] = React.useState<SukiCardInfo | null>(null);
  const [sukiInput, setSukiInput] = React.useState("");
  const [sukiBusy, setSukiBusy] = React.useState(false);

  React.useEffect(() => {
    scanRef.current?.focus({ preventScroll: true });
    try {
      const stored = localStorage.getItem(AUTO_PRINT_KEY);
      if (stored !== null) setAutoPrint(stored === "1");
    } catch {
      /* storage blocked — keep the default */
    }
  }, []);

  function setAutoPrintPersisted(next: boolean) {
    setAutoPrint(next);
    try {
      localStorage.setItem(AUTO_PRINT_KEY, next ? "1" : "0");
    } catch {
      /* storage blocked — non-fatal */
    }
  }

  // Draft survives a refresh or brief WiFi drop — restore once on mount.
  // v3: every line now carries cost + an editable per-unit price (old drafts ignored).
  const CART_KEY = "jm-sale-draft-v3";
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
  // Round PER LINE, then sum — exactly what fn_record_sale does. A fractional
  // qty makes price × qty fractional centavos (0.3 kg × ₱75.92 = 2277.6), and
  // summing unrounded then rounding once gives a different answer. That
  // difference is a receipt that disagrees with the sale it came from.
  const total = cart.reduce(
    (s, l) =>
      s + (l.kind === "part" ? Math.round(partPrice(l) * l.qty) : engineAgreed(l)),
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

  // any line priced at or below its cost? the server rejects it, so block Save.
  const belowCost = cart.some((l) =>
    l.kind === "part" ? partPrice(l) <= l.cost_centavos : engineAgreed(l) <= l.cost_centavos
  );

  // per-line suki maximum (null when no card) — the guaranteed-minimum rule
  const sukiMaxOf = (l: CartLine): number | null =>
    suki === null
      ? null
      : sukiPrice(
          l.price_centavos,
          l.cost_centavos,
          l.kind === "part" ? suki.part_pct : suki.engine_pct
        );
  // a price above the card price would silently be clamped by the server —
  // surface it instead so the cashier fixes it consciously.
  const overSuki = cart.some((l) => {
    const max = sukiMaxOf(l);
    return max !== null && (l.kind === "part" ? partPrice(l) : engineAgreed(l)) > max;
  });

  async function applySukiCard(code: string) {
    setSukiBusy(true);
    const res = await lookupDiscountCard(code);
    setSukiBusy(false);
    if (!res.ok) {
      toast.error(res.error);
      // Clear on failure too: a scanner leaves the rejected code in the box, so
      // re-scanning the card appended to it ("CARD-ACARD-B") and could only
      // fail again — the retry has to start clean.
      setSukiInput("");
      return;
    }
    const card = res.card;
    // applying a card unmounts the suki input the cashier just scanned into
    refocusScan();
    setSuki(card);
    setSukiInput("");
    // the card IS the customer (the server forces this too)
    setCustName(card.customer_name);
    setCustPhone(card.customer_phone ?? "");
    // The % comes off the price ON the line — tawad first, then the card's cut
    // on top (₱2,000 tawad − 5% = ₱1,900). Floored above cost, and never above
    // the catalog-based suki ceiling (which is also what the server enforces).
    const applyPct = (currentRaw: string, catalog: number, cost: number, pct: number) => {
      const ceiling = sukiPrice(catalog, cost, pct);
      const current = parsePesosToCentavos(currentRaw);
      const base =
        current !== null && current > 0 ? Math.min(current, catalog) : catalog;
      const discounted = Math.max(Math.round((base * (100 - pct)) / 100), cost + 1);
      return (Math.min(discounted, ceiling) / 100).toFixed(2);
    };
    setCart((c) =>
      c.map((l) =>
        l.kind === "part"
          ? {
              ...l,
              priceRaw: applyPct(l.priceRaw, l.price_centavos, l.cost_centavos, card.part_pct),
            }
          : {
              ...l,
              agreedRaw: applyPct(l.agreedRaw, l.price_centavos, l.cost_centavos, card.engine_pct),
            }
      )
    );
    toast.success(
      `Suki: ${card.customer_name} — ${card.engine_pct}% off engines, ${card.part_pct}% off parts`
    );
  }

  function clearSuki() {
    // this button unmounts itself, so focus would fall to <body> and the next
    // scan would vanish with no toast at all — worse than landing in the wrong box
    refocusScan();
    setSuki(null);
    setCustName("");
    setCustPhone("");
    // back to catalog prices
    setCart((c) =>
      c.map((l) =>
        l.kind === "part"
          ? { ...l, priceRaw: (l.price_centavos / 100).toFixed(2) }
          : { ...l, agreedRaw: (l.price_centavos / 100).toFixed(2) }
      )
    );
  }

  // how many of a part are already in the cart (0 if none)
  const cartQtyOf = (partId: string) =>
    cart.find((l): l is CartPart => l.kind === "part" && l.part_id === partId)?.qty ?? 0;

  // Which units may be sold in tenths. Read from `units` rather than joining it
  // into shop_stock: the safe views were dropped and rebuilt once already
  // (0116) and every rebuild is a chance to lose a grant or security_barrier.
  // A 7-row lookup on a table the shop can already read is the cheaper risk.
  const units = useUnits();
  const isFractional = React.useCallback(
    (unit: string) => units.some((u) => u.code === unit && u.allows_fractional),
    [units]
  );

  /** A barcode scanner types into whatever holds focus, and its trailing Enter
   *  ACTIVATES a focused <button>. So a cashier who taps a product tile and
   *  then scans the next item gets the tapped item added a second time while
   *  the scanned code is swallowed — and the toast says "added", so it reads
   *  as success. Every picker interaction therefore hands focus back here. */
  function refocusScan() {
    scanRef.current?.focus({ preventScroll: true });
  }

  /** For the typed fields a scan can land in by mistake (price, tendered,
   *  downpayment, customer). None of them submit anything on Enter, so without
   *  this the scanner's Enter does nothing, focus stays put, and the NEXT scan
   *  appends to the same box — turning a downpayment into a five-figure one. */
  const scanGuard = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      refocusScan();
    }
  };

  function addPart(p: StockOption) {
    refocusScan();
    // never let the cart exceed what's on hand — the owner would reject it anyway
    if (cartQtyOf(p.part_id) >= p.available) {
      toast.error(
        p.committed > 0
          ? `Only ${formatQty(p.available)} ${p.unit} of ${p.name} left — ${formatQty(p.committed)} is already on a sale waiting for Admin`
          : `Only ${formatQty(p.available)} ${p.unit} of ${p.name} on hand`
      );
      return;
    }
    setCart((c) => {
      const existing = c.find(
        (l): l is CartPart => l.kind === "part" && l.part_id === p.part_id
      );
      if (existing) {
        return c.map((l) =>
          l.kind === "part" && l.part_id === p.part_id
            ? { ...l, qty: Math.min(l.qty + 1, l.available) }
            : l
        );
      }
      return [
        ...c,
        {
          kind: "part",
          part_id: p.part_id,
          name: p.name,
          unit: p.unit,
          cost_centavos: p.cost_centavos,
          price_centavos: p.price_centavos,
          priceRaw: (
            (suki
              ? sukiPrice(p.price_centavos, p.cost_centavos, suki.part_pct)
              : p.price_centavos) / 100
          ).toFixed(2),
          available: p.available,
          qty: 1,
        },
      ];
    });
    toast.success(`${p.name} added`);
  }

  /** @returns false when the engine was already in the cart, so a caller can
   *  skip its own success toast. Scanning a serial twice used to show BOTH
   *  "That engine is already in the sale" and "Engine … added".
   *
   *  The duplicate check and its toast run HERE, not inside the setCart
   *  updater: an updater is queued (so a flag set inside it is still unread
   *  when this returns) and React invokes it twice in development, which
   *  double-fired the toast. */
  function addEngine(e: ShopEngineRow) {
    refocusScan();
    if (cart.some((l) => l.kind === "engine" && l.engine_id === e.engine_id)) {
      toast.info("That engine is already in the sale");
      return false;
    }
    setCart((c) => {
      if (c.some((l) => l.kind === "engine" && l.engine_id === e.engine_id)) {
        return c;
      }
      return [
        ...c,
        {
          kind: "engine",
          engine_id: e.engine_id,
          serial: e.serial_number,
          label: `${e.brand} ${e.model}${e.horsepower != null ? ` ${e.horsepower}HP` : ""}`,
          cost_centavos: e.cost_centavos,
          price_centavos: e.price_centavos,
          // default the agreed price to the catalog selling price (suki price
          // when a card is applied)
          agreedRaw: (
            (suki
              ? sukiPrice(e.price_centavos, e.cost_centavos, suki.engine_pct)
              : e.price_centavos) / 100
          ).toFixed(2),
        },
      ];
    });
    return true;
  }

  function setPartPrice(partId: string, raw: string) {
    setCart((c) =>
      c.map((l) =>
        l.kind === "part" && l.part_id === partId ? { ...l, priceRaw: raw } : l
      )
    );
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

    // Suki cards are scanned into the dedicated Suki field below — printed
    // externally now, they carry no fixed prefix, so the product scanner only
    // resolves products here.
    const part = stock.find(
      (p) => p.barcode?.toLowerCase() === code.toLowerCase()
    );
    if (part) {
      addPart(part); // shows its own toast (added, or capped at on-hand)
      return;
    }
    const engine = engines.find(
      (en) => en.serial_number.toLowerCase() === code.toLowerCase()
    );
    if (engine) {
      // only claim success when it actually went in — addEngine has already
      // explained itself if the serial was a duplicate
      if (addEngine(engine)) toast.success(`Engine ${engine.serial_number} added`);
      return;
    }
    toast.error(`No match for "${code}" in your shop stock`);
  }

  /** `keepFocus` when the change came from typing in the quantity box: that
   *  commits on blur, and stealing focus back to the scanner would fight the
   *  cashier who was tabbing to the price field. The −/+ buttons still hand
   *  focus back, because those DO park it on a button. */
  function setQty(partId: string, qty: number, keepFocus = false) {
    if (!keepFocus) refocusScan(); // see refocusScan
    if (qty <= 0) {
      setCart((c) => c.filter((l) => !(l.kind === "part" && l.part_id === partId)));
      return;
    }
    // A typed quantity over what is available is CORRECTED here, and the
    // correction has to be acknowledged before it can be saved — see
    // `qtyCorrected` in onSubmit. Computed OUTSIDE the updater on purpose: an
    // updater is queued and React runs it twice in development, so a setState
    // inside one is both late and doubled (same reason addEngine's duplicate
    // toast lives outside its updater).
    const target = cart.find(
      (l): l is CartPart => l.kind === "part" && l.part_id === partId
    );
    // Any later IN-RANGE quantity change means the cashier has seen the
    // correction and acted on it, so the gate lifts — otherwise fixing the
    // number by hand still cost a wasted Save press.
    if (target) setQtyCorrected(qty > target.available);
    setCart((c) =>
      c.map((l) =>
        l.kind === "part" && l.part_id === partId
          ? { ...l, qty: Math.min(qty, l.available) }
          : l
      )
    );
  }

  const q = search.trim().toLowerCase();
  // only sellable stock is browsable — a 0-on-hand item can't be sold
  // Filter on the SHELF, not on `available`: an item whose whole stock is
  // already committed to an unapproved sale must stay visible and say so
  // ("0 left · 4.8 awaiting Admin"). Vanishing from the picker while a full bag
  // sits on the counter is the more confusing failure.
  const inStock = stock.filter((p) => p.qty > 0);
  const matches = q
    ? inStock.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.sku ?? "").toLowerCase().includes(q) ||
          (p.barcode ?? "").toLowerCase().includes(q) ||
          (p.category ?? "").toLowerCase().includes(q)
      )
    : inStock;
  const engineMatches = q
    ? engines.filter(
        (en) =>
          en.serial_number.toLowerCase().includes(q) ||
          `${en.brand} ${en.model}`.toLowerCase().includes(q)
      )
    : engines;

  async function onSubmit() {
    // Refuse the click that CAUSED a correction. Pressing Save blurs the
    // quantity box, so the clamp fires in the same gesture; without this the
    // cashier saw "Only 2.1 kg left" and a saved sale at 2.1 they never typed.
    // Cleared here, so the very next press goes through deliberately.
    if (qtyCorrected) {
      setQtyCorrected(false);
      toast.error(
        "A quantity was reduced to what's in stock — check the sale, then Save again"
      );
      return;
    }
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
      const label = l.kind === "part" ? l.name : l.label;
      const price = l.kind === "part" ? partPrice(l) : engineAgreed(l);
      const max = sukiMaxOf(l);
      if (l.kind === "part" && l.qty > l.available) {
        toast.error(`${l.name}: only ${formatQty(l.available)} ${l.unit} on hand`);
        return;
      }
      if (l.kind === "engine" && price <= 0) {
        toast.error(`${l.label}: enter a price`);
        return;
      }
      if (price <= l.cost_centavos) {
        toast.error(
          `${label}: can't sell at or below cost ${formatCentavos(l.cost_centavos)}`
        );
        return;
      }
      // guaranteed minimum: with a card, the suki price is the ceiling
      if (max !== null && price > max) {
        toast.error(
          `${label}: the suki price ${formatCentavos(max)} is the maximum with this card`
        );
        return;
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
        .map((l) => ({
          part_id: l.part_id,
          qty: l.qty,
          unit_price_centavos: partPrice(l),
        })),
      engine_lines: cart
        .filter((l): l is CartEngine => l.kind === "engine")
        .map((l) => ({ engine_id: l.engine_id, agreed_price_centavos: engineAgreed(l) })),
      payment_type: paymentType,
      amount_paid_centavos: paymentType === "partial" ? amountPaid : null,
      payment_method: paymentMethod,
      discount_card_id: suki?.card_id ?? null,
    });
    setSubmitting(false);

    if (res.ok) {
      if (autoPrint && res.id) {
        printReceiptInPlace(res.id, () => scanRef.current?.focus({ preventScroll: true }));
        toast.success("Sale saved — printing receipt…");
      } else {
        toast.success("Sale saved — reprint the receipt from Submissions anytime");
      }
      setCart([]);
      setCustName("");
      setCustPhone("");
      setTendered("");
      setDownpayment("");
      setPaymentType("full");
      setPaymentMethod("cash");
      setSuki(null);
      setSukiInput("");
      router.refresh();
      scanRef.current?.focus({ preventScroll: true });
    } else {
      toast.error(res.error);
    }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <div className="flex flex-col gap-4 lg:col-span-3">
        {/* One panel: scan on top, browse/search list below */}
        <Card className="overflow-hidden py-0 gap-0">
          <div className="border-b bg-muted/40 px-4 py-3">
            <form onSubmit={onScan} className="flex items-center gap-2">
              <ScanLine className="size-5 shrink-0 text-muted-foreground" />
              <Input
                ref={scanRef}
                id={SCAN_INPUT_ID}
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
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  // This box has no submit action, so a scan that lands here by
                  // mistake would sit and the NEXT scan would append to it —
                  // two codes run together match nothing and the list claims
                  // "Nothing in stock matches" for items that are in stock.
                  // Enter sends focus back where a scan belongs.
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      refocusScan();
                    }
                  }}
                  placeholder="No scanner? Search or tap an item below…"
                  className="pl-8"
                  aria-label="Search shop stock"
                />
              </div>
              <ViewToggle value={view} onChange={setView} />
            </div>

            <div className="thin-scrollbar max-h-[52vh] overflow-y-auto pr-1">
              {matches.length + engineMatches.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {q
                    ? "Nothing in stock matches your search."
                    : "Nothing on hand to sell right now."}
                </p>
              ) : view === "table" ? (
                <div className="flex flex-col gap-1.5">
                  {matches.map((p) => {
                    // everything on hand is already in the cart — nothing left to add
                    // "all in cart" only when the cart is what used it up —
                    // with 0 available and an empty cart the item is blocked by
                    // an EARLIER unapproved sale, which the caption already says.
                    const inCart = cartQtyOf(p.part_id);
                    const maxed = inCart >= p.available;
                    const usedByCart = maxed && inCart > 0;
                    return (
                      <button
                        key={p.part_id}
                        type="button"
                        onClick={() => addPart(p)}
                        disabled={maxed}
                        className="flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <span className="flex min-w-0 items-center gap-2.5">
                          <ProductThumb path={p.image_path} alt={p.name} size={36} />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{p.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {formatQty(p.available)} {p.unit} left
                              {p.committed > 0 &&
                                ` · ${formatQty(p.committed)} awaiting Admin`}
                              {usedByCart && " · all in cart"}
                              {fitmentHints[p.part_id] &&
                                ` · Fits: ${fitmentHints[p.part_id]}`}
                            </span>
                          </span>
                        </span>
                        <span className="shrink-0 tabular-nums font-medium">
                          {formatCentavos(p.price_centavos)}
                        </span>
                      </button>
                    );
                  })}

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
                          {formatCentavos(en.price_centavos)}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                /* Card grid — image-first so an unfamiliar name is still recognisable */
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {matches.map((p) => {
                    // "all in cart" only when the cart is what used it up —
                    // with 0 available and an empty cart the item is blocked by
                    // an EARLIER unapproved sale, which the caption already says.
                    const inCart = cartQtyOf(p.part_id);
                    const maxed = inCart >= p.available;
                    const usedByCart = maxed && inCart > 0;
                    return (
                      <button
                        key={p.part_id}
                        type="button"
                        onClick={() => addPart(p)}
                        disabled={maxed}
                        className="group flex flex-col overflow-hidden rounded-lg border text-left transition-colors hover:border-primary/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <ProductCardImage path={p.image_path} alt={p.name} />
                        <div className="flex min-w-0 flex-col gap-0.5 p-2">
                          <span className="truncate text-xs font-medium">{p.name}</span>
                          <span className="truncate text-[11px] text-muted-foreground">
                            {formatQty(p.available)} {p.unit}
                            {usedByCart && " · in cart"}
                          </span>
                          <span className="text-xs font-semibold tabular-nums">
                            {formatCentavos(p.price_centavos)}
                          </span>
                        </div>
                      </button>
                    );
                  })}

                  {engineMatches.map((en) => (
                    <button
                      key={en.engine_id}
                      type="button"
                      onClick={() => addEngine(en)}
                      className="group relative flex flex-col overflow-hidden rounded-lg border text-left transition-colors hover:border-primary/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:bg-accent/80"
                    >
                      <Badge
                        variant="secondary"
                        className="absolute left-1.5 top-1.5 z-10 shadow-sm"
                      >
                        Engine
                      </Badge>
                      <ProductCardImage
                        path={en.image_path}
                        alt={`${en.brand} ${en.model}`}
                      />
                      <div className="flex min-w-0 flex-col gap-0.5 p-2">
                        <span className="truncate text-xs font-medium">
                          {en.brand} {en.model}
                          {en.horsepower != null && ` — ${en.horsepower}HP`}
                        </span>
                        <span className="truncate font-mono text-[11px] text-muted-foreground">
                          SN {en.serial_number}
                        </span>
                        <span className="text-xs font-semibold tabular-nums">
                          {formatCentavos(en.price_centavos)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
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
              <div className="flex flex-col gap-2 rounded-lg border border-primary/15 bg-primary/[0.05] p-2.5">
                {cart.map((l) =>
                  l.kind === "part" ? (
                    <PartCartLine
                      key={l.part_id}
                      line={l}
                      sukiMax={sukiMaxOf(l)}
                      fractional={isFractional(l.unit)}
                      onPriceChange={(raw) => setPartPrice(l.part_id, raw)}
                      onQty={(qty, keepFocus) => setQty(l.part_id, qty, keepFocus)}
                    />
                  ) : (
                    <EngineCartLine
                      key={l.engine_id}
                      line={l}
                      sukiMax={sukiMaxOf(l)}
                      onAgreedChange={(raw) => setEngineAgreed(l.engine_id, raw)}
                      onRemove={() => {
                        refocusScan(); // the row unmounts with its own button
                        setCart((c) =>
                          c.filter(
                            (x) =>
                              !(x.kind === "engine" && x.engine_id === l.engine_id)
                          )
                        );
                      }}
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

                {/* Suki card — scan/type to apply the loyalty discount */}
                {suki === null ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (sukiInput.trim()) void applySukiCard(sukiInput);
                    }}
                    className="flex items-center gap-2 rounded-md border border-dashed px-3 py-2"
                  >
                    <BadgePercent className="size-4 shrink-0 text-muted-foreground" />
                    <Input
                      value={sukiInput}
                      onChange={(e) => setSukiInput(e.target.value)}
                      placeholder="Suki card? Scan or type SC…"
                      className="h-8 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
                      aria-label="Suki card number"
                      autoComplete="off"
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      size="sm"
                      disabled={sukiBusy || !sukiInput.trim()}
                    >
                      {sukiBusy ? <Loader2 className="size-3.5 animate-spin" /> : "Apply"}
                    </Button>
                  </form>
                ) : (
                  <div className="flex items-center gap-2 rounded-md bg-success/10 px-3 py-2">
                    <BadgePercent className="size-4 shrink-0 text-success" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium text-success">
                        Suki: {suki.customer_name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {suki.engine_pct}% off engines · {suki.part_pct}% off parts —
                        taken off each line&apos;s price
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove suki card"
                      onClick={clearSuki}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                )}

                {/* Payment */}
                <div className="grid gap-2 rounded-md border p-3">
                  <Label className="text-sm">Payment</Label>

                  {/* Method — how the money was tendered */}
                  <div className="grid grid-cols-4 gap-1.5">
                    {PAYMENT_METHODS.map((m) => (
                      <Button
                        key={m.value}
                        type="button"
                        variant={paymentMethod === m.value ? "default" : "outline"}
                        size="sm"
                        onClick={() => setPaymentMethod(m.value)}
                      >
                        {m.label}
                      </Button>
                    ))}
                  </div>

                  {/* Full vs partial (how much now) */}
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
                    paymentMethod !== "cash" ? (
                      // non-cash full payment: exact amount transferred, no change
                      <div className="flex items-center justify-between rounded-md bg-success/10 px-3 py-2">
                        <span className="text-sm font-medium text-success">
                          Paid in full via{" "}
                          {PAYMENT_METHODS.find((m) => m.value === paymentMethod)?.label}
                        </span>
                        <span className="text-sm font-bold tabular-nums text-success">
                          {formatCentavos(total)}
                        </span>
                      </div>
                    ) : (
                    <div className="grid gap-2">
                      <Label htmlFor="cash-tendered" className="text-xs">
                        Customer&apos;s cash ₱ (for change)
                      </Label>
                      <div className="flex gap-2">
                        <Input
                          id="cash-tendered"
                          onKeyDown={scanGuard}
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
                    )
                  ) : (
                    <div className="grid gap-2">
                      <Label htmlFor="downpayment" className="text-xs">
                        Downpayment ₱
                      </Label>
                      <Input
                        id="downpayment"
                        onKeyDown={scanGuard}
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
                    onKeyDown={scanGuard}
                    value={custName}
                    onChange={(e) => setCustName(e.target.value)}
                    placeholder="Customer name"
                    className="bg-background"
                    disabled={suki !== null}
                  />
                  <Input
                    value={custPhone}
                    onChange={(e) => setCustPhone(e.target.value)}
                    onKeyDown={scanGuard}
                    placeholder="Phone (optional)"
                    aria-label="Customer phone"
                    className="bg-background"
                    disabled={suki !== null}
                  />
                  {suki !== null && (
                    <p className="text-xs text-muted-foreground">
                      Set by the suki card — remove the card to change.
                    </p>
                  )}
                </div>

                <label
                  htmlFor="auto-print"
                  className="flex cursor-pointer items-center gap-2 self-start text-sm text-muted-foreground select-none"
                >
                  <Checkbox
                    id="auto-print"
                    checked={autoPrint}
                    onCheckedChange={(v) => setAutoPrintPersisted(v === true)}
                  />
                  <Printer className="size-3.5" />
                  Print receipt on save
                </label>

                <Button
                  onClick={onSubmit}
                  disabled={submitting || belowCost || overSuki}
                  className="self-start"
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

/** Part cart line: qty controls + read-only cost and a negotiable per-unit price. */
function PartCartLine({
  line,
  sukiMax,
  fractional,
  onPriceChange,
  onQty,
}: {
  line: CartPart;
  sukiMax: number | null;
  /** The product's unit allows tenths (kilos, not pieces) — see units.allows_fractional. */
  fractional: boolean;
  onPriceChange: (raw: string) => void;
  onQty: (qty: number, keepFocus?: boolean) => void;
}) {
  const price = partPrice(line);
  const below = price <= line.cost_centavos;
  const step = fractional ? 0.1 : 1;

  // Typed quantity is held as text while editing so "0." and "1." are not
  // fought mid-keystroke; it commits on blur.
  const [qtyRaw, setQtyRaw] = React.useState(String(line.qty));
  React.useEffect(() => setQtyRaw(formatQty(line.qty)), [line.qty]);

  // What the box currently reads, for the AMOUNT only — so the money tracks the
  // keystrokes instead of waiting for blur. Falls back to the committed qty
  // while the value is half-typed ("1." parses, "" does not).
  const typedQty = fractional
    ? parseQty(qtyRaw, { allowFractional: true })
    : null;
  const shownQty = typedQty ?? line.qty;

  function commitQty() {
    const parsed = parseQty(qtyRaw, { allowFractional: fractional });
    if (parsed === null) {
      // NEVER silently. Restoring the previous quantity with no message is what
      // turned a rejected keystroke into a wrong stock deduction: the cashier
      // saw the amount stay put, assumed it had taken, and saved the sale.
      setQtyRaw(formatQty(line.qty));
      toast.error(
        `Enter a quantity like 0.5 or 2.3 — kept ${formatQty(line.qty)} ${line.unit}`
      );
      return;
    }
    const capped = Math.min(parsed, line.available);

    // Write the box back from the CAPPED number, always. The effect above only
    // resyncs when `line.qty` changes, so typing 3.5 against 1.1 available —
    // where the line is ALREADY 1.1 — clamped the state correctly and left the
    // box reading 3.5. The cashier then sees a quantity the sale will not store.
    setQtyRaw(formatQty(capped));
    if (capped < parsed) {
      toast.error(
        `Only ${formatQty(line.available)} ${line.unit} left to sell — set to ${formatQty(capped)}`
      );
    }
    // Hand up the RAW parsed value, not `capped`: setQty is the one clamp
    // authority, and it can only flag a correction it actually performs. Passing
    // the pre-clamped number left it blind, which is why Save went through.
    onQty(parsed, true);
  }

  // One step at a time. Reaching 0 removes the line — that is how the cashier
  // already deletes an item, and it must keep working for weighed goods too.
  // The ×10/÷10 is not decoration: 0.1 + 0.2 is 0.30000000000000004 in binary
  // floating point, and that lands in a numeric(12,1) column.
  // Capped as well as disabled at the button: belt and braces, since the same
  // handler is reachable from the keyboard.
  const bump = (by: number) =>
    onQty(Math.min(Math.round((line.qty + by) * 10) / 10, line.available));

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2.5 shadow-sm">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{line.name}</div>
          <div className="text-xs text-muted-foreground tabular-nums">
            {formatCentavos(price)} × {formatQty(shownQty)} {line.unit} ={" "}
            <span className="font-medium text-foreground">
              {/* Math.round mirrors the server's round(v_unit * qty) — the
                  cashier must never see a total the sale will not store.
                  `shownQty` tracks the box while typing; blur clamps it to
                  what is available and says so. */}
              {formatCentavos(Math.round(price * shownQty))}
            </span>
            {shownQty > line.available && (
              <span className="ml-1 font-medium text-destructive">
                (max {formatQty(line.available)})
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Decrease"
            onClick={() => bump(-step)}
          >
            <Minus className="size-3" />
          </Button>

          {fractional ? (
            // Sold by weight: the customer asks for a *tingi*, so the quantity
            // has to be typed. −/+ still work, a tenth at a time, because the
            // counter is often used one-handed.
            <Input
              inputMode="decimal"
              aria-label={`Quantity in ${line.unit}`}
              value={qtyRaw}
              // sanitizeQtyInput, not a bare character strip: this masks a
              // second decimal and a second dot as they are typed, so the box
              // can never show a value the database would refuse.
              //
              // HARD-CAPPED AT `available` AS YOU TYPE — the same pattern the
              // owner's delivery form and the shop's transfer form already use.
              // Clamping only on blur let the box display 6568 kg against 2.1
              // available, with a ₱656,800 total, until focus left.
              //
              // Keep the SANITISED STRING when in range, never
              // String(theNumber): mid-keystroke "1." parses to 1 and
              // re-stringifies to "1", erasing the decimal point as it is typed
              // so 1.5 could never be entered.
              onChange={(e) => {
                const raw = sanitizeQtyInput(e.target.value);
                if (raw === "") return setQtyRaw("");
                const n = parseQtyInput(raw);
                setQtyRaw(n > line.available ? formatQty(line.available) : raw);
              }}
              onBlur={commitQty}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitQty();
                  // Same rule as the price boxes: Enter hands focus back to the
                  // scanner, so the next scan is not typed into this field.
                  document
                    .getElementById(SCAN_INPUT_ID)
                    ?.focus({ preventScroll: true });
                }
              }}
              className="h-8 w-16 px-2 text-center text-sm tabular-nums"
            />
          ) : (
            <span className="w-8 text-center tabular-nums text-sm">{formatQty(line.qty)}</span>
          )}

          <Button
            variant="outline"
            size="icon-sm"
            aria-label="Increase"
            disabled={line.qty >= line.available}
            onClick={() => bump(step)}
          >
            <Plus className="size-3" />
          </Button>
        </div>
      </div>

      <PriceRow
        id={`part-price-${line.part_id}`}
        cost_centavos={line.cost_centavos}
        priceRaw={line.priceRaw}
        below={below}
        sukiMax={sukiMax}
        onPriceChange={onPriceChange}
      />
    </div>
  );
}

/** Engine cart line: read-only cost and a negotiable per-unit price. */
function EngineCartLine({
  line,
  sukiMax,
  onAgreedChange,
  onRemove,
}: {
  line: CartEngine;
  sukiMax: number | null;
  onAgreedChange: (raw: string) => void;
  onRemove: () => void;
}) {
  const agreed = engineAgreed(line);
  const below = agreed <= line.cost_centavos;

  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2.5 shadow-sm">
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

      <PriceRow
        id={`engine-price-${line.engine_id}`}
        cost_centavos={line.cost_centavos}
        priceRaw={line.agreedRaw}
        below={below}
        sukiMax={sukiMax}
        onPriceChange={onAgreedChange}
      />
    </div>
  );
}

/** Read-only cost + editable per-unit price, floored strictly above cost.
    With a suki card, the card price is also the CEILING (lower ok, higher not). */
function PriceRow({
  id,
  cost_centavos,
  priceRaw,
  below,
  sukiMax,
  onPriceChange,
}: {
  id: string;
  cost_centavos: number;
  priceRaw: string;
  below: boolean;
  sukiMax: number | null;
  onPriceChange: (raw: string) => void;
}) {
  const price = parsePesosToCentavos(priceRaw) ?? 0;
  const overSuki = sukiMax !== null && price > sukiMax;
  return (
    <div className="grid grid-cols-2 gap-2">
      <div className="grid gap-1.5">
        <Label className="text-xs text-muted-foreground">Cost ₱</Label>
        <div className="flex h-9 items-center rounded-md border border-dashed bg-muted/40 px-3 text-sm tabular-nums text-muted-foreground">
          {formatCentavos(cost_centavos)}
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={id} className="text-xs">
          Price ₱
          {sukiMax !== null && (
            <span className="ml-1 font-normal text-muted-foreground">
              (suki max {formatCentavos(sukiMax)})
            </span>
          )}
        </Label>
        <Input
          id={id}
          inputMode="decimal"
          value={priceRaw}
          // A scanner's trailing Enter would otherwise submit nothing and leave
          // focus here, so the NEXT scan appends its digits to the price too.
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              document.getElementById(SCAN_INPUT_ID)?.focus({ preventScroll: true });
            }
          }}
          onChange={(e) => onPriceChange(e.target.value.replace(/[^\d.]/g, ""))}
          className={cn(
            "text-base tabular-nums",
            (below || overSuki) && "border-destructive focus-visible:ring-destructive"
          )}
        />
      </div>
      {below && (
        <p className="col-span-2 text-xs font-medium text-destructive">
          Can&apos;t sell at or below cost {formatCentavos(cost_centavos)}
        </p>
      )}
      {!below && overSuki && (
        <p className="col-span-2 text-xs font-medium text-destructive">
          Above the suki price — {formatCentavos(sukiMax)} is the maximum with
          this card
        </p>
      )}
    </div>
  );
}
