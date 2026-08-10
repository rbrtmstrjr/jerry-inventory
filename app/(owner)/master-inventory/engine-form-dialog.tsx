"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2, Pencil } from "lucide-react";
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
import { setEngineImage, updateEngine, updateEngineModel } from "./actions";

const pesoField = z
  .string()
  .refine((v) => parsePesosToCentavos(v) !== null, "Enter a valid ₱ amount");

const formSchema = z.object({
  engine_model_id: z.string().min(1, "Pick a model"),
  condition: z.enum(["brand_new", "second_hand"]),
  cost: pesoField,
  price: pesoField,
  warranty_months: z.string(), // "" = model default
});

type FormValues = z.infer<typeof formSchema>;

/** EDIT-only since 0049 — engines are born on a receiving, and there is no
 *  direct INSERT grant to back a create mode. */
export function EngineFormDialog({
  open,
  onOpenChange,
  models,
  engine,
  priceLocked = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  models: EngineModel[];
  engine: EngineRow | null;
  /** 0100: cost + selling price are Gerry-only after entry. */
  priceLocked?: boolean;
}) {
  const [imageAction, setImageAction] = React.useState<ImageAction>({
    type: "keep",
  });
  const [renameOpen, setRenameOpen] = React.useState(false);
  // pinned at openRename — the dropdown may move to another model afterwards
  const [renameTargetId, setRenameTargetId] = React.useState<string | null>(null);
  const [renameBrand, setRenameBrand] = React.useState("");
  const [renameName, setRenameName] = React.useState("");
  const [renameHp, setRenameHp] = React.useState("");
  const [renameBusy, setRenameBusy] = React.useState(false);

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
      engine_model_id: "",
      condition: "brand_new",
      cost: "0",
      price: "0",
      warranty_months: "",
    },
  });

  React.useEffect(() => {
    if (open && engine) {
      setImageAction({ type: "keep" });
      setRenameOpen(false);
      reset({
        engine_model_id: engine.engine_model_id,
        condition: engine.condition,
        cost: (engine.cost_centavos / 100).toFixed(2),
        price: (engine.price_centavos / 100).toFixed(2),
        warranty_months: engine.warranty_months?.toString() ?? "",
      });
    }
  }, [open, engine, reset]);

  const conditionValue = watch("condition");
  const modelValue = watch("engine_model_id");
  // reassignment fixes a wrong-model receiving; units that left master are history
  const inMaster = engine?.status === "in_master";
  const selectedModel = models.find((m) => m.id === modelValue);
  // 0128: a UNIT-… number must never pose as a real plate — only offer models
  // of the same serialization kind (server re-checks; unknown when retired)
  const ownModelSerialized = models.find((m) => m.id === engine?.engine_model_id)?.is_serialized;
  const pickableModels =
    ownModelSerialized == null
      ? models
      : models.filter((m) => m.is_serialized === ownModelSerialized);
  const ownModelRetired = engine != null && !models.some((m) => m.id === engine.engine_model_id);

  // Selling price must clear cost, but not under priceLocked: the admin can't
  // change money anyway, and a legacy at-cost row must not block their edit.
  const costC = parsePesosToCentavos(watch("cost")) ?? engine?.cost_centavos ?? 0;
  const priceC = parsePesosToCentavos(watch("price"));
  const belowCost = !priceLocked && priceC !== null && priceC <= costC;

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

  function openRename() {
    const m = models.find((x) => x.id === modelValue);
    setRenameTargetId(m?.id ?? null);
    setRenameBrand(m?.brand ?? engine?.brand ?? "");
    setRenameName(m?.model ?? engine?.model ?? "");
    setRenameHp(m?.horsepower != null ? String(m.horsepower) : "");
    setRenameOpen(true);
  }

  async function saveRename() {
    const m = models.find((x) => x.id === renameTargetId);
    if (!m) {
      toast.error("This model is retired — restore it from the Models dialog first");
      return;
    }
    if (!renameBrand.trim() || !renameName.trim()) {
      toast.error("Brand and model are required");
      return;
    }
    const hpRaw = renameHp.trim();
    if (hpRaw !== "" && !/^\d+(\.\d+)?$/.test(hpRaw)) {
      toast.error("Invalid HP");
      return;
    }
    const hp = hpRaw === "" ? null : parseFloat(hpRaw);
    setRenameBusy(true);
    const res = await updateEngineModel({
      id: m.id,
      brand: renameBrand.trim(),
      model: renameName.trim(),
      horsepower: hp,
      stroke: (m.stroke as "2-stroke" | "4-stroke" | null) ?? null,
      default_warranty_months: m.default_warranty_months ?? 12,
      is_serialized: m.is_serialized ?? true,
      sku: m.sku ?? null,
    });
    setRenameBusy(false);
    if (res.ok) {
      toast.success(`Model renamed to ${renameBrand.trim()} ${renameName.trim()}`);
      setRenameOpen(false);
    } else toast.error(res.error);
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
    const cost_centavos = priceLocked
      ? engine.cost_centavos
      : parsePesosToCentavos(values.cost)!;
    const price_centavos = parsePesosToCentavos(values.price)!;
    if (!priceLocked && price_centavos <= cost_centavos) {
      toast.error(`Selling price must be above cost ${formatCentavos(cost_centavos)}`);
      return;
    }
    const res = await updateEngine({
      id: engine.id,
      engine_model_id: values.engine_model_id,
      condition: values.condition,
      cost_centavos,
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
              <div className="flex items-center justify-between gap-2">
                <Label>Model</Label>
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline"
                  onClick={openRename}
                >
                  <Pencil className="size-3" /> Rename model
                </button>
              </div>
              {inMaster ? (
                <Select
                  value={modelValue}
                  onValueChange={(v) => {
                    setValue("engine_model_id", v, { shouldValidate: true });
                    setRenameOpen(false); // panel is pinned to the previous model — don't leave it up
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Engine model">
                    <SelectValue placeholder="Pick a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {/* engine's own model may be retired — keep it selectable */}
                    {ownModelRetired && engine && (
                      <SelectItem value={engine.engine_model_id}>
                        {engine.brand} {engine.model} (retired)
                      </SelectItem>
                    )}
                    {pickableModels.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.brand} {m.model}
                        {m.horsepower != null ? ` — ${m.horsepower}HP` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={
                    selectedModel
                      ? `${selectedModel.brand} ${selectedModel.model}`
                      : engine
                        ? `${engine.brand} ${engine.model}`
                        : "—"
                  }
                  disabled
                  aria-label="Engine model (fixed once the engine has left master)"
                />
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

          {renameOpen && (
            <div
              className="grid gap-2 rounded-md border p-3"
              onKeyDown={(e) => {
                // Enter here must rename, never implicitly submit the engine form
                if (e.key === "Enter") {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!renameBusy) saveRename();
                }
              }}
            >
              <p className="text-xs text-muted-foreground">
                Renames the model everywhere — every engine of this model, past and present.
              </p>
              <div className="grid grid-cols-[1fr_1fr_5rem] gap-2">
                <div className="grid gap-1.5">
                  <Label htmlFor="rename-brand">Brand</Label>
                  <Input
                    id="rename-brand"
                    value={renameBrand}
                    onChange={(e) => setRenameBrand(e.target.value)}
                    placeholder="Brand"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="rename-model">Model</Label>
                  <Input
                    id="rename-model"
                    value={renameName}
                    onChange={(e) => setRenameName(e.target.value)}
                    placeholder="Model"
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="rename-hp">HP</Label>
                  <Input
                    id="rename-hp"
                    inputMode="decimal"
                    value={renameHp}
                    onChange={(e) => setRenameHp(e.target.value)}
                    placeholder="—"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setRenameOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" size="sm" disabled={renameBusy} onClick={saveRename}>
                  {renameBusy && <Loader2 className="size-4 animate-spin" />} Rename
                </Button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label htmlFor="engine-cost">Cost ₱ (owner-only)</Label>
              <Input id="engine-cost" inputMode="decimal" disabled={priceLocked} {...register("cost")} />
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

          <div className="grid gap-2">
            <Label htmlFor="engine-price">Selling price ₱</Label>
            <Input id="engine-price" inputMode="decimal" disabled={priceLocked} {...register("price")} />
            {errors.price ? (
              <p className="text-sm text-destructive">{errors.price.message}</p>
            ) : belowCost ? (
              <p className="text-sm text-destructive">
                Selling price must be above cost {formatCentavos(costC)}
              </p>
            ) : priceLocked ? (
              <p className="text-xs text-muted-foreground">
                Only the owner can change cost or selling price.
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
