"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { Category } from "@/lib/db-types";
import { parsePesosToCentavos } from "@/lib/format";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRouter } from "next/navigation";
import { addProduct } from "./actions";

const peso = z.string().refine((v) => parsePesosToCentavos(v) !== null, "Enter a ₱ amount");

const schema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    category_id: z.string(),
    sku: z.string().optional(),
    barcode: z.string().optional(),
    generate_barcode: z.boolean(),
    unit: z.string().trim().min(1, "Unit is required"),
    cost: peso,
    price: peso,
    qty: z.string().regex(/^\d*$/, "Whole number"),
    reorder_level: z.string().regex(/^\d*$/, "Whole number"),
    supplier_id: z.string(),
  })
  .refine(
    (v) => {
      const c = parsePesosToCentavos(v.cost);
      const p = parsePesosToCentavos(v.price);
      return c === null || p === null || p > c;
    },
    { message: "Selling price must be above cost", path: ["price"] }
  );

type FormValues = z.infer<typeof schema>;

export function AddProductDialog({
  open,
  onOpenChange,
  categories,
  suppliers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: Category[];
  suppliers: { id: string; name: string }[];
}) {
  const router = useRouter();
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "", category_id: "none", sku: "", barcode: "", generate_barcode: false,
      unit: "pc", cost: "0", price: "0", qty: "0", reorder_level: "0", supplier_id: "none",
    },
  });

  React.useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const cost = parsePesosToCentavos(watch("cost") || "0");
  const price = parsePesosToCentavos(watch("price") || "0");
  const margin =
    cost && price && cost > 0 && price > cost
      ? Math.round(((price - cost) / cost) * 100)
      : null;
  const gen = watch("generate_barcode");
  const catValue = watch("category_id");
  const supValue = watch("supplier_id");

  async function onSubmit(v: FormValues) {
    const res = await addProduct({
      name: v.name,
      category_id: v.category_id === "none" ? null : v.category_id,
      sku: v.sku?.trim() || null,
      barcode: v.generate_barcode ? null : v.barcode?.trim() || null,
      generate_barcode: v.generate_barcode,
      unit: v.unit,
      cost_centavos: parsePesosToCentavos(v.cost)!,
      price_centavos: parsePesosToCentavos(v.price)!,
      qty: parseInt(v.qty || "0", 10),
      reorder_level: parseInt(v.reorder_level || "0", 10),
      preferred_supplier_id: v.supplier_id === "none" ? null : v.supplier_id,
    });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Product added", {
      action: res.id
        ? {
            label: "Print label",
            onClick: () => window.open(`/master-inventory/labels?ids=${res.id}`, "_blank"),
          }
        : undefined,
    });
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add product</DialogTitle>
          <DialogDescription>
            Enters stock immediately with no supplier and no debt. For a real
            purchase with debt, use Suppliers → Receiving.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="ap-name">Name</Label>
            <Input id="ap-name" {...register("name")} placeholder="Impeller — Yamaha 40HP" />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid min-w-0 gap-2">
              <Label>Category (optional)</Label>
              <Select value={catValue} onValueChange={(x) => setValue("category_id", x)}>
                <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No category</SelectItem>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-unit">Unit</Label>
              <Input id="ap-unit" {...register("unit")} placeholder="pc / liter" />
              {errors.unit && <p className="text-sm text-destructive">{errors.unit.message}</p>}
            </div>
          </div>

          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="ap-sku">SKU (optional)</Label>
                <Input id="ap-sku" {...register("sku")} />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ap-barcode">Barcode (optional)</Label>
                <Input id="ap-barcode" {...register("barcode")} disabled={gen} placeholder={gen ? "Auto-generated" : "Scan or leave blank"} />
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={gen}
                onCheckedChange={(x) => setValue("generate_barcode", x === true)}
              />
              Generate an internal barcode (GT…) instead of scanning one
            </label>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ap-cost">Cost ₱</Label>
              <Input id="ap-cost" inputMode="decimal" {...register("cost")} />
              {errors.cost && <p className="text-sm text-destructive">{errors.cost.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-price">Price ₱</Label>
              <Input id="ap-price" inputMode="decimal" {...register("price")} />
              {errors.price ? (
                <p className="text-sm text-destructive">{errors.price.message}</p>
              ) : margin != null ? (
                <p className="text-xs text-muted-foreground">+{margin}% margin</p>
              ) : null}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ap-qty">Opening qty</Label>
              <Input id="ap-qty" type="number" min={0} {...register("qty")} />
            </div>
          </div>

          <div className="grid gap-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid min-w-0 gap-2">
                <Label>Supplier (attribution only)</Label>
                <Select value={supValue} onValueChange={(x) => setValue("supplier_id", x)}>
                  <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No supplier</SelectItem>
                    {suppliers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="ap-reorder">Reorder level</Label>
                <Input id="ap-reorder" type="number" min={0} {...register("reorder_level")} />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Supplier is attribution only — it sets the preferred supplier for
              pricing and never creates debt.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              Add product
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
