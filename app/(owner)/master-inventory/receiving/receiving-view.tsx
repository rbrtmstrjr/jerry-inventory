"use client";

import * as React from "react";
import { format } from "date-fns";
import { type ColumnDef } from "@tanstack/react-table";
import { Check, ChevronsUpDown, Eye, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { EngineModel } from "@/lib/db-types";
import type { ReceivingRow } from "@/lib/db-types";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
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
import { Spinner } from "@/components/ui/spinner";
import { DataTable } from "@/components/data-table/data-table";
import { receiveStock } from "../actions";

interface PartOption {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unit: string;
  cost_centavos: number;
}

interface PartLine {
  part_id: string;
  qty: string;
  unit_cost: string; // pesos
}

interface EngineLine {
  serial_number: string;
  engine_model_id: string;
  condition: "brand_new" | "second_hand";
  cost: string;
  price: string;
  warranty_months: string;
}

function PartCombobox({
  parts,
  value,
  onChange,
}: {
  parts: PartOption[];
  value: string;
  onChange: (id: string) => void;
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
          <CommandInput placeholder="Search name, SKU, barcode…" />
          <CommandList>
            <CommandEmpty>No item found.</CommandEmpty>
            <CommandGroup>
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
}: {
  receivings: ReceivingRow[];
  suppliers: { id: string; name: string }[];
  parts: PartOption[];
  models: EngineModel[];
}) {
  const [showForm, setShowForm] = React.useState(false);
  const [viewing, setViewing] = React.useState<ReceivingRow | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [supplierId, setSupplierId] = React.useState<string>("");
  const [note, setNote] = React.useState("");
  const [partLines, setPartLines] = React.useState<PartLine[]>([]);
  const [engineLines, setEngineLines] = React.useState<EngineLine[]>([]);

  function resetForm() {
    setSupplierId("");
    setNote("");
    setPartLines([]);
    setEngineLines([]);
  }

  function updatePartLine(i: number, patch: Partial<PartLine>) {
    setPartLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }
  function updateEngineLine(i: number, patch: Partial<EngineLine>) {
    setEngineLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  }

  async function onSubmit() {
    const partsPayload = [];
    for (const [i, l] of partLines.entries()) {
      if (!l.part_id) {
        toast.error(`Part line ${i + 1}: pick an item`);
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
      partsPayload.push({ part_id: l.part_id, qty, unit_cost_centavos: cost });
    }

    const enginesPayload = [];
    for (const [i, l] of engineLines.entries()) {
      if (!l.serial_number.trim()) {
        toast.error(`Engine line ${i + 1}: serial is required`);
        return;
      }
      if (!l.engine_model_id) {
        toast.error(`Engine line ${i + 1}: pick a model`);
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
        engine_model_id: l.engine_model_id,
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

    setSubmitting(true);
    const res = await receiveStock({
      supplier_id: supplierId || null,
      note: note || null,
      parts: partsPayload,
      engines: enginesPayload,
    });
    setSubmitting(false);

    if (res.ok) {
      toast.success("Stock received into master inventory");
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
              Log incoming stock into master — parts by quantity, engines by
              serial. Stock and the movements ledger update atomically.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid min-w-0 gap-2">
                <Label>Supplier (optional)</Label>
                <Select value={supplierId} onValueChange={setSupplierId}>
                  <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                    <SelectValue placeholder="Manual / no supplier" />
                  </SelectTrigger>
                  <SelectContent>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
              <div className="flex items-center justify-between gap-2 border-b bg-muted/40 px-4 py-2.5">
                <div>
                  <h3 className="text-sm font-semibold">Parts</h3>
                  <p className="text-xs text-muted-foreground">By quantity</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setPartLines((ls) => [
                      ...ls,
                      { part_id: "", qty: "1", unit_cost: "" },
                    ])
                  }
                >
                  <Plus className="size-4" /> Add part
                </Button>
              </div>

              {partLines.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                  No part lines yet — click “Add part”.
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
                        <PartCombobox
                          parts={parts}
                          value={l.part_id}
                          onChange={(id) => {
                            const p = parts.find((x) => x.id === id);
                            updatePartLine(i, {
                              part_id: id,
                              unit_cost: p
                                ? (p.cost_centavos / 100).toFixed(2)
                                : l.unit_cost,
                            });
                          }}
                        />
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
                    By serial — one line per unit
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
                  <div className="grid min-w-[62rem] grid-cols-[11rem_minmax(12rem,1fr)_9rem_7rem_7rem_6rem_2.25rem] items-center gap-x-2 gap-y-2">
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
                        <Select
                          value={l.engine_model_id}
                          onValueChange={(v) =>
                            updateEngineLine(i, { engine_model_id: v })
                          }
                        >
                          <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                            <SelectValue placeholder="Pick a model" />
                          </SelectTrigger>
                          <SelectContent>
                            {models.map((m) => (
                              <SelectItem key={m.id} value={m.id}>
                                {m.brand} {m.model}
                                {m.horsepower != null ? ` — ${m.horsepower}HP` : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
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
                      </React.Fragment>
                    ))}
                  </div>
                </div>
              )}
            </div>

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
    </div>
  );
}
