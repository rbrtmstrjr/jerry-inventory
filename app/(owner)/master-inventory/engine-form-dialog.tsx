"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { EngineModel, EngineRow } from "@/lib/db-types";
import { formatCentavos, parsePesosToCentavos } from "@/lib/format";
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
import { setEngineImage, updateEngine } from "./actions";

const pesoField = z
  .string()
  .refine((v) => parsePesosToCentavos(v) !== null, "Enter a valid ₱ amount");

const formSchema = z.object({
  condition: z.enum(["brand_new", "second_hand"]),
  price: pesoField,
  warranty_months: z.string(), // "" = model default
});

type FormValues = z.infer<typeof formSchema>;

/**
 * EDIT-only since 0049 — engines are born on a supplier receiving; there is
 * no create mode here (and no direct INSERT grant to back one).
 */
export function EngineFormDialog({
  open,
  onOpenChange,
  models,
  engine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: EngineModel[];
  engine: EngineRow | null;
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
      condition: "brand_new",
      price: "0",
      warranty_months: "",
    },
  });

  React.useEffect(() => {
    if (open && engine) {
      setImageAction({ type: "keep" });
      reset({
        condition: engine.condition,
        price: (engine.price_centavos / 100).toFixed(2),
        warranty_months: engine.warranty_months?.toString() ?? "",
      });
    }
  }, [open, engine, reset]);

  const conditionValue = watch("condition");

  // Selling price must clear cost — the new single-price floor (0053).
  const costC = engine?.cost_centavos ?? 0;
  const priceC = parsePesosToCentavos(watch("price"));
  const belowCost = priceC !== null && priceC <= costC;

  async function applyImage(engineId: string) {
    if (imageAction.type === "keep") return;
    const supabase = createClient();
    const oldPath = engine?.image_path ?? null;
    if (imageAction.type === "set") {
      const objectPath = `${engineId}-${Date.now()}.webp`;
      const { error } = await supabase.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .upload(objectPath, imageAction.image.blob, {
          contentType: "image/webp",
          cacheControl: "31536000",
        });
      if (error) {
        toast.error(`Engine saved, but the photo upload failed: ${error.message}`);
        return;
      }
      const set = await setEngineImage(engineId, objectPath);
      if (!set.ok) toast.error(set.error);
      else if (oldPath && oldPath !== objectPath) {
        await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([oldPath]);
      }
    } else {
      if (oldPath) {
        await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([oldPath]);
      }
      const set = await setEngineImage(engineId, null);
      if (!set.ok) toast.error(set.error);
    }
  }

  async function onSubmit(values: FormValues) {
    const warranty =
      values.warranty_months.trim() === ""
        ? null
        : parseInt(values.warranty_months, 10);
    if (warranty !== null && (isNaN(warranty) || warranty < 0)) {
      toast.error("Warranty months must be a number");
      return;
    }
    if (!engine) return; // edit-only since 0049 — never opened without one
    const price_centavos = parsePesosToCentavos(values.price)!;
    if (price_centavos <= engine.cost_centavos) {
      toast.error(`Selling price must be above cost ${formatCentavos(engine.cost_centavos)}`);
      return;
    }
    const res = await updateEngine({
      id: engine.id,
      condition: values.condition,
      cost_centavos: engine.cost_centavos,
      warranty_months: warranty,
      price_centavos,
    });
    if (res.ok) {
      await applyImage(engine.id);
      toast.success("Engine updated");
      onOpenChange(false);
    } else toast.error(res.error);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Engine</DialogTitle>
          <DialogDescription>Serial {engine?.serial_number}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <div className="grid gap-2">
            <Label>Photo</Label>
            <ImageUploadField
              currentPath={engine?.image_path ?? null}
              action={imageAction}
              onActionChange={setImageAction}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid min-w-0 gap-2">
              <Label>Model</Label>
              <Input
                value={
                  models.find((m) => m.id === engine?.engine_model_id)
                    ? `${models.find((m) => m.id === engine?.engine_model_id)!.brand} ${
                        models.find((m) => m.id === engine?.engine_model_id)!.model
                      }`
                    : "—"
                }
                disabled
                aria-label="Engine model (fixed at receiving)"
              />
            </div>
            <div className="grid min-w-0 gap-2">
              <Label>Condition</Label>
              <Select
                value={conditionValue}
                onValueChange={(v) =>
                  setValue("condition", v as FormValues["condition"])
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
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Cost ₱ (owner-only)</Label>
              <Input value={formatCentavos(costC)} disabled aria-label="Cost (set at receiving)" />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="engine-warranty">Warranty (months)</Label>
              <Input
                id="engine-warranty"
                inputMode="numeric"
                placeholder="model default"
                {...register("warranty_months")}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="engine-price">Selling price ₱</Label>
            <Input id="engine-price" inputMode="decimal" {...register("price")} />
            {errors.price ? (
              <p className="text-sm text-destructive">{errors.price.message}</p>
            ) : belowCost ? (
              <p className="text-sm text-destructive">
                Selling price must be above cost {formatCentavos(costC)}
              </p>
            ) : null}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || belowCost}>
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              {engine ? "Save changes" : "Add engine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
