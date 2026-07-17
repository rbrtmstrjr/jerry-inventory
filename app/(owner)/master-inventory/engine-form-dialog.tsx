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

const pctField = z
  .string()
  .refine((v) => v.trim() !== "" && !isNaN(Number(v)) && Number(v) >= 0, "Enter a %");

const formSchema = z
  .object({
    condition: z.enum(["brand_new", "second_hand"]),
    cost: pesoField,
    margin_floor: pctField,
    margin_mid: pctField,
    margin_asking: pctField,
    warranty_months: z.string(), // "" = model default
  })
  .refine(
    (v) => Number(v.margin_floor) <= Number(v.margin_mid),
    { message: "Floor % can't exceed mid %", path: ["margin_mid"] }
  )
  .refine(
    (v) => Number(v.margin_mid) <= Number(v.margin_asking),
    { message: "Mid % can't exceed asking %", path: ["margin_asking"] }
  );

type FormValues = z.infer<typeof formSchema>;

/** Implied margin % from an engine's stored price vs cost (legacy fallback). */
function impliedPct(priceCentavos: number, costCentavos: number): string {
  if (!costCentavos) return "";
  return (((priceCentavos / costCentavos) - 1) * 100).toFixed(0);
}

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
      cost: "0",
      margin_floor: "",
      margin_mid: "",
      margin_asking: "",
      warranty_months: "",
    },
  });

  React.useEffect(() => {
    if (open && engine) {
      setImageAction({ type: "keep" });
      const implied = impliedPct(engine.price_centavos, engine.cost_centavos);
      reset({
        condition: engine.condition,
        cost: (engine.cost_centavos / 100).toFixed(2),
        margin_floor: engine.margin_floor_pct?.toString() ?? implied,
        margin_mid: engine.margin_mid_pct?.toString() ?? implied,
        margin_asking: engine.margin_asking_pct?.toString() ?? implied,
        warranty_months: engine.warranty_months?.toString() ?? "",
      });
    }
  }, [open, engine, reset]);

  const conditionValue = watch("condition");

  // Live computed tier prices as the owner types (owner-only preview).
  const costC = parsePesosToCentavos(watch("cost")) ?? 0;
  const tier = (raw: string): number | null => {
    const n = Number(raw);
    if (raw.trim() === "" || isNaN(n) || costC === 0) return null;
    return Math.round(costC * (1 + n / 100));
  };
  const priceFloor = tier(watch("margin_floor"));
  const priceMid = tier(watch("margin_mid"));
  const priceAsking = tier(watch("margin_asking"));

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
    const cost_centavos = parsePesosToCentavos(values.cost)!;
    const margins = {
      margin_floor_pct: Number(values.margin_floor),
      margin_mid_pct: Number(values.margin_mid),
      margin_asking_pct: Number(values.margin_asking),
    };

    if (!engine) return; // edit-only since 0049 — never opened without one
    const res = await updateEngine({
      id: engine.id,
      condition: values.condition,
      cost_centavos,
      warranty_months: warranty,
      ...margins,
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
              <Label htmlFor="engine-cost">Cost ₱ (owner-only)</Label>
              <Input id="engine-cost" inputMode="decimal" {...register("cost")} />
              {errors.cost && (
                <p className="text-sm text-destructive">{errors.cost.message}</p>
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

          {/* Tiered pricing — owner sets three margins; prices auto-compute */}
          <div className="grid gap-3 rounded-md border bg-muted/30 p-3">
            <div>
              <Label className="text-sm">Negotiable pricing — margins over cost</Label>
              <p className="text-xs text-muted-foreground">
                Floor is the hard minimum a shop can sell at. Employees see the
                three prices, never the cost or margins.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="m-floor" className="text-xs">
                  Floor %
                </Label>
                <Input
                  id="m-floor"
                  inputMode="decimal"
                  placeholder="e.g. 30"
                  {...register("margin_floor")}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="m-mid" className="text-xs">
                  Mid %
                </Label>
                <Input
                  id="m-mid"
                  inputMode="decimal"
                  placeholder="e.g. 40"
                  {...register("margin_mid")}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="m-asking" className="text-xs">
                  Asking %
                </Label>
                <Input
                  id="m-asking"
                  inputMode="decimal"
                  placeholder="e.g. 50"
                  {...register("margin_asking")}
                />
              </div>
            </div>
            {(errors.margin_floor || errors.margin_mid || errors.margin_asking) && (
              <p className="text-sm text-destructive">
                {errors.margin_asking?.message ??
                  errors.margin_mid?.message ??
                  errors.margin_floor?.message}
              </p>
            )}
            {/* Live computed prices */}
            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: "Floor", value: priceFloor, tone: "text-destructive" },
                { label: "Mid", value: priceMid, tone: "text-foreground" },
                { label: "Asking", value: priceAsking, tone: "text-success" },
              ].map((t) => (
                <div key={t.label} className="rounded-md bg-background p-2">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    {t.label}
                  </div>
                  <div className={`text-sm font-semibold tabular-nums ${t.tone}`}>
                    {t.value != null ? formatCentavos(t.value) : "—"}
                  </div>
                </div>
              ))}
            </div>
            {costC === 0 && (
              <p className="text-xs text-muted-foreground">
                Enter a cost above to preview computed prices.
              </p>
            )}
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
