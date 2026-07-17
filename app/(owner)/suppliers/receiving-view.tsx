"use client";

import * as React from "react";
import Link from "next/link";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Copy,
  Eye,
  Loader2,
  Plus,
  Printer,
  Rows3,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import type { Category, EngineModel } from "@/lib/db-types";
import type { ReceivingRow } from "@/lib/db-types";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { ph_today } from "@/lib/ph-date";
import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { DatePicker } from "@/components/date-picker";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";
import { DataTable } from "@/components/data-table/data-table";
import { checkSupplierLimit, receiveStock } from "./actions";

export interface SupplierOption {
  id: string;
  name: string;
  credit_limit: number | null;
  payment_terms_days: number | null;
  terms_note: string | null;
}

/** One row of supplier_product_prices_history — last price PAID per supplier × product. */
export interface PriceHistoryRow {
  supplier_id: string;
  supplier_name: string;
  part_id: string | null;
  engine_model_id: string | null;
  unit_cost_centavos: number;
  received_at: string;
}

/** Shape returned by fn_supplier_limit_check. */
interface LimitCheck {
  supplier_id: string;
  credit_limit: number | null;
  outstanding: number;
  projected: number;
  warn_pct: number;
  would_exceed: boolean;
  near_limit: boolean;
  utilization_pct: number | null;
}

interface PartOption {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
  cost_centavos: number;
}

/** A product born on this receiving — sent to the RPC as `new_part`. */
interface NewPartDraft {
  name: string;
  category_id: string | null;
  sku: string;
  barcode: string;
  generate_barcode: boolean;
  unit: string;
  price: string; // selling ₱
  reorder_level: string;
}

interface NewModelDraft {
  brand: string;
  model: string;
  horsepower: string;
  stroke: "" | "2-stroke" | "4-stroke";
  default_warranty_months: string;
}

interface PartLine {
  part_id: string;
  new_part: NewPartDraft | null;
  qty: string;
  unit_cost: string; // pesos
}

interface EngineLine {
  serial_number: string;
  engine_model_id: string;
  new_model: NewModelDraft | null;
  condition: "brand_new" | "second_hand";
  cost: string;
  price: string;
  warranty_months: string;
}

const emptyPartLine = (): PartLine => ({
  part_id: "",
  new_part: null,
  qty: "1",
  unit_cost: "",
});

const emptyNewPart = (): NewPartDraft => ({
  name: "",
  category_id: null,
  sku: "",
  barcode: "",
  generate_barcode: false,
  unit: "pc",
  price: "",
  reorder_level: "0",
});

function addMonths(months: number): string {
  const d = new Date(`${ph_today()}T00:00:00`);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function PartCombobox({
  parts,
  value,
  onChange,
  onCreateNew,
}: {
  parts: PartOption[];
  value: string;
  onChange: (id: string) => void;
  onCreateNew: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const selected = parts.find((p) => p.id === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {selected ? selected.name : "Pick item…"}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search name, SKU, or scan barcode…" />
          <CommandList>
            <CommandEmpty>
              <div className="flex flex-col items-center gap-2 py-1">
                <span>No item found.</span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setOpen(false);
                    onCreateNew();
                  }}
                >
                  <Sparkles className="size-4" /> Create it as a new product
                </Button>
              </div>
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__new__"
                onSelect={() => {
                  setOpen(false);
                  onCreateNew();
                }}
                className="font-medium"
              >
                <Sparkles className="size-4" /> New product…
              </CommandItem>
              {parts.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${p.sku ?? ""} ${p.barcode ?? ""}`}
                  onSelect={() => {
                    onChange(p.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "size-4",
                      p.id === value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <div className="flex-1">
                    <div className="text-sm">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.sku ?? p.barcode ?? ""}
                    </div>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/** Minimal in-place product form — creating a product must never mean leaving
 *  the receiving. Cost comes from the line; supplier link from the receiving. */
function NewProductDialog({
  open,
  draft,
  categories,
  supplierName,
  onSave,
  onClose,
}: {
  open: boolean;
  draft: NewPartDraft;
  categories: Category[];
  supplierName: string | null;
  onSave: (d: NewPartDraft) => void;
  onClose: () => void;
}) {
  const [d, setD] = React.useState<NewPartDraft>(draft);
  React.useEffect(() => {
    if (open) setD(draft);
  }, [open, draft]);
  const set = (patch: Partial<NewPartDraft>) => setD((x) => ({ ...x, ...patch }));

  function save() {
    if (!d.name.trim()) {
      toast.error("The new product needs a name");
      return;
    }
    if (parsePesosToCentavos(d.price || "") === null) {
      toast.error("Enter a selling price (₱)");
      return;
    }
    onSave({ ...d, name: d.name.trim() });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New product</DialogTitle>
          <DialogDescription>
            Created together with this receiving — its first cost is this
            line&apos;s unit cost{supplierName ? `, and ${supplierName} becomes its preferred supplier` : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="np-name">Name *</Label>
            <Input
              id="np-name"
              value={d.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="e.g. Fuel Filter 8mm"
              autoFocus
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Category</Label>
              <Select
                value={d.category_id ?? ""}
                onValueChange={(v) => set({ category_id: v || null })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-unit">Unit</Label>
              <Input
                id="np-unit"
                value={d.unit}
                onChange={(e) => set({ unit: e.target.value })}
                placeholder="pc"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="np-sku">SKU</Label>
              <Input
                id="np-sku"
                value={d.sku}
                onChange={(e) => set({ sku: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-barcode">Barcode</Label>
              <Input
                id="np-barcode"
                value={d.barcode}
                onChange={(e) => set({ barcode: e.target.value })}
                placeholder={d.generate_barcode ? "will be generated" : "scan…"}
                disabled={d.generate_barcode}
              />
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <Checkbox
                  checked={d.generate_barcode}
                  onCheckedChange={(v) =>
                    set({ generate_barcode: v === true, barcode: "" })
                  }
                />
                Generate a JM barcode (unbranded goods)
              </label>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="np-price">Selling price ₱ *</Label>
              <Input
                id="np-price"
                inputMode="decimal"
                value={d.price}
                onChange={(e) => set({ price: e.target.value })}
                placeholder="0.00"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="np-reorder">Reorder level</Label>
              <Input
                id="np-reorder"
                inputMode="numeric"
                value={d.reorder_level}
                onChange={(e) => set({ reorder_level: e.target.value })}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save}>
            Add to receiving
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewModelDialog({
  open,
  supplierName,
  onSave,
  onClose,
}: {
  open: boolean;
  supplierName: string | null;
  onSave: (d: NewModelDraft) => void;
  onClose: () => void;
}) {
  const empty: NewModelDraft = {
    brand: "",
    model: "",
    horsepower: "",
    stroke: "",
    default_warranty_months: "12",
  };
  const [d, setD] = React.useState<NewModelDraft>(empty);
  React.useEffect(() => {
    if (open) setD(empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (patch: Partial<NewModelDraft>) => setD((x) => ({ ...x, ...patch }));

  function save() {
    if (!d.brand.trim() || !d.model.trim()) {
      toast.error("Brand and model are required");
      return;
    }
    onSave({ ...d, brand: d.brand.trim(), model: d.model.trim() });
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New engine model</DialogTitle>
          <DialogDescription>
            Created together with this receiving
            {supplierName ? ` — ${supplierName} becomes its preferred supplier` : ""}.
            An existing brand + model is reused, never duplicated.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="nm-brand">Brand *</Label>
              <Input
                id="nm-brand"
                value={d.brand}
                onChange={(e) => set({ brand: e.target.value })}
                placeholder="Yamaha"
                autoFocus
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="nm-model">Model *</Label>
              <Input
                id="nm-model"
                value={d.model}
                onChange={(e) => set({ model: e.target.value })}
                placeholder="Enduro E40GMHL"
              />
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="nm-hp">HP</Label>
              <Input
                id="nm-hp"
                inputMode="decimal"
                value={d.horsepower}
                onChange={(e) => set({ horsepower: e.target.value })}
              />
            </div>
            <div className="grid gap-2">
              <Label>Stroke</Label>
              <Select
                value={d.stroke}
                onValueChange={(v) => set({ stroke: v as NewModelDraft["stroke"] })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="2-stroke">2-stroke</SelectItem>
                  <SelectItem value="4-stroke">4-stroke</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="nm-warranty">Warranty (mo)</Label>
              <Input
                id="nm-warranty"
                inputMode="numeric"
                value={d.default_warranty_months}
                onChange={(e) => set({ default_warranty_months: e.target.value })}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={save}>
            Use this model
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Bulk-lines grid — many NEW products in one sitting (replaces the old Bulk
 *  Add page, but lands inside the receiving so nothing is supplier-less).
 *  Existing products go straight in the main grid; this is for the carton of
 *  brand-new items. Keyboard-first: Enter adds a row. */
function BulkNewProductsDialog({
  open,
  categories,
  onAdd,
  onClose,
}: {
  open: boolean;
  categories: Category[];
  onAdd: (lines: PartLine[]) => void;
  onClose: () => void;
}) {
  interface Row {
    name: string;
    category_id: string;
    barcode: string;
    generate_barcode: boolean;
    unit: string;
    qty: string;
    cost: string;
    price: string;
    reorder: string;
  }
  const emptyRow = (): Row => ({
    name: "",
    category_id: "",
    barcode: "",
    generate_barcode: false,
    unit: "pc",
    qty: "1",
    cost: "",
    price: "",
    reorder: "0",
  });
  const [rows, setRows] = React.useState<Row[]>([emptyRow(), emptyRow(), emptyRow()]);
  React.useEffect(() => {
    if (open) setRows([emptyRow(), emptyRow(), emptyRow()]);
  }, [open]);
  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  function save() {
    const filled = rows.filter((r) => r.name.trim());
    if (!filled.length) {
      toast.error("Fill in at least one row (name is required)");
      return;
    }
    const lines: PartLine[] = [];
    for (const [i, r] of filled.entries()) {
      const qty = parseInt(r.qty || "0", 10);
      if (isNaN(qty) || qty <= 0) {
        toast.error(`Row ${i + 1} (${r.name}): qty must be positive`);
        return;
      }
      if (parsePesosToCentavos(r.cost || "") === null) {
        toast.error(`Row ${i + 1} (${r.name}): invalid unit cost ₱`);
        return;
      }
      if (parsePesosToCentavos(r.price || "") === null) {
        toast.error(`Row ${i + 1} (${r.name}): invalid selling price ₱`);
        return;
      }
      lines.push({
        part_id: "",
        new_part: {
          name: r.name.trim(),
          category_id: r.category_id || null,
          sku: "",
          barcode: r.generate_barcode ? "" : r.barcode,
          generate_barcode: r.generate_barcode,
          unit: r.unit.trim() || "pc",
          price: r.price,
          reorder_level: r.reorder,
        },
        qty: r.qty,
        unit_cost: r.cost,
      });
    }
    onAdd(lines);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Bulk new products</DialogTitle>
          <DialogDescription>
            One row per brand-new item — all land as lines on this receiving.
            Enter in the last column adds a row.
          </DialogDescription>
        </DialogHeader>
        <div className="thin-scrollbar max-h-[55vh] overflow-auto">
          <table className="w-full min-w-[64rem] text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="p-1 font-medium">#</th>
                <th className="p-1 font-medium">Name *</th>
                <th className="p-1 font-medium">Category</th>
                <th className="p-1 font-medium">Barcode</th>
                <th className="p-1 font-medium">JM</th>
                <th className="p-1 font-medium">Unit</th>
                <th className="p-1 font-medium">Qty</th>
                <th className="p-1 font-medium">Cost ₱</th>
                <th className="p-1 font-medium">Price ₱</th>
                <th className="p-1 font-medium">Reorder</th>
                <th className="p-1" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i} className="align-top">
                  <td className="p-1 pt-3 text-xs text-muted-foreground">{i + 1}</td>
                  <td className="min-w-44 p-1">
                    <Input
                      value={r.name}
                      onChange={(e) => setRow(i, { name: e.target.value })}
                      placeholder="Item name"
                    />
                  </td>
                  <td className="min-w-32 p-1">
                    <Select
                      value={r.category_id}
                      onValueChange={(v) => setRow(i, { category_id: v })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td className="w-28 p-1">
                    <Input
                      value={r.barcode}
                      onChange={(e) => setRow(i, { barcode: e.target.value })}
                      placeholder={r.generate_barcode ? "auto" : "scan…"}
                      disabled={r.generate_barcode}
                    />
                  </td>
                  <td className="p-1 pt-3">
                    <Checkbox
                      checked={r.generate_barcode}
                      onCheckedChange={(v) =>
                        setRow(i, { generate_barcode: v === true, barcode: "" })
                      }
                      aria-label="Generate JM barcode"
                    />
                  </td>
                  <td className="w-16 p-1">
                    <Input
                      value={r.unit}
                      onChange={(e) => setRow(i, { unit: e.target.value })}
                    />
                  </td>
                  <td className="w-16 p-1">
                    <Input
                      inputMode="numeric"
                      value={r.qty}
                      onChange={(e) => setRow(i, { qty: e.target.value })}
                    />
                  </td>
                  <td className="w-20 p-1">
                    <Input
                      inputMode="decimal"
                      value={r.cost}
                      onChange={(e) => setRow(i, { cost: e.target.value })}
                    />
                  </td>
                  <td className="w-20 p-1">
                    <Input
                      inputMode="decimal"
                      value={r.price}
                      onChange={(e) => setRow(i, { price: e.target.value })}
                    />
                  </td>
                  <td className="w-16 p-1">
                    <Input
                      inputMode="numeric"
                      value={r.reorder}
                      onChange={(e) => setRow(i, { reorder: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          setRows((rs) => [...rs, emptyRow()]);
                        }
                      }}
                    />
                  </td>
                  <td className="p-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Remove row"
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
                      disabled={rows.length === 1}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => setRows((rs) => [...rs, emptyRow()])}
          >
            <Plus className="size-4" /> Add row
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={save}>
              Add {rows.filter((r) => r.name.trim()).length || ""} line(s)
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface ReceivingLineDetail {
  description: string;
  detail: string | null;
  is_engine: boolean;
  qty: number;
  unit_cost_centavos: number;
}

/** Per-receiving detail: every product/engine received in that transaction. */
function ReceivingDetailDialog({
  receiving,
  onClose,
}: {
  receiving: ReceivingRow | null;
  onClose: () => void;
}) {
  const [lines, setLines] = React.useState<ReceivingLineDetail[] | null>(null);

  React.useEffect(() => {
    if (!receiving) {
      setLines(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("receiving_lines")
        .select(
          `qty, unit_cost_centavos, part_id, engine_id,
           parts(name, unit),
           engines(serial_number, engine_models(brand, model, horsepower))`
        )
        .eq("receiving_id", receiving.id)
        .order("created_at");
      if (cancelled) return;
      setLines(
        /* eslint-disable @typescript-eslint/no-explicit-any */
        (data ?? []).map((l: any) => ({
          is_engine: !!l.engine_id,
          description: l.engine_id
            ? `${l.engines?.engine_models?.brand ?? ""} ${l.engines?.engine_models?.model ?? ""}${
                l.engines?.engine_models?.horsepower != null
                  ? ` — ${l.engines.engine_models.horsepower}HP`
                  : ""
              }`.trim()
            : (l.parts?.name ?? "Item"),
          detail: l.engine_id
            ? `SN ${l.engines?.serial_number ?? "?"}`
            : (l.parts?.unit ?? null),
          qty: l.qty,
          unit_cost_centavos: l.unit_cost_centavos,
        }))
        /* eslint-enable @typescript-eslint/no-explicit-any */
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [receiving]);

  const total = (lines ?? []).reduce(
    (s, l) => s + l.qty * l.unit_cost_centavos,
    0
  );

  return (
    <Dialog open={receiving !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Receiving — {receiving?.supplier_name ?? "Manual entry"}
          </DialogTitle>
          <DialogDescription>
            {receiving &&
              format(new Date(receiving.received_at), "MMMM d, yyyy h:mm a")}
            {receiving?.note && ` · ${receiving.note}`}
          </DialogDescription>
        </DialogHeader>

        {lines === null ? (
          <div className="flex justify-center py-10">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        ) : lines.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No lines recorded on this receiving.
          </p>
        ) : (
          <>
            <div className="thin-scrollbar max-h-[55vh] overflow-auto rounded-md border">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>Item</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Unit cost</TableHead>
                    <TableHead className="text-right">Line total</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((l, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {l.is_engine && <Badge variant="secondary">Engine</Badge>}
                          <div>
                            <div className="text-sm font-medium">{l.description}</div>
                            {l.detail && (
                              <div
                                className={cn(
                                  "text-xs text-muted-foreground",
                                  l.is_engine && "font-mono"
                                )}
                              >
                                {l.detail}
                              </div>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.qty}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCentavos(l.unit_cost_centavos)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatCentavos(l.qty * l.unit_cost_centavos)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {lines.length} line{lines.length === 1 ? "" : "s"}
              </span>
              <span className="font-semibold tabular-nums">
                Total cost: {formatCentavos(total)}
              </span>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ReceivingView({
  receivings,
  suppliers,
  parts,
  models,
  categories,
  history,
  initialViewId,
}: {
  receivings: ReceivingRow[];
  suppliers: SupplierOption[];
  parts: PartOption[];
  models: EngineModel[];
  categories: Category[];
  history: PriceHistoryRow[];
  initialViewId?: string | null;
}) {
  const [showForm, setShowForm] = React.useState(false);
  const [viewing, setViewing] = React.useState<ReceivingRow | null>(
    // ?view=<id> deep-link (e.g. from a product's Suppliers & Prices panel)
    initialViewId ? (receivings.find((r) => r.id === initialViewId) ?? null) : null
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [supplierId, setSupplierId] = React.useState<string>("");
  const [note, setNote] = React.useState("");
  const [partLines, setPartLines] = React.useState<PartLine[]>([]);
  const [engineLines, setEngineLines] = React.useState<EngineLine[]>([]);
  const [paymentStatus, setPaymentStatus] =
    React.useState<"unpaid" | "partial" | "paid">("paid");
  const [amountPaid, setAmountPaid] = React.useState(""); // pesos
  const [dueDate, setDueDate] = React.useState("");
  const [overrideReason, setOverrideReason] = React.useState("");
  const [limit, setLimit] = React.useState<LimitCheck | null>(null);
  const [newPartFor, setNewPartFor] = React.useState<number | null>(null); // part line index
  const [newModelFor, setNewModelFor] = React.useState<number | null>(null); // engine line index
  const [bulkOpen, setBulkOpen] = React.useState(false);
  const [saved, setSaved] = React.useState<{
    newPartIds: string[];
    newPartNames: string[];
    lineCount: number;
    total: number;
  } | null>(null);

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;

  /** Last-paid context per product: history rows keyed by part/model id. */
  const historyByPart = React.useMemo(() => {
    const m = new Map<string, PriceHistoryRow[]>();
    for (const h of history) {
      const key = h.part_id ?? h.engine_model_id;
      if (!key) continue;
      const arr = m.get(key) ?? [];
      arr.push(h);
      m.set(key, arr);
    }
    return m;
  }, [history]);

  /** "Last from this supplier ₱X · date · cheapest elsewhere ₱Y (name)". */
  function priceContext(productId: string): React.ReactNode {
    if (!productId) return null;
    const rows = historyByPart.get(productId);
    if (!rows?.length) return null;
    const own = supplierId ? rows.find((r) => r.supplier_id === supplierId) : null;
    const others = rows.filter((r) => r.supplier_id !== supplierId);
    const cheapest = others.length
      ? others.reduce((a, b) => (b.unit_cost_centavos < a.unit_cost_centavos ? b : a))
      : null;
    if (!own && !cheapest) return null;
    return (
      <p className="text-xs text-muted-foreground" style={{ gridColumn: "1 / -1" }}>
        {own ? (
          <>
            Last paid to {own.supplier_name}:{" "}
            <span className="font-medium text-foreground tabular-nums">
              {formatCentavos(own.unit_cost_centavos)}
            </span>{" "}
            · {format(new Date(own.received_at), "MMM d, yyyy")}
          </>
        ) : (
          supplierId && <>Never bought from this supplier before.</>
        )}
        {cheapest && (
          <>
            {" — "}cheapest paid elsewhere:{" "}
            <span className="font-medium text-foreground tabular-nums">
              {formatCentavos(cheapest.unit_cost_centavos)}
            </span>{" "}
            ({cheapest.supplier_name} ·{" "}
            {format(new Date(cheapest.received_at), "MMM d, yyyy")})
          </>
        )}
      </p>
    );
  }

  function resetForm() {
    setSupplierId("");
    setNote("");
    setPartLines([]);
    setEngineLines([]);
    setPaymentStatus("paid");
    setAmountPaid("");
    setDueDate("");
    setOverrideReason("");
    setLimit(null);
  }

  /** Running cost of everything in the form — what this receiving is worth. */
  const total = React.useMemo(() => {
    let t = 0;
    for (const l of partLines) {
      const qty = parseInt(l.qty || "0", 10);
      const cost = parsePesosToCentavos(l.unit_cost || "0");
      if (!isNaN(qty) && qty > 0 && cost !== null) t += qty * cost;
    }
    for (const l of engineLines) {
      const cost = parsePesosToCentavos(l.cost || "0");
      if (cost !== null) t += cost;
    }
    return t;
  }, [partLines, engineLines]);

  /**
   * What actually lands on the supplier's tab. 'paid' adds nothing; 'partial'
   * adds only the unpaid remainder. Mirrors fn_receive_stock's own maths so
   * the warning the owner sees matches the one the RPC would raise.
   */
  const debtFromThis = React.useMemo(() => {
    if (!supplierId || paymentStatus === "paid") return 0;
    if (paymentStatus === "unpaid") return total;
    const paid = parsePesosToCentavos(amountPaid || "0") ?? 0;
    return Math.max(0, total - paid);
  }, [supplierId, paymentStatus, total, amountPaid]);

  // Live limit feedback, debounced — the owner sees outstanding + utilisation
  // the moment a supplier is picked, and the projection as lines are added.
  React.useEffect(() => {
    if (!supplierId) {
      setLimit(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const res = await checkSupplierLimit(supplierId, debtFromThis);
      if (cancelled) return;
      setLimit(res.ok ? (res.data as unknown as LimitCheck) : null);
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [supplierId, debtFromThis]);

  const wouldExceed = limit?.would_exceed ?? false;

  function updatePartLine(i: number, patch: Partial<PartLine>) {
    setPartLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }
  function updateEngineLine(i: number, patch: Partial<EngineLine>) {
    setEngineLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function onSubmit() {
    if (!supplierId) {
      toast.error("Pick the supplier — stock always comes from someone");
      return;
    }

    const partsPayload = [];
    const newPartNames: string[] = [];
    for (const [i, l] of partLines.entries()) {
      if (!l.part_id && !l.new_part) {
        toast.error(`Part line ${i + 1}: pick an item or create it as new`);
        return;
      }
      const qty = parseInt(l.qty || "0", 10);
      const cost = parsePesosToCentavos(l.unit_cost || "0");
      if (isNaN(qty) || qty <= 0) {
        toast.error(`Part line ${i + 1}: qty must be positive`);
        return;
      }
      if (cost === null) {
        toast.error(`Part line ${i + 1}: invalid ₱ cost`);
        return;
      }
      if (l.new_part) {
        const price = parsePesosToCentavos(l.new_part.price || "");
        const reorder = parseInt(l.new_part.reorder_level || "0", 10);
        if (price === null) {
          toast.error(`Part line ${i + 1} (${l.new_part.name}): invalid selling price`);
          return;
        }
        newPartNames.push(l.new_part.name);
        partsPayload.push({
          new_part: {
            name: l.new_part.name,
            category_id: l.new_part.category_id,
            sku: l.new_part.sku || null,
            barcode: l.new_part.barcode || null,
            generate_barcode: l.new_part.generate_barcode,
            unit: l.new_part.unit || "pc",
            price_centavos: price,
            reorder_level: isNaN(reorder) ? 0 : reorder,
          },
          qty,
          unit_cost_centavos: cost,
        });
      } else {
        partsPayload.push({ part_id: l.part_id, qty, unit_cost_centavos: cost });
      }
    }

    const enginesPayload = [];
    for (const [i, l] of engineLines.entries()) {
      if (!l.serial_number.trim()) {
        toast.error(`Engine line ${i + 1}: serial is required — one per unit`);
        return;
      }
      if (!l.engine_model_id && !l.new_model) {
        toast.error(`Engine line ${i + 1}: pick a model or create a new one`);
        return;
      }
      const cost = parsePesosToCentavos(l.cost || "0");
      const price = parsePesosToCentavos(l.price || "0");
      if (cost === null || price === null) {
        toast.error(`Engine line ${i + 1}: invalid ₱ amount`);
        return;
      }
      const warranty =
        l.warranty_months.trim() === "" ? null : parseInt(l.warranty_months, 10);
      if (warranty !== null && (isNaN(warranty) || warranty < 0)) {
        toast.error(`Engine line ${i + 1}: invalid warranty months`);
        return;
      }
      enginesPayload.push({
        serial_number: l.serial_number.trim(),
        ...(l.new_model
          ? {
              new_model: {
                brand: l.new_model.brand,
                model: l.new_model.model,
                horsepower: l.new_model.horsepower
                  ? parseFloat(l.new_model.horsepower)
                  : null,
                stroke: l.new_model.stroke || null,
                default_warranty_months:
                  parseInt(l.new_model.default_warranty_months || "12", 10) || 12,
              },
            }
          : { engine_model_id: l.engine_model_id }),
        condition: l.condition,
        cost_centavos: cost,
        price_centavos: price,
        warranty_months: warranty,
      });
    }

    if (partsPayload.length + enginesPayload.length === 0) {
      toast.error("Add at least one line");
      return;
    }

    if (paymentStatus === "partial") {
      const paid = parsePesosToCentavos(amountPaid || "");
      if (paid === null || paid <= 0) {
        toast.error("Enter how much you paid");
        return;
      }
      if (paid >= total) {
        toast.error("A partial payment must be less than the total — use Paid in full");
        return;
      }
    }
    // The due date is PICKED, never silently derived from the supplier's terms.
    if (paymentStatus !== "paid" && !dueDate) {
      toast.error("Pick a due date — use the presets or the calendar");
      return;
    }
    if (wouldExceed && !overrideReason.trim()) {
      toast.error("This exceeds the credit limit — give a reason to proceed");
      return;
    }

    setSubmitting(true);
    const res = await receiveStock({
      supplier_id: supplierId,
      note: note || null,
      parts: partsPayload,
      engines: enginesPayload,
      payment_status: paymentStatus,
      amount_paid_centavos:
        paymentStatus === "partial" ? parsePesosToCentavos(amountPaid || "") : null,
      due_date: paymentStatus === "paid" ? null : dueDate,
      override: wouldExceed,
      override_reason: wouldExceed ? overrideReason.trim() : null,
    });
    setSubmitting(false);

    if (res.ok) {
      setSaved({
        newPartIds: res.newPartIds ?? [],
        newPartNames,
        lineCount: partsPayload.length + enginesPayload.length,
        total,
      });
      resetForm();
      setShowForm(false);
    } else {
      toast.error(res.error);
    }
  }

  const columns: ColumnDef<ReceivingRow>[] = [
    {
      accessorKey: "received_at",
      header: "Date",
      cell: ({ getValue }) =>
        format(new Date(getValue<string>()), "MMM d, yyyy h:mm a"),
    },
    {
      accessorKey: "supplier_name",
      header: "Supplier",
      cell: ({ getValue }) =>
        getValue<string | null>() ?? (
          <span className="text-muted-foreground">Manual entry</span>
        ),
    },
    {
      id: "lines",
      header: "Lines",
      cell: ({ row }) => (
        <div className="flex gap-1">
          {row.original.part_lines > 0 && (
            <Badge variant="secondary">{row.original.part_lines} parts</Badge>
          )}
          {row.original.engine_lines > 0 && (
            <Badge>{row.original.engine_lines} engines</Badge>
          )}
        </div>
      ),
    },
    {
      accessorKey: "total_qty",
      header: "Total qty",
      cell: ({ getValue }) => (
        <span className="tabular-nums">{getValue<number>()}</span>
      ),
    },
    {
      accessorKey: "note",
      header: "Note",
      cell: ({ getValue }) => (
        <span className="line-clamp-1 max-w-sm text-muted-foreground">
          {getValue<string | null>() ?? "—"}
        </span>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setViewing(row.original)}
        >
          <Eye className="size-4" /> View
        </Button>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>New Receiving</CardTitle>
            <CardDescription>
              The single entry point for stock: supplier → lines (existing or
              brand-new products, created right here) → payment. Everything
              saves as one transaction.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-2">
                <Label>Supplier *</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                    <SelectValue placeholder="Pick the supplier…" />
                  </SelectTrigger>
                  <SelectContent>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Outstanding + utilisation the moment a supplier is picked —
                    the limit is visible BEFORE committing, not after. */}
                {supplier && limit && (
                  <p className="text-xs text-muted-foreground">
                    Owed now{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {formatCentavos(limit.outstanding)}
                    </span>
                    {limit.credit_limit != null && limit.credit_limit > 0 ? (
                      <>
                        {" "}of {formatCentavos(limit.credit_limit)} limit
                        {limit.utilization_pct != null && (
                          <> · {limit.utilization_pct}% used</>
                        )}
                      </>
                    ) : (
                      <> · no credit limit set</>
                    )}
                    {supplier.payment_terms_days != null && (
                      <> · net-{supplier.payment_terms_days} terms</>
                    )}
                  </p>
                )}
              </div>
              <div className="grid min-w-0 gap-2">
                <Label htmlFor="rcv-note">Note</Label>
                <Input
                  id="rcv-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="e.g. April restock"
                />
              </div>
            </div>

            {/* Part lines */}
            <div className="rounded-lg border">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
                <div>
                  <h3 className="text-sm font-semibold">Parts</h3>
                  <p className="text-xs text-muted-foreground">
                    By quantity — existing items or new products, same lines
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setBulkOpen(true)}
                  >
                    <Rows3 className="size-4" /> Bulk new products
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPartLines((ls) => [...ls, emptyPartLine()])}
                  >
                    <Plus className="size-4" /> Add part
                  </Button>
                </div>
              </div>

              {partLines.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No part lines yet — “Add part”, or “Bulk new products” for a
                  carton of brand-new items.
                </p>
              ) : (
                <div className="thin-scrollbar overflow-x-auto p-4">
                  <div className="grid min-w-[36rem] grid-cols-[minmax(14rem,1fr)_6rem_8rem_2.25rem] items-center gap-x-2 gap-y-2">
                    <span className="text-xs font-medium text-muted-foreground">Item</span>
                    <span className="text-xs font-medium text-muted-foreground">Qty</span>
                    <span className="text-xs font-medium text-muted-foreground">Unit cost ₱</span>
                    <span />
                    {partLines.map((l, i) => (
                      <React.Fragment key={i}>
                        {l.new_part ? (
                          <button
                            type="button"
                            onClick={() => setNewPartFor(i)}
                            className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/50"
                          >
                            <Badge className="shrink-0">NEW</Badge>
                            <span className="truncate">{l.new_part.name}</span>
                          </button>
                        ) : (
                          <PartCombobox
                            parts={parts}
                            value={l.part_id}
                            onChange={(id) => {
                              const p = parts.find((x) => x.id === id);
                              updatePartLine(i, {
                                part_id: id,
                                new_part: null,
                                unit_cost: p
                                  ? (p.cost_centavos / 100).toFixed(2)
                                  : l.unit_cost,
                              });
                            }}
                            onCreateNew={() => setNewPartFor(i)}
                          />
                        )}
                        <Input
                          inputMode="numeric"
                          value={l.qty}
                          onChange={(e) => updatePartLine(i, { qty: e.target.value })}
                          aria-label="Quantity"
                        />
                        <Input
                          inputMode="decimal"
                          value={l.unit_cost}
                          onChange={(e) =>
                            updatePartLine(i, { unit_cost: e.target.value })
                          }
                          onKeyDown={(e) => {
                            // keyboard-first bulk entry: Enter = next line
                            if (e.key === "Enter") {
                              e.preventDefault();
                              setPartLines((ls) => [...ls, emptyPartLine()]);
                            }
                          }}
                          placeholder="0.00"
                          aria-label="Unit cost in pesos"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label="Remove line"
                          onClick={() =>
                            setPartLines((ls) => ls.filter((_, j) => j !== i))
                          }
                        >
                          <Trash2 className="size-4" />
                        </Button>
                        {l.new_part ? (
                          <p
                            className="text-xs text-muted-foreground"
                            style={{ gridColumn: "1 / -1" }}
                          >
                            New product — created with this receiving; first
                            purchase sets its cost.
                          </p>
                        ) : (
                          priceContext(l.part_id)
                        )}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Engine lines */}
            <div className="rounded-lg border">
              <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
                <div>
                  <h3 className="text-sm font-semibold">Engines</h3>
                  <p className="text-xs text-muted-foreground">
                    Serialized — one line and one serial per unit, no exceptions
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setEngineLines((ls) => [
                      ...ls,
                      {
                        serial_number: "",
                        engine_model_id: "",
                        new_model: null,
                        condition: "brand_new",
                        cost: "",
                        price: "",
                        warranty_months: "",
                      },
                    ])
                  }
                >
                  <Plus className="size-4" /> Add engine
                </Button>
              </div>

              {engineLines.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No engine lines yet — click “Add engine”.
                </p>
              ) : (
                <div className="thin-scrollbar overflow-x-auto p-4">
                  <div className="grid min-w-[66rem] grid-cols-[11rem_minmax(12rem,1fr)_9rem_7rem_7rem_6rem_4.5rem] items-center gap-x-2 gap-y-2">
                    <span className="text-xs font-medium text-muted-foreground">Serial</span>
                    <span className="text-xs font-medium text-muted-foreground">Model</span>
                    <span className="text-xs font-medium text-muted-foreground">Condition</span>
                    <span className="text-xs font-medium text-muted-foreground">Cost ₱</span>
                    <span className="text-xs font-medium text-muted-foreground">Price ₱</span>
                    <span className="text-xs font-medium text-muted-foreground">Warranty (mo)</span>
                    <span />
                    {engineLines.map((l, i) => (
                      <React.Fragment key={i}>
                        <Input
                          className="font-mono"
                          value={l.serial_number}
                          onChange={(e) =>
                            updateEngineLine(i, { serial_number: e.target.value })
                          }
                          placeholder="Scan / type"
                          aria-label="Serial number"
                        />
                        {l.new_model ? (
                          <button
                            type="button"
                            onClick={() => setNewModelFor(i)}
                            className="flex min-w-0 items-center gap-2 rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/50"
                          >
                            <Badge className="shrink-0">NEW</Badge>
                            <span className="truncate">
                              {l.new_model.brand} {l.new_model.model}
                            </span>
                          </button>
                        ) : (
                          <Select
                            value={l.engine_model_id}
                            onValueChange={(v) => {
                              if (v === "__new__") {
                                setNewModelFor(i);
                                return;
                              }
                              updateEngineLine(i, {
                                engine_model_id: v,
                                new_model: null,
                              });
                            }}
                          >
                            <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                              <SelectValue placeholder="Pick a model" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="__new__" className="font-medium">
                                <Sparkles className="size-4" /> New model…
                              </SelectItem>
                              {models.map((m) => (
                                <SelectItem key={m.id} value={m.id}>
                                  {m.brand} {m.model}
                                  {m.horsepower != null ? ` — ${m.horsepower}HP` : ""}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                        <Select
                          value={l.condition}
                          onValueChange={(v) =>
                            updateEngineLine(i, {
                              condition: v as EngineLine["condition"],
                            })
                          }
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="brand_new">Brand new</SelectItem>
                            <SelectItem value="second_hand">Second hand</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          inputMode="decimal"
                          value={l.cost}
                          onChange={(e) => updateEngineLine(i, { cost: e.target.value })}
                          placeholder="0.00"
                          aria-label="Cost in pesos"
                        />
                        <Input
                          inputMode="decimal"
                          value={l.price}
                          onChange={(e) => updateEngineLine(i, { price: e.target.value })}
                          placeholder="0.00"
                          aria-label="Price in pesos"
                        />
                        <Input
                          inputMode="numeric"
                          value={l.warranty_months}
                          onChange={(e) =>
                            updateEngineLine(i, { warranty_months: e.target.value })
                          }
                          placeholder="default"
                          aria-label="Warranty months"
                        />
                        <div className="flex">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Duplicate line (next serial of the same model)"
                            title="Same model, next serial"
                            onClick={() =>
                              setEngineLines((ls) => [
                                ...ls.slice(0, i + 1),
                                { ...l, serial_number: "" },
                                ...ls.slice(i + 1),
                              ])
                            }
                          >
                            <Copy className="size-4" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Remove line"
                            onClick={() =>
                              setEngineLines((ls) => ls.filter((_, j) => j !== i))
                            }
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                        {!l.new_model && priceContext(l.engine_model_id)}
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Payment — cash, partial, or credit with a PICKED due date. */}
            {supplierId && (
              <div className="rounded-lg border">
                <div className="flex flex-wrap items-baseline justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
                  <div>
                    <h3 className="text-sm font-semibold">Payment</h3>
                    <p className="text-xs text-muted-foreground">
                      Anything unpaid becomes debt you owe {supplier?.name}.
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-muted-foreground">Receiving total</div>
                    <div className="text-base font-semibold tabular-nums">
                      {formatCentavos(total)}
                    </div>
                  </div>
                </div>

                <div className="grid gap-4 p-4 sm:grid-cols-3">
                  <div className="grid min-w-0 gap-2">
                    <Label>Payment status</Label>
                    <Select
                      value={paymentStatus}
                      onValueChange={(v) =>
                        setPaymentStatus(v as "unpaid" | "partial" | "paid")
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="paid">Paid in full</SelectItem>
                        <SelectItem value="partial">Partially paid</SelectItem>
                        <SelectItem value="unpaid">Unpaid (on credit)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {paymentStatus === "partial" && (
                    <div className="grid min-w-0 gap-2">
                      <Label htmlFor="rcv-paid">Amount paid now (₱)</Label>
                      <Input
                        id="rcv-paid"
                        inputMode="decimal"
                        value={amountPaid}
                        onChange={(e) => setAmountPaid(e.target.value)}
                        placeholder="0.00"
                      />
                      {total > 0 &&
                        parsePesosToCentavos(amountPaid || "") !== null && (
                          <p className="text-xs text-muted-foreground">
                            Balance:{" "}
                            <span className="font-medium text-foreground tabular-nums">
                              {formatCentavos(
                                Math.max(
                                  0,
                                  total - (parsePesosToCentavos(amountPaid) ?? 0)
                                )
                              )}
                            </span>
                          </p>
                        )}
                    </div>
                  )}

                  {paymentStatus !== "paid" && (
                    <div className="grid min-w-0 gap-2">
                      <Label htmlFor="rcv-due">Due date *</Label>
                      <div className="flex flex-wrap gap-1.5">
                        {[
                          { label: "1 month", months: 1 },
                          { label: "3 months", months: 3 },
                          { label: "6 months", months: 6 },
                        ].map((p) => {
                          const v = addMonths(p.months);
                          return (
                            <Button
                              key={p.months}
                              type="button"
                              variant={dueDate === v ? "default" : "outline"}
                              size="sm"
                              onClick={() => setDueDate(v)}
                            >
                              {p.label}
                            </Button>
                          );
                        })}
                      </div>
                      <DatePicker
                        id="rcv-due"
                        value={dueDate}
                        onChange={setDueDate}
                      />
                      <p className="text-xs text-muted-foreground">
                        {supplier?.payment_terms_days != null
                          ? `Reference: ${supplier.name} usually gives net-${supplier.payment_terms_days} — but the date you pick here is the one that counts.`
                          : "Presets fill the picker; any date works."}
                      </p>
                    </div>
                  )}
                </div>

                {paymentStatus !== "paid" && debtFromThis > 0 && (
                  <p className="px-4 pb-3 text-xs text-muted-foreground">
                    This adds{" "}
                    <span className="font-medium text-foreground tabular-nums">
                      {formatCentavos(debtFromThis)}
                    </span>{" "}
                    to what you owe {supplier?.name}.
                  </p>
                )}

                {/* Live limit feedback */}
                {limit && limit.credit_limit != null && limit.credit_limit > 0 && (
                  <div
                    className={cn(
                      "border-t px-4 py-3 text-sm",
                      limit.would_exceed
                        ? "bg-destructive/10"
                        : limit.near_limit
                          ? "bg-amber-500/10"
                          : "bg-muted/30"
                    )}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-muted-foreground">
                        Owed now{" "}
                        <span className="font-medium text-foreground tabular-nums">
                          {formatCentavos(limit.outstanding)}
                        </span>
                        {debtFromThis > 0 && (
                          <>
                            {" → after this "}
                            <span className="font-medium text-foreground tabular-nums">
                              {formatCentavos(limit.projected)}
                            </span>
                          </>
                        )}{" "}
                        of {formatCentavos(limit.credit_limit)} limit
                      </span>
                      {limit.utilization_pct != null && (
                        <Badge
                          variant={limit.would_exceed ? "destructive" : "secondary"}
                          className="tabular-nums"
                        >
                          {limit.utilization_pct}%
                        </Badge>
                      )}
                    </div>

                    {limit.would_exceed && (
                      <div className="mt-3 flex flex-col gap-2 rounded-md border border-destructive/50 bg-background p-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
                          <p className="text-sm font-semibold text-destructive">
                            This will put {supplier?.name} at{" "}
                            {formatCentavos(limit.projected)} against a{" "}
                            {formatCentavos(limit.credit_limit)} limit.
                          </p>
                        </div>
                        <Label htmlFor="rcv-override" className="text-xs">
                          Reason for going over (required, recorded against this
                          receiving)
                        </Label>
                        <Textarea
                          id="rcv-override"
                          value={overrideReason}
                          onChange={(e) => setOverrideReason(e.target.value)}
                          rows={2}
                          placeholder="e.g. Peak season restock — Admin approved by phone"
                        />
                      </div>
                    )}

                    {!limit.would_exceed && limit.near_limit && (
                      <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-500">
                        Close to the limit ({limit.warn_pct}% and up).
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  resetForm();
                  setShowForm(false);
                }}
              >
                Cancel
              </Button>
              <Button onClick={onSubmit} disabled={submitting}>
                {submitting && <Loader2 className="size-4 animate-spin" />}
                Receive stock
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <DataTable
        columns={columns}
        data={receivings}
        searchPlaceholder="Search receivings…"
        emptyMessage="Nothing received yet."
        toolbar={
          !showForm ? (
            <Button onClick={() => setShowForm(true)}>
              <Plus className="size-4" /> New Receiving
            </Button>
          ) : null
        }
      />

      <ReceivingDetailDialog receiving={viewing} onClose={() => setViewing(null)} />

      <NewProductDialog
        open={newPartFor !== null}
        draft={
          (newPartFor !== null && partLines[newPartFor]?.new_part) || emptyNewPart()
        }
        categories={categories}
        supplierName={supplier?.name ?? null}
        onSave={(d) => {
          if (newPartFor === null) return;
          updatePartLine(newPartFor, { part_id: "", new_part: d });
        }}
        onClose={() => setNewPartFor(null)}
      />

      <NewModelDialog
        open={newModelFor !== null}
        supplierName={supplier?.name ?? null}
        onSave={(d) => {
          if (newModelFor === null) return;
          updateEngineLine(newModelFor, { engine_model_id: "", new_model: d });
        }}
        onClose={() => setNewModelFor(null)}
      />

      <BulkNewProductsDialog
        open={bulkOpen}
        categories={categories}
        onAdd={(lines) => {
          setPartLines((ls) => [...ls, ...lines]);
          toast.success(`${lines.length} line(s) added to the receiving`);
        }}
        onClose={() => setBulkOpen(false)}
      />

      {/* Post-save: what landed + what to do next. */}
      <Dialog open={saved !== null} onOpenChange={(o) => !o && setSaved(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Stock received</DialogTitle>
            <DialogDescription>
              {saved?.lineCount} line{saved?.lineCount === 1 ? "" : "s"} ·{" "}
              {formatCentavos(saved?.total ?? 0)} into master inventory
              {saved && saved.newPartNames.length > 0 && (
                <>
                  {" "}— including {saved.newPartNames.length} new product
                  {saved.newPartNames.length === 1 ? "" : "s"}:{" "}
                  {saved.newPartNames.join(", ")}
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="sm:justify-between">
            {saved && saved.newPartIds.length > 0 ? (
              <Button asChild variant="outline">
                <Link
                  href={`/master-inventory/labels?ids=${saved.newPartIds.join(",")}`}
                  target="_blank"
                >
                  <Printer className="size-4" /> Print labels for new products
                </Link>
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSaved(null);
                  setShowForm(true);
                }}
              >
                Start another
              </Button>
              <Button onClick={() => setSaved(null)}>Done</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
