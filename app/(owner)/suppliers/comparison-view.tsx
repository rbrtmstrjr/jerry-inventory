"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, Plus, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";

import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/date-picker";
import { recordSupplierQuote, setPreferredSupplier } from "./actions";
import type { ComparisonRow } from "./types";

const phShort = (iso: string) =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-PH", {
    timeZone: "UTC", month: "short", day: "numeric",
  });

/**
 * PROVENANCE IS MANDATORY — never a bare number. "₱165 vs ₱180" is a lie when
 * one is an 8-month-old paid price and the other a fresh quote; every price
 * this view renders says what it is and when it's from.
 */
function provenance(r: ComparisonRow): string {
  switch (r.effective_source) {
    case "paid":
      return `Paid ${formatCentavos(r.effective_centavos)} · ${phShort(r.effective_as_of)}`;
    case "quote":
      return `Quoted ${formatCentavos(r.effective_centavos)} · ${phShort(r.effective_as_of)}`;
    case "stale_quote":
      return `Quoted ${formatCentavos(r.effective_centavos)} · ${phShort(r.effective_as_of)} (stale)`;
  }
}

interface ProductGroup {
  key: string;
  kind: "part" | "engine_model";
  part_id: string | null;
  engine_model_id: string | null;
  name: string;
  sku: string | null;
  category: string | null;
  rows: ComparisonRow[];
  cheapest: ComparisonRow;
  preferredName: string | null;
  preferredEffective: number | null;
  /** preferred − cheapest; > 0 means the preferred supplier is dearer. */
  preferredDelta: number | null;
  hasQuotes: boolean;
  hasStale: boolean;
}

export function ComparisonView({
  rows, suppliers, parts, engineModels, categories, today,
}: {
  rows: ComparisonRow[];
  suppliers: { id: string; name: string }[];
  parts: { id: string; name: string; sku: string | null }[];
  engineModels: { id: string; name: string }[];
  categories: string[];
  today: string;
}) {
  const [q, setQ] = React.useState("");
  const [category, setCategory] = React.useState("all");
  const [kind, setKind] = React.useState("all");
  const [onlyDearPreferred, setOnlyDearPreferred] = React.useState(false);
  const [onlyQuoted, setOnlyQuoted] = React.useState(false);
  const [onlyStale, setOnlyStale] = React.useState(false);
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [dialog, setDialog] = React.useState<{
    kind: "part" | "engine_model";
    productId: string;
    productName: string;
    supplierId?: string;
  } | null>(null);

  const groups = React.useMemo(() => {
    const byProduct = new Map<string, ComparisonRow[]>();
    for (const r of rows) {
      const key = r.part_id ?? r.engine_model_id!;
      byProduct.set(key, [...(byProduct.get(key) ?? []), r]);
    }
    const out: ProductGroup[] = [];
    for (const [key, rs] of byProduct) {
      const first = rs[0];
      const cheapest = rs.find((r) => r.is_cheapest) ?? rs[0];
      const preferredRow = rs.find((r) => r.is_preferred) ?? null;
      const preferredEffective = first.preferred_effective_centavos;
      out.push({
        key,
        kind: first.kind,
        part_id: first.part_id,
        engine_model_id: first.engine_model_id,
        name: first.product_name,
        sku: first.sku,
        category: first.category_name,
        rows: [...rs].sort((a, b) => a.effective_centavos - b.effective_centavos),
        cheapest,
        preferredName: preferredRow?.supplier_name ?? null,
        preferredEffective,
        preferredDelta:
          preferredEffective !== null ? preferredEffective - cheapest.effective_centavos : null,
        hasQuotes: rs.some((r) => r.quote_id !== null),
        hasStale: rs.some((r) => r.quote_stale),
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = groups.filter((g) => {
    if (q && !`${g.name} ${g.sku ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (category !== "all" && g.category !== category) return false;
    if (kind !== "all" && g.kind !== kind) return false;
    if (onlyDearPreferred && !(g.preferredDelta !== null && g.preferredDelta > 0)) return false;
    if (onlyQuoted && !g.hasQuotes) return false;
    if (onlyStale && !g.hasStale) return false;
    return true;
  });

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-x-6 gap-y-3 pt-6">
          <div className="grid gap-1">
            <Label htmlFor="cmp-q" className="text-xs">Search</Label>
            <Input
              id="cmp-q" value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Product or SKU…" className="w-52"
            />
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Category</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {categories.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label className="text-xs">Type</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                <SelectItem value="part">Parts</SelectItem>
                <SelectItem value="engine_model">Engines</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyDearPreferred} onCheckedChange={(v) => setOnlyDearPreferred(!!v)} />
            Preferred isn&apos;t cheapest
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyQuoted} onCheckedChange={(v) => setOnlyQuoted(!!v)} />
            Has quotes
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={onlyStale} onCheckedChange={(v) => setOnlyStale(!!v)} />
            Stale only
          </label>
          <div className="ml-auto">
            <Button
              size="sm"
              onClick={() =>
                setDialog({ kind: "part", productId: "", productName: "" })
              }
            >
              <Plus className="size-4" /> Record quote
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                  <th className="w-8 py-2" />
                  <th className="py-2 font-medium">Product</th>
                  <th className="py-2 font-medium">Best price</th>
                  <th className="py-2 font-medium">Preferred supplier</th>
                  <th className="py-2 text-right font-medium">Suppliers</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={5} className="py-10 text-center text-muted-foreground">
                      {rows.length === 0
                        ? "No price data yet — it builds itself from receivings; add quotes for the rest."
                        : "Nothing matches these filters."}
                    </td>
                  </tr>
                )}
                {filtered.map((g) => (
                  <React.Fragment key={g.key}>
                    <tr
                      className="cursor-pointer border-b hover:bg-muted/40"
                      onClick={() => toggle(g.key)}
                    >
                      <td className="py-2.5 text-muted-foreground">
                        {open.has(g.key)
                          ? <ChevronDown className="size-4" />
                          : <ChevronRight className="size-4" />}
                      </td>
                      <td className="py-2.5">
                        {g.name}
                        {g.kind === "engine_model" && (
                          <span className="ml-1 text-xs text-muted-foreground">(engine)</span>
                        )}
                        {g.sku && (
                          <span className="ml-2 font-mono text-xs text-muted-foreground">{g.sku}</span>
                        )}
                        {g.category && (
                          <span className="ml-2 text-xs text-muted-foreground">{g.category}</span>
                        )}
                      </td>
                      <td className="py-2.5">
                        <span className="font-medium tabular-nums">
                          {formatCentavos(g.cheapest.effective_centavos)}
                        </span>
                        <span className="ml-1.5 text-xs text-muted-foreground">
                          {g.cheapest.supplier_name} · {provenance(g.cheapest)}
                        </span>
                      </td>
                      <td className="py-2.5">
                        {g.preferredName === null ? (
                          <span className="text-xs text-muted-foreground">
                            {g.rows[0].preferred_supplier_id ? "no price yet" : "none set"}
                          </span>
                        ) : (
                          <>
                            {g.preferredName}
                            {g.preferredEffective !== null && (
                              <span className="ml-1.5 text-xs tabular-nums text-muted-foreground">
                                {formatCentavos(g.preferredEffective)}
                              </span>
                            )}
                            {/* The insight this tab exists for. */}
                            {g.preferredDelta !== null && g.preferredDelta > 0 && (
                              <Badge variant="destructive" className="ml-2 gap-1">
                                <TriangleAlert className="size-3" />
                                Preferred is {formatCentavos(g.preferredDelta)} more
                              </Badge>
                            )}
                          </>
                        )}
                      </td>
                      <td className="py-2.5 text-right tabular-nums">{g.rows.length}</td>
                    </tr>

                    {open.has(g.key) && (
                      <tr className="border-b bg-muted/20">
                        <td />
                        <td colSpan={4} className="py-3 pr-2">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-xs uppercase text-muted-foreground">
                                <th className="py-1 font-medium">Supplier</th>
                                <th className="py-1 font-medium">Last paid</th>
                                <th className="py-1 font-medium">Latest quote</th>
                                <th className="py-1 font-medium">Compare price</th>
                                <th className="py-1" />
                              </tr>
                            </thead>
                            <tbody>
                              {g.rows.map((r) => (
                                <tr key={r.supplier_id} className="border-t border-border/50">
                                  <td className="py-2">
                                    {r.supplier_name}
                                    {r.is_preferred && (
                                      <Badge variant="secondary" className="ml-2">Preferred</Badge>
                                    )}
                                    {r.is_cheapest && (
                                      <Badge className="ml-2">Cheapest</Badge>
                                    )}
                                  </td>
                                  <td className="py-2 text-xs">
                                    {r.last_paid_centavos !== null ? (
                                      <Link
                                        href="/master-inventory/receiving"
                                        className="underline-offset-4 hover:underline"
                                      >
                                        Paid {formatCentavos(r.last_paid_centavos)} ·{" "}
                                        {phShort(r.last_paid_at!)}
                                      </Link>
                                    ) : (
                                      <span className="text-muted-foreground">never bought</span>
                                    )}
                                  </td>
                                  <td className="py-2 text-xs">
                                    {r.quote_id !== null ? (
                                      <>
                                        Quoted {formatCentavos(r.quote_centavos!)} ·{" "}
                                        {phShort(r.quoted_at!)}
                                        {r.valid_until && ` (until ${phShort(r.valid_until)})`}
                                        {r.quote_stale && (
                                          <Badge variant="outline" className="ml-1.5">stale</Badge>
                                        )}
                                      </>
                                    ) : (
                                      <span className="text-muted-foreground">no quote</span>
                                    )}
                                  </td>
                                  <td className="py-2 text-xs font-medium">{provenance(r)}</td>
                                  <td className="py-2 text-right whitespace-nowrap">
                                    {!r.is_preferred && (
                                      <Button
                                        variant="ghost" size="sm"
                                        onClick={async () => {
                                          const res = await setPreferredSupplier({
                                            kind: g.kind,
                                            product_id: g.key,
                                            supplier_id: r.supplier_id,
                                          });
                                          if (res.ok) toast.success(`${r.supplier_name} is now preferred for ${g.name}`);
                                          else toast.error(res.error);
                                        }}
                                      >
                                        Make preferred
                                      </Button>
                                    )}
                                    <Button
                                      variant="ghost" size="sm"
                                      onClick={() =>
                                        setDialog({
                                          kind: g.kind,
                                          productId: g.key,
                                          productName: g.name,
                                          supplierId: r.supplier_id,
                                        })
                                      }
                                    >
                                      <Plus className="size-3.5" /> Quote
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                              <tr className="border-t border-border/50">
                                <td colSpan={5} className="py-2">
                                  <Button
                                    variant="outline" size="sm"
                                    onClick={() =>
                                      setDialog({
                                        kind: g.kind,
                                        productId: g.key,
                                        productName: g.name,
                                      })
                                    }
                                  >
                                    <Plus className="size-3.5" /> Quote another supplier
                                  </Button>
                                </td>
                              </tr>
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Paid prices come from receivings automatically. Quotes are claims you
            record; a quote past its valid-until date or older than the staleness
            window (Settings → Alerts) is flagged and stops being the compare
            price — it falls back to what was last actually paid.
          </p>
        </CardContent>
      </Card>

      {dialog && (
        <QuoteDialog
          fixed={dialog}
          suppliers={suppliers}
          parts={parts}
          engineModels={engineModels}
          today={today}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

/** Mounted per open, so it seeds from props with no reset effect. */
function QuoteDialog({
  fixed, suppliers, parts, engineModels, today, onClose,
}: {
  fixed: { kind: "part" | "engine_model"; productId: string; productName: string; supplierId?: string };
  suppliers: { id: string; name: string }[];
  parts: { id: string; name: string; sku: string | null }[];
  engineModels: { id: string; name: string }[];
  today: string;
  onClose: () => void;
}) {
  const [kind, setKind] = React.useState(fixed.kind);
  const [productId, setProductId] = React.useState(fixed.productId);
  const [supplierId, setSupplierId] = React.useState(fixed.supplierId ?? "");
  const [pesos, setPesos] = React.useState("");
  const [quotedAt, setQuotedAt] = React.useState(today);
  const [validUntil, setValidUntil] = React.useState("");
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const productFixed = !!fixed.productId;

  async function onSave() {
    const centavos = parsePesosToCentavos(pesos);
    if (centavos === null || centavos <= 0) {
      toast.error("Enter a price in pesos, e.g. 1,250.50");
      return;
    }
    if (!productId) { toast.error("Pick a product"); return; }
    if (!supplierId) { toast.error("Pick a supplier"); return; }

    setBusy(true);
    const res = await recordSupplierQuote({
      supplier_id: supplierId,
      part_id: kind === "part" ? productId : null,
      engine_model_id: kind === "engine_model" ? productId : null,
      unit_cost_centavos: centavos,
      quoted_at: quotedAt,
      valid_until: validUntil || null,
      note: note || null,
    });
    setBusy(false);
    if (res.ok) {
      toast.success("Quote recorded");
      onClose();
    } else toast.error(res.error);
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Record quote{fixed.productName ? ` — ${fixed.productName}` : ""}
          </DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          {!productFixed && (
            <>
              <div className="grid gap-1">
                <Label className="text-xs">Type</Label>
                <Select value={kind} onValueChange={(v) => { setKind(v as typeof kind); setProductId(""); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="part">Part</SelectItem>
                    <SelectItem value="engine_model">Engine model</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1">
                <Label className="text-xs">Product</Label>
                <Select value={productId} onValueChange={setProductId}>
                  <SelectTrigger><SelectValue placeholder="Pick a product" /></SelectTrigger>
                  <SelectContent>
                    {(kind === "part" ? parts : engineModels).map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {"name" in p ? p.name : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="grid gap-1">
            <Label className="text-xs">Supplier</Label>
            <Select value={supplierId} onValueChange={setSupplierId} disabled={!!fixed.supplierId}>
              <SelectTrigger><SelectValue placeholder="Pick a supplier" /></SelectTrigger>
              <SelectContent>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="q-price" className="text-xs">Quoted unit price (₱)</Label>
            <Input
              id="q-price" inputMode="decimal" value={pesos}
              onChange={(e) => setPesos(e.target.value)} placeholder="e.g. 1,250.50"
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor="q-date" className="text-xs">Quoted on</Label>
              <DatePicker id="q-date" value={quotedAt} onChange={setQuotedAt} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="q-until" className="text-xs">Valid until (optional)</Label>
              <DatePicker id="q-until" value={validUntil} onChange={setValidUntil} />
            </div>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="q-note" className="text-xs">Note (optional)</Label>
            <Input
              id="q-note" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. min. order 10 pcs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={onSave} disabled={busy}>Save quote</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
