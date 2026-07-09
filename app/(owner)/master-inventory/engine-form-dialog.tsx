"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { EngineModel, EngineRow } from "@/lib/db-types";
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
import { receiveStock, setEngineImage, updateEngine } from "./actions";

const pesoField = z
  .string()
  .refine((v) => parsePesosToCentavos(v) !== null, "Enter a valid ₱ amount");

const formSchema = z.object({
  serial_number: z.string().trim().min(1, "Serial is required"),
  engine_model_id: z.string().min(1, "Pick a model"),
  condition: z.enum(["brand_new", "second_hand"]),
  cost: pesoField,
  price: pesoField,
  warranty_months: z.string(), // "" = model default
});

type FormValues = z.infer<typeof formSchema>;

export function EngineFormDialog({
  open,
  onOpenChange,
  models,
  engine,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: EngineModel[];
  engine: EngineRow | null; // null = add new (goes through receiving fn)
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
      serial_number: "",
      engine_model_id: "",
      condition: "brand_new",
      cost: "0",
      price: "0",
      warranty_months: "",
    },
  });

  React.useEffect(() => {
    if (open) {
      setImageAction({ type: "keep" });
      reset(
        engine
          ? {
              serial_number: engine.serial_number,
              engine_model_id: engine.engine_model_id,
              condition: engine.condition,
              cost: (engine.cost_centavos / 100).toFixed(2),
              price: (engine.price_centavos / 100).toFixed(2),
              warranty_months: engine.warranty_months?.toString() ?? "",
            }
          : undefined
      );
    }
  }, [open, engine, reset]);

  async function onSubmit(values: FormValues) {
    const warranty =
      values.warranty_months.trim() === ""
        ? null
        : parseInt(values.warranty_months, 10);
    if (warranty !== null && (isNaN(warranty) || warranty < 0)) {
      toast.error("Warranty months must be a number");
      return;
    }

    // upload/remove the photo for a known engine id, then persist the path
    async function applyImage(engineId: string) {
      if (imageAction.type === "keep") return;
      const supabase = createClient();
      const objectPath = `${engineId}.webp`;
      if (imageAction.type === "set") {
        const { error } = await supabase.storage
          .from(PRODUCT_IMAGE_BUCKET)
          .upload(objectPath, imageAction.image.blob, {
            upsert: true,
            contentType: "image/webp",
            cacheControl: "3600",
          });
        if (error) {
          toast.error(`Engine saved, but the photo upload failed: ${error.message}`);
          return;
        }
        const set = await setEngineImage(engineId, objectPath);
        if (!set.ok) toast.error(set.error);
      } else {
        await supabase.storage.from(PRODUCT_IMAGE_BUCKET).remove([objectPath]);
        const set = await setEngineImage(engineId, null);
        if (!set.ok) toast.error(set.error);
      }
    }

    if (engine) {
      const res = await updateEngine({
        id: engine.id,
        condition: values.condition,
        cost_centavos: parsePesosToCentavos(values.cost)!,
        price_centavos: parsePesosToCentavos(values.price)!,
        warranty_months: warranty,
      });
      if (res.ok) {
        await applyImage(engine.id);
        toast.success("Engine updated");
        onOpenChange(false);
      } else toast.error(res.error);
    } else {
      // New engines land in master through the atomic receiving function
      const res = await receiveStock({
        supplier_id: null,
        note: "Manual engine entry",
        parts: [],
        engines: [
          {
            serial_number: values.serial_number,
            engine_model_id: values.engine_model_id,
            condition: values.condition,
            cost_centavos: parsePesosToCentavos(values.cost)!,
            price_centavos: parsePesosToCentavos(values.price)!,
            warranty_months: warranty,
          },
        ],
      });
      if (res.ok) {
        // receiving returns its own id — look the new engine up by serial
        if (imageAction.type === "set") {
          const supabase = createClient();
          const { data: created } = await supabase
            .from("engines")
            .select("id")
            .eq("serial_number", values.serial_number.trim())
            .single();
          if (created) await applyImage(created.id);
        }
        toast.success(`Engine ${values.serial_number} added to master`);
        onOpenChange(false);
      } else toast.error(res.error);
    }
  }

  const modelValue = watch("engine_model_id");
  const conditionValue = watch("condition");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{engine ? "Edit Engine" : "Add Engine"}</DialogTitle>
          <DialogDescription>
            {engine
              ? `Serial ${engine.serial_number}`
              : "Each engine is tracked by its serial number."}
          </DialogDescription>
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

          {!engine && (
            <div className="grid gap-2">
              <Label htmlFor="engine-serial">Serial number</Label>
              <Input
                id="engine-serial"
                {...register("serial_number")}
                placeholder="Scan or type the serial"
                autoComplete="off"
              />
              {errors.serial_number && (
                <p className="text-sm text-destructive">
                  {errors.serial_number.message}
                </p>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid min-w-0 gap-2">
              <Label>Model</Label>
              <Select
                value={modelValue}
                onValueChange={(v) =>
                  setValue("engine_model_id", v, { shouldValidate: true })
                }
                disabled={!!engine}
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
                <p className="text-sm text-destructive">
                  {errors.engine_model_id.message}
                </p>
              )}
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

          <div className="grid grid-cols-3 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="engine-cost">Cost ₱</Label>
              <Input id="engine-cost" inputMode="decimal" {...register("cost")} />
              {errors.cost && (
                <p className="text-sm text-destructive">{errors.cost.message}</p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="engine-price">Price ₱</Label>
              <Input id="engine-price" inputMode="decimal" {...register("price")} />
              {errors.price && (
                <p className="text-sm text-destructive">{errors.price.message}</p>
              )}
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

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="size-4 animate-spin" />}
              {engine ? "Save changes" : "Add engine"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
