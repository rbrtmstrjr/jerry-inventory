"use client";

import * as React from "react";
import { Plus, TriangleAlert } from "lucide-react";
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
import { MergeDuplicatesDialog, type MergePart } from "../master-inventory/merge-dialog";
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
  /** Suppliers sorted cheapest-first. */
  rows: ComparisonRow[];
  cheapest: ComparisonRow;
  /** Second-cheapest supplier's effective price − cheapest; the switch is worth this. */
  cheapestSaving: number;
  secondName: string | null;
  preferredName: string | null;
  preferredEffective: number | null;
  /** preferred − cheapest; > 0 means the preferred supplier is dearer. */
  preferredDelta: number | null;
  hasQuotes: boolean;
  hasStale: boolean;
  /** Distinct suppliers for this product (0052 folds merged duplicates first). */
  supplierCount: number;
}

/** Normalise for duplicate detection: trim + case-fold. */
const norm = (s: string | null) => (s ?? "").trim().toLowerCase();

export function ComparisonView({
  rows, suppliers, parts, engineModels, categories, today,
}: {
  rows: ComparisonRow[];
  suppliers: { id: string; name: string }[];
  parts: MergePart[];
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
  const [showAll, setShowAll] = React.useState(false);
  const [dialog, setDialog] = React.useState<{
    kind: "part" | "engine_model";
    productId: string;
    productName: string;
    supplierId?: string;
  } | null>(null);
  const [mergeOpen, setMergeOpen] = React.useState(false);
  const [mergePrefill, setMergePrefill] =
    React.useState<{ targetId: string; sourceIds: string[] } | null>(null);

  const groups = React.useMemo(() => {
    const byProduct = new Map<string, ComparisonRow[]>();
    for (const r of rows) {
      const key = r.part_id ?? r.engine_model_id!;
      byProduct.set(key, [...(byProduct.get(key) ?? []), r]);
    }
    const out: ProductGroup[] = [];
    for (const [key, rs] of byProduct) {
      const first = rs[0];
      const sorted = [...rs].sort((a, b) => a.effective_centavos - b.effective_centavos);
      const cheapest = rs.find((r) => r.is_cheapest) ?? sorted[0];
      const second = sorted.find((r) => r.supplier_id !== cheapest.supplier_id) ?? null;
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
        rows: sorted,
        cheapest,
        cheapestSaving: second ? second.effective_centavos - cheapest.effective_centavos : 0,
        secondName: second?.supplier_name ?? null,
        preferredName: preferredRow?.supplier_name ?? null,
        preferredEffective,
        preferredDelta:
          preferredEffective !== null ? preferredEffective - cheapest.effective_centavos : null,
        hasQuotes: rs.some((r) => r.quote_id !== null),
        hasStale: rs.some((r) => r.quote_stale),
        supplierCount: first.supplier_count,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const matched = groups.filter((g) => {
    if (q && !`${g.name} ${g.sku ?? ""}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (category !== "all" && g.category !== category) return false;
    if (kind !== "all" && g.kind !== kind) return false;
    if (onlyDearPreferred && !(g.preferredDelta !== null && g.preferredDelta > 0)) return false;
    if (onlyQuoted && !g.hasQuotes) return false;
    if (onlyStale && !g.hasStale) return false;
    return true;
  });
  // Comparable-only by default: a single paid supplier + a quote from a
  // different one is 2, which is exactly the point.
  const filtered = matched.filter((g) => showAll || g.supplierCount >= 2);

  // Duplicate nudge: among VISIBLE distinct parts, cluster those sharing a
  // normalised SKU OR an exact (case-insensitive) name via union-find. Engines
  // can't be merged, so parts only. Maps each part_id → its cluster (size ≥ 2).
  const dupClusters = React.useMemo(() => {
    const partGroups = filtered.filter((g) => g.kind === "part" && g.part_id);
    const parent: Record<string, string> = {};
    for (const g of partGroups) parent[g.part_id!] = g.part_id!;
    const find = (x: string): string => {
      let r = x;
      while (parent[r] !== r) r = parent[r];
      while (parent[x] !== r) { const n = parent[x]; parent[x] = r; x = n; }
      return r;
    };
    const union = (a: string, b: string) => { parent[find(a)] = find(b); };
    const link = (buckets: Map<string, string[]>) => {
      for (const ids of buckets.values())
        for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]);
    };
    const bySku = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    for (const g of partGroups) {
      const sku = norm(g.sku);
      if (sku) bySku.set(sku, [...(bySku.get(sku) ?? []), g.part_id!]);
      const name = norm(g.name);
      byName.set(name, [...(byName.get(name) ?? []), g.part_id!]);
    }
    link(bySku);
    link(byName);
    const comps = new Map<string, string[]>();
    for (const g of partGroups) {
      const root = find(g.part_id!);
      comps.set(root, [...(comps.get(root) ?? []), g.part_id!]);
    }
    const map = new Map<string, string[]>();
    for (const ids of comps.values())
      if (ids.length >= 2) for (const id of ids) map.set(id, ids);
    return map;
  }, [filtered]);

  const openMerge = (cluster: string[]) => {
    setMergePrefill({ targetId: cluster[0], sourceIds: cluster.slice(1) });
    setMergeOpen(true);
  };

  const emptyMsg =
    rows.length === 0
      ? "No price data yet — it builds itself from receivings; add quotes for the rest."
      : !showAll && matched.length > 0
        ? "No products with 2+ suppliers yet — record a quote or receive from another supplier, or Show all."
        : "Nothing matches these filters.";

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
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={showAll} onCheckedChange={(v) => setShowAll(!!v)} />
            Show all (incl. single-supplier)
          </label>
          <div className="ml-auto">
            <Button
              size="sm"
              onClick={() => setDialog({ kind: "part", productId: "", productName: "" })}
            >
              <Plus className="size-4" /> Record quote
            </Button>
          </div>
        </CardContent>
      </Card>

      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {emptyMsg}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((g) => {
            const cluster = g.part_id ? dupClusters.get(g.part_id) : undefined;
            return (
              <Card key={g.key}>
                <CardContent className="flex flex-col gap-3 pt-6">
                  {/* header */}
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{g.name}</span>
                        {g.kind === "engine_model" && (
                          <span className="text-xs text-muted-foreground">(engine)</span>
                        )}
                        {g.sku && (
                          <span className="font-mono text-xs text-muted-foreground">{g.sku}</span>
                        )}
                        {g.category && (
                          <span className="text-xs text-muted-foreground">{g.category}</span>
                        )}
                        {cluster && (
                          <button
                            type="button"
                            onClick={() => openMerge(cluster)}
                            className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs font-medium text-amber-700 hover:bg-amber-500/20 dark:text-amber-500"
                          >
                            <TriangleAlert className="size-3" /> Possible duplicate — Merge
                          </button>
                        )}
                      </div>
                      {g.cheapestSaving > 0 && g.secondName && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Cheapest saves {formatCentavos(g.cheapestSaving)} vs {g.secondName}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {/* The insight this tab exists for. */}
                      {g.preferredDelta !== null && g.preferredDelta > 0 && (
                        <Badge variant="destructive" className="gap-1">
                          <TriangleAlert className="size-3" />
                          Preferred is {formatCentavos(g.preferredDelta)} more
                        </Badge>
                      )}
                      <Button
                        variant="outline" size="sm"
                        onClick={() =>
                          setDialog({ kind: g.kind, productId: g.key, productName: g.name })
                        }
                      >
                        <Plus className="size-3.5" /> Quote
                      </Button>
                    </div>
                  </div>

                  {/* suppliers — always visible, side by side, cheapest first */}
                  <div className="flex flex-col divide-y">
                    {g.rows.map((r) => {
                      const delta = r.effective_centavos - g.cheapest.effective_centavos;
                      return (
                        <div
                          key={r.supplier_id}
                          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="truncate">{r.supplier_name}</span>
                              {r.is_cheapest && <Badge>Cheapest</Badge>}
                              {r.is_preferred && <Badge variant="secondary">Preferred</Badge>}
                            </div>
                            {/* provenance — never a bare number */}
                            <p className="text-xs text-muted-foreground">{provenance(r)}</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <div className="text-right">
                              <div className="font-medium tabular-nums">
                                {formatCentavos(r.effective_centavos)}
                              </div>
                              {delta > 0 && (
                                <div className="text-xs tabular-nums text-muted-foreground">
                                  +{formatCentavos(delta)}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-1 whitespace-nowrap">
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
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Paid prices come from receivings automatically. Quotes are claims you
        record; a quote past its valid-until date or older than the staleness
        window (Settings → Alerts) is flagged and stops being the compare
        price — it falls back to what was last actually paid.
      </p>

      <MergeDuplicatesDialog
        open={mergeOpen}
        parts={parts}
        prefill={mergePrefill}
        onClose={() => setMergeOpen(false)}
      />

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
