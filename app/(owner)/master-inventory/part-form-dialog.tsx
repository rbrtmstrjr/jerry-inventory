"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { Category, PartRow } from "@/lib/db-types";
import { parsePesosToCentavos } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { PRODUCT_IMAGE_BUCKET } from "@/lib/product-image";
import { Button } from "@/components/ui/button";
import {
  ImageUploadField,
  type ImageAction,
} from "@/components/image-upload-field";
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
import { Textarea } from "@/components/ui/textarea";
import { setPartImage, upsertPart } from "./actions";

const pesoField = z
  .string()
  .refine((v) => parsePesosToCentavos(v) !== null, "Enter a valid ₱ amount");

const formSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  category_id: z.string().min(1, "Pick a category"),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  unit: z.string().trim().min(1, "Unit is required"),
  cost: pesoField,
  price: pesoField,
  reorder_level: z.string().regex(/^\d*$/, "Must be a whole number"),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export function PartFormDialog({
  open,
  onOpenChange,
  categories,
  part,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: Category[];
  part: PartRow | null;
}) {
  const [imageAction, setImageAction] = React.useState<ImageAction>({
    type: "keep",
  });

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      category_id: "",
      sku: "",
      barcode: "",
      unit: "pc",
      cost: "0",
      price: "0",
      reorder_level: "0",
      notes: "",
    },
  });

  React.useEffect(() => {
    if (open) {
      setImageAction({ type: "keep" });
      reset(
        part
          ? {
              name: part.name,
              category_id: part.category_id ?? "",
              sku: part.sku ?? "",
              barcode: part.barcode ?? "",
              unit: part.unit,
              cost: (part.cost_centavos / 100).toFixed(2),
              price: (part.price_centavos / 100).toFixed(2),
              reorder_level: part.reorder_level.toString(),
              notes: part.notes ?? "",
            }
          : undefined
      );
    }
  }, [open, part, reset]);

  async function onSubmit(values: FormValues) {
    const res = await upsertPart({
      id: part?.id,
      name: values.name,
      category_id: values.category_id || null,
      sku: values.sku || null,
      barcode: values.barcode || null,
      unit: values.unit,
      cost_centavos: parsePesosToCentavos(values.cost)!,
      price_centavos: parsePesosToCentavos(values.price)!,
      reorder_level: parseInt(values.reorder_level || "0", 10),
      notes: values.notes || null,
    });
    if (!res.ok) {
      toast.error(res.error);
      return;
    }

    // Image: upload/remove the Storage object (owner-only via Storage RLS),
    // then persist the path. Versioned names ({partId}-<ts>.webp) give every
    // replace a fresh URL so no browser/CDN cache shows the old photo; the
    // previous object is deleted after the swap.
    const partId = part?.id ?? res.id;
    if (partId && imageAction.type !== "keep") {
      const supabase = createClient();
      const oldPath = part?.image_path ?? null;

      if (imageAction.type === "set") {
        const objectPath = `${partId}-${Date.now()}.webp`;
        const { error } = await supabase.storage
          .from(PRODUCT_IMAGE_BUCKET)
          .upload(objectPath, imageAction.image.blob, {
            contentType: "image/webp",
            cacheControl: "31536000",
          });
        if (error) {
          toast.error(`Part saved, but the photo upload failed: ${error.message}`);
        } else {
          const set = await setPartImage(partId, objectPath);
          if (!set.ok) toast.error(set.error);
          else if (oldPath && oldPath !== objectPath) {
            await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([oldPath]);
          }
        }
      } else {
        if (oldPath) {
          await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([oldPath]);
        }
        const set = await setPartImage(partId, null);
        if (!set.ok) toast.error(set.error);
      }
    }

    toast.success(part ? "Part updated" : "Part added");
    onOpenChange(false);
  }

  const categoryValue = watch("category_id");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{part ? "Edit Part" : "Add Part"}</DialogTitle>
          <DialogDescription>
            Costs are owner-only — employees see selling price only.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label>Photo</Label>
            <ImageUploadField
              currentPath={part?.image_path ?? null}
              action={imageAction}
              onActionChange={setImageAction}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="part-name">Name</Label>
            <Input id="part-name" {...register("name")} placeholder="Impeller — Yamaha 40HP" />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid min-w-0 gap-2">
              <Label>Category</Label>
              <Select
                value={categoryValue}
                onValueChange={(v) => setValue("category_id", v, { shouldValidate: true })}
              >
                <SelectTrigger className="w-full max-w-full [&>span]:truncate">
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.category_id && (
                <p className="text-sm text-destructive">{errors.category_id.message}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="part-unit">Unit</Label>
              <Input id="part-unit" {...register("unit")} placeholder="pc / liter / meter" />
              {errors.unit && <p className="text-sm text-destructive">{errors.unit.message}</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="part-sku">SKU (optional)</Label>
              <Input id="part-sku" {...register("sku")} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="part-barcode">Barcode (optional)</Label>
              <Input
                id="part-barcode"
                {...register("barcode")}
                placeholder="Scan or leave blank"
              />
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="part-cost">Cost ₱</Label>
              <Input id="part-cost" inputMode="decimal" {...register("cost")} />
              {errors.cost && <p className="text-sm text-destructive">{errors.cost.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="part-price">Price ₱</Label>
              <Input id="part-price" inputMode="decimal" {...register("price")} />
              {errors.price && <p className="text-sm text-destructive">{errors.price.message}</p>}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="part-reorder">Reorder level</Label>
              <Input
                id="part-reorder"
                type="number"
                min={0}
                {...register("reorder_level")}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="part-notes">Notes (optional)</Label>
            <Textarea id="part-notes" rows={2} {...register("notes")} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              {part ? "Save changes" : "Add part"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
