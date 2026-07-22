"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";

import type { EngineModel } from "@/lib/db-types";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addEngine } from "./actions";

const peso = z.string().refine((v) => parsePesosToCentavos(v) !== null, "Enter a ₱ amount");

const schema = z
  .object({
    model_mode: z.enum(["existing", "new"]),
    engine_model_id: z.string().optional(),
    brand: z.string().optional(),
    model: z.string().optional(),
    horsepower: z.string().optional(),
    stroke: z.string(),
    default_warranty_months: z.string().regex(/^\d*$/).optional(),
    serial_number: z.string().trim().min(1, "Serial is required"),
    condition: z.enum(["brand_new", "second_hand"]),
    cost: peso,
    price: peso,
    warranty_months: z.string().regex(/^\d*$/, "Whole number").optional(),
    supplier_id: z.string(),
  })
  .refine((v) => v.model_mode === "new" || !!v.engine_model_id, {
    message: "Pick an engine model", path: ["engine_model_id"],
  })
  .refine((v) => v.model_mode === "existing" || (!!v.brand?.trim() && !!v.model?.trim()), {
    message: "Brand and model are required", path: ["brand"],
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

export function AddEngineDialog({
  open,
  onOpenChange,
  models,
  suppliers,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: EngineModel[];
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
      model_mode: models.length > 0 ? "existing" : "new",
      engine_model_id: "", brand: "", model: "", horsepower: "", stroke: "none",
      default_warranty_months: "12", serial_number: "", condition: "brand_new",
      cost: "0", price: "0", warranty_months: "", supplier_id: "none",
    },
  });

  React.useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  const mode = watch("model_mode");
  const cost = parsePesosToCentavos(watch("cost") || "0");
  const price = parsePesosToCentavos(watch("price") || "0");
  const margin =
    cost && price && cost > 0 && price > cost ? Math.round(((price - cost) / cost) * 100) : null;

  async function onSubmit(v: FormValues) {
    const res = await addEngine({
      serial_number: v.serial_number,
      engine_model_id: v.model_mode === "existing" ? v.engine_model_id || null : null,
      new_model:
        v.model_mode === "new"
          ? {
              brand: v.brand!.trim(),
              model: v.model!.trim(),
              horsepower: v.horsepower ? Number(v.horsepower) : null,
              stroke: v.stroke === "none" ? null : (v.stroke as "2-stroke" | "4-stroke"),
              default_warranty_months: parseInt(v.default_warranty_months || "12", 10),
            }
          : null,
      condition: v.condition,
      cost_centavos: parsePesosToCentavos(v.cost)!,
      price_centavos: parsePesosToCentavos(v.price)!,
      warranty_months: v.warranty_months ? parseInt(v.warranty_months, 10) : null,
      preferred_supplier_id: v.supplier_id === "none" ? null : v.supplier_id,
    });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    toast.success("Engine added to master");
    onOpenChange(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add engine</DialogTitle>
          <DialogDescription>
            Registers one serial in master with no supplier and no debt.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          {/* Model: pick or create */}
          <div className="grid gap-2">
            <Label>Engine model</Label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant={mode === "existing" ? "default" : "outline"}
                size="sm"
                disabled={models.length === 0}
                onClick={() => setValue("model_mode", "existing")}
              >
                Pick existing
              </Button>
              <Button
                type="button"
                variant={mode === "new" ? "default" : "outline"}
                size="sm"
                onClick={() => setValue("model_mode", "new")}
              >
                New model
              </Button>
            </div>
            {mode === "existing" ? (
              <>
                <Select
                  value={watch("engine_model_id")}
                  onValueChange={(x) => setValue("engine_model_id", x, { shouldValidate: true })}
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
                {errors.engine_model_id && (
                  <p className="text-sm text-destructive">{errors.engine_model_id.message}</p>
                )}
              </>
            ) : (
              <div className="grid gap-3 rounded-md border p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ae-brand" className="text-xs">Brand</Label>
                    <Input id="ae-brand" {...register("brand")} placeholder="Yamaha" />
                    {errors.brand && <p className="text-xs text-destructive">{errors.brand.message}</p>}
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ae-model" className="text-xs">Model</Label>
                    <Input id="ae-model" {...register("model")} placeholder="Enduro E40" />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div className="grid gap-1.5">
                    <Label htmlFor="ae-hp" className="text-xs">HP</Label>
                    <Input id="ae-hp" inputMode="decimal" {...register("horsepower")} />
                  </div>
                  <div className="grid min-w-0 gap-1.5">
                    <Label className="text-xs">Stroke</Label>
                    <Select value={watch("stroke")} onValueChange={(x) => setValue("stroke", x)}>
                      <SelectTrigger className="w-full [&>span]:truncate"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">—</SelectItem>
                        <SelectItem value="2-stroke">2-stroke</SelectItem>
                        <SelectItem value="4-stroke">4-stroke</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="ae-dwm" className="text-xs">Warranty (mo)</Label>
                    <Input id="ae-dwm" type="number" min={0} {...register("default_warranty_months")} />
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ae-serial">Serial number</Label>
              <Input id="ae-serial" {...register("serial_number")} className="font-mono" />
              {errors.serial_number && (
                <p className="text-sm text-destructive">{errors.serial_number.message}</p>
              )}
            </div>
            <div className="grid min-w-0 gap-2">
              <Label>Condition</Label>
              <Select value={watch("condition")} onValueChange={(x) => setValue("condition", x as FormValues["condition"])}>
                <SelectTrigger className="w-full [&>span]:truncate"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="brand_new">Brand new</SelectItem>
                  <SelectItem value="second_hand">Second hand</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="ae-cost">Cost ₱</Label>
              <Input id="ae-cost" inputMode="decimal" {...register("cost")} />
              {errors.cost && <p className="text-sm text-destructive">{errors.cost.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ae-price">Price ₱</Label>
              <Input id="ae-price" inputMode="decimal" {...register("price")} />
              {errors.price ? (
                <p className="text-sm text-destructive">{errors.price.message}</p>
              ) : margin != null ? (
                <p className="text-xs text-muted-foreground">+{margin}% margin</p>
              ) : null}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="ae-wm">Warranty override (mo)</Label>
              <Input id="ae-wm" type="number" min={0} {...register("warranty_months")} placeholder="model default" />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Supplier (attribution only)</Label>
            <Select value={watch("supplier_id")} onValueChange={(x) => setValue("supplier_id", x)}>
              <SelectTrigger className="w-full max-w-full [&>span]:truncate"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No supplier</SelectItem>
                {suppliers.map((s) => (
                  <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Sets the preferred supplier for pricing — never creates debt.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              Add engine
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
