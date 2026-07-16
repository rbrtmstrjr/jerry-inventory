"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/stock-alerts");
  revalidatePath("/stock-alerts/purchase-list");
  revalidatePath("/master-inventory");
  revalidatePath("/shop/low-stock");
}

const thresholdSchema = z.object({
  kind: z.enum(["part", "engine_model"]),
  id: z.uuid(),
  reorder_level: z.number().int().min(0),
  preferred_supplier_id: z.uuid().nullable().default(null),
});

/** Set a product's DEFAULT reorder level (+ preferred supplier for the purchase list). */
export async function setProductThreshold(input: unknown): Promise<ActionResult> {
  const parsed = thresholdSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { kind, id, reorder_level, preferred_supplier_id } = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase
    .from(kind === "part" ? "parts" : "engine_models")
    .update({ reorder_level, preferred_supplier_id })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

const overrideSchema = z
  .object({
    shop_id: z.uuid(),
    kind: z.enum(["part", "engine_model"]),
    product_id: z.uuid(),
    reorder_level: z.number().int().min(0),
  })
  .refine((v) => v.reorder_level >= 0, { message: "Level must be 0 or more" });

/** Per-shop override of a product's reorder level (upsert). */
export async function setShopOverride(input: unknown): Promise<ActionResult> {
  const parsed = overrideSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { shop_id, kind, product_id, reorder_level } = parsed.data;
  const supabase = await createClient();

  const col = kind === "part" ? "part_id" : "engine_model_id";
  // one live override per shop+product — update in place when it exists
  const { data: existing } = await supabase
    .from("shop_reorder_levels")
    .select("id")
    .eq("shop_id", shop_id)
    .eq(col, product_id)
    .is("deleted_at", null)
    .maybeSingle();

  const { error } = existing
    ? await supabase
        .from("shop_reorder_levels")
        .update({ reorder_level })
        .eq("id", existing.id)
    : await supabase.from("shop_reorder_levels").insert({
        shop_id,
        [col]: product_id,
        reorder_level,
      });

  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/** Drop an override — the shop falls back to the product default. */
export async function removeShopOverride(id: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("shop_reorder_levels")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}
