"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useFieldArray, useForm } from "react-hook-form";
import { Copy, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import type { Category } from "@/lib/db-types";
import { parsePesosToCentavos } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Row {
  name: string;
  category_id: string;
  sku: string;
  barcode: string;
  unit: string;
  cost: string;
  price: string;
  reorder_level: string;
  initial_qty: string;
}

const emptyRow = (): Row => ({
  name: "",
  category_id: "",
  sku: "",
  barcode: "",
  unit: "pc",
  cost: "",
  price: "",
  reorder_level: "0",
  initial_qty: "0",
});

export function BulkAddForm({ categories }: { categories: Category[] }) {
  const router = useRouter();
  const [submitting, setSubmitting] = React.useState(false);

  const { control, register, handleSubmit, getValues, setValue, watch } =
    useForm<{ rows: Row[] }>({
      defaultValues: { rows: [emptyRow(), emptyRow(), emptyRow()] },
    });
  const { fields, append, remove } = useFieldArray({ control, name: "rows" });

  function duplicateLast() {
    const rows = getValues("rows");
    const last = rows[rows.length - 1];
    append({ ...last, name: "", sku: "", barcode: "", initial_qty: "0" });
  }

  async function onSubmit(values: { rows: Row[] }) {
    const filled = values.rows.filter((r) => r.name.trim().length > 0);
    if (filled.length === 0) {
      toast.error("Fill in at least one row (name is required)");
      return;
    }

    const rows = [];
    for (const [i, r] of filled.entries()) {
      const cost = parsePesosToCentavos(r.cost || "0");
      const price = parsePesosToCentavos(r.price || "0");
      const reorder = parseInt(r.reorder_level || "0", 10);
      const qty = parseInt(r.initial_qty || "0", 10);
      if (cost === null || price === null) {
        toast.error(`Row ${i + 1} (${r.name}): invalid ₱ amount`);
        return;
      }
      if (isNaN(reorder) || reorder < 0 || isNaN(qty) || qty < 0) {
        toast.error(`Row ${i + 1} (${r.name}): invalid quantity`);
        return;
      }
      rows.push({
        name: r.name.trim(),
        category_id: r.category_id || null,
        sku: r.sku || null,
        barcode: r.barcode || null,
        unit: r.unit.trim() || "pc",
        cost_centavos: cost,
        price_centavos: price,
        reorder_level: reorder,
        notes: null,
        initial_qty: qty,
      });
    }

    setSubmitting(true);
    const { bulkAddParts } = await import("../actions");
    const res = await bulkAddParts(rows);
    setSubmitting(false);

    if (res.ok) {
      toast.success(`${res.count} product(s) added`);
      router.push("/master-inventory");
    } else {
      toast.error(res.error);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bulk Add Parts &amp; Goods</CardTitle>
        <CardDescription>
          Fast initial product entry — one row per item. Initial qty lands in
          master stock (ledgered as “Initial stock entry”). ₱ amounts in pesos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="p-1 font-medium">#</th>
                  <th className="p-1 font-medium">Name *</th>
                  <th className="p-1 font-medium">Category</th>
                  <th className="p-1 font-medium">SKU</th>
                  <th className="p-1 font-medium">Barcode</th>
                  <th className="p-1 font-medium">Unit</th>
                  <th className="p-1 font-medium">Cost ₱</th>
                  <th className="p-1 font-medium">Price ₱</th>
                  <th className="p-1 font-medium">Reorder</th>
                  <th className="p-1 font-medium">Initial qty</th>
                  <th className="p-1" />
                </tr>
              </thead>
              <tbody>
                {fields.map((field, i) => (
                  <tr key={field.id} className="align-top">
                    <td className="p-1 pt-3 text-xs text-muted-foreground">{i + 1}</td>
                    <td className="p-1 min-w-44">
                      <Input {...register(`rows.${i}.name`)} placeholder="Item name" />
                    </td>
                    <td className="p-1 min-w-36">
                      <Select
                        value={watch(`rows.${i}.category_id`)}
                        onValueChange={(v) => setValue(`rows.${i}.category_id`, v)}
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
                    <td className="p-1 w-24">
                      <Input {...register(`rows.${i}.sku`)} />
                    </td>
                    <td className="p-1 w-32">
                      <Input {...register(`rows.${i}.barcode`)} placeholder="scan…" />
                    </td>
                    <td className="p-1 w-20">
                      <Input {...register(`rows.${i}.unit`)} />
                    </td>
                    <td className="p-1 w-24">
                      <Input inputMode="decimal" {...register(`rows.${i}.cost`)} />
                    </td>
                    <td className="p-1 w-24">
                      <Input inputMode="decimal" {...register(`rows.${i}.price`)} />
                    </td>
                    <td className="p-1 w-20">
                      <Input inputMode="numeric" {...register(`rows.${i}.reorder_level`)} />
                    </td>
                    <td className="p-1 w-20">
                      <Input inputMode="numeric" {...register(`rows.${i}.initial_qty`)} />
                    </td>
                    <td className="p-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Remove row"
                        onClick={() => remove(i)}
                        disabled={fields.length === 1}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" onClick={() => append(emptyRow())}>
              <Plus className="size-4" /> Add row
            </Button>
            <Button type="button" variant="outline" onClick={duplicateLast}>
              <Copy className="size-4" /> Duplicate last
            </Button>
            <div className="flex-1" />
            <Button type="submit" disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              Save all
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
