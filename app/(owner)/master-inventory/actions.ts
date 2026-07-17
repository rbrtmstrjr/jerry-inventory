"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

const partSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Name is required"),
  category_id: z.uuid().nullable(),
  sku: z.string().trim().max(64).optional().nullable(),
  barcode: z.string().trim().max(64).optional().nullable(),
  unit: z.string().trim().min(1).default("pc"),
  cost_centavos: z.number().int().min(0),
  price_centavos: z.number().int().min(0),
  reorder_level: z.number().int().min(0).default(0),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export async function upsertPart(input: unknown): Promise<ActionResult> {
  const parsed = partSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  const row = {
    ...fields,
    sku: fields.sku || null,
    barcode: fields.barcode || null,
    notes: fields.notes || null,
  };

  const supabase = await createClient();
  const query = id
    ? supabase.from("parts").update(row).eq("id", id).select("id").single()
    : supabase.from("parts").insert(row).select("id").single();
  const { data, error } = await query;
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That barcode is already used by another item." };
    }
    return { ok: false, error: error.message };
  }
  revalidatePath("/master-inventory");
  return { ok: true, id: data.id };
}

export async function softDeletePart(id: string): Promise<ActionResult> {
  const supabase = await createClient();

  // fetch image path first so we can clean up the Storage object
  const { data: part } = await supabase
    .from("parts")
    .select("image_path")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("parts")
    .update({ deleted_at: new Date().toISOString(), image_path: null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (part?.image_path) {
    // best-effort: a failed remove leaves an orphan, not a broken product
    await supabase.storage.from("product-images").remove([part.image_path]);
  }

  revalidatePath("/master-inventory");
  return { ok: true };
}

/** Set or clear a part's image path (called after the client uploads/removes
 *  the Storage object — Storage RLS restricts writes to the owner). */
export async function setPartImage(
  id: string,
  path: string | null
): Promise<ActionResult> {
  const parsed = z
    .object({ id: z.uuid(), path: z.string().regex(/^[\w.\-\/]+$/).nullable() })
    .safeParse({ id, path });
  if (!parsed.success) return { ok: false, error: "Invalid image path" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("parts")
    .update({ image_path: parsed.data.path })
    .eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  revalidatePath("/shop");
  return { ok: true };
}

export async function generateInternalBarcode(partId: string): Promise<ActionResult & { barcode?: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_generate_internal_barcode", {
    p_part_id: partId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  return { ok: true, barcode: data as string };
}

// Bulk Add was retired by 0048: creating products with no supplier and no
// stock (its initial-qty receiving was hardcoded p_supplier_id NULL — no debt,
// no last-paid history) contradicted "receiving is the single entry point".
// Bulk entry lives on as the bulk-lines grid inside /master-inventory/receiving.

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------
const engineEditSchema = z
  .object({
    id: z.uuid(),
    condition: z.enum(["brand_new", "second_hand"]),
    cost_centavos: z.number().int().min(0),
    margin_floor_pct: z.number().min(0),
    margin_mid_pct: z.number().min(0),
    margin_asking_pct: z.number().min(0),
    warranty_months: z.number().int().min(0).nullable(),
  })
  .refine(
    (v) =>
      v.margin_floor_pct <= v.margin_mid_pct &&
      v.margin_mid_pct <= v.margin_asking_pct,
    { message: "Margins must be floor ≤ mid ≤ asking", path: ["margin_asking_pct"] }
  );

export async function updateEngine(input: unknown): Promise<ActionResult> {
  const parsed = engineEditSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  const supabase = await createClient();
  // The DB trigger recomputes price_centavos + the three tier prices from
  // cost + margins — we never write those prices directly.
  const { error } = await supabase.from("engines").update(fields).eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  return { ok: true };
}

export async function softDeleteEngine(id: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: engine } = await supabase
    .from("engines")
    .select("image_path")
    .eq("id", id)
    .single();

  // only engines still in master can be removed (sold/delivered are history)
  const { error } = await supabase
    .from("engines")
    .update({ deleted_at: new Date().toISOString(), image_path: null })
    .eq("id", id)
    .eq("status", "in_master");
  if (error) return { ok: false, error: error.message };

  if (engine?.image_path) {
    await supabase.storage.from("product-images").remove([engine.image_path]);
  }

  revalidatePath("/master-inventory");
  return { ok: true };
}

/** Set or clear an engine's image path (object managed client-side by owner). */
export async function setEngineImage(
  id: string,
  path: string | null
): Promise<ActionResult> {
  const parsed = z
    .object({ id: z.uuid(), path: z.string().regex(/^[\w.\-\/]+$/).nullable() })
    .safeParse({ id, path });
  if (!parsed.success) return { ok: false, error: "Invalid image path" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("engines")
    .update({ image_path: parsed.data.path })
    .eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  revalidatePath("/shop");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Fitment: which engine models a part fits
// ---------------------------------------------------------------------------
const fitmentSchema = z.object({
  part_id: z.uuid(),
  engine_model_ids: z.array(z.uuid()),
});

export async function setPartFitments(input: unknown): Promise<ActionResult> {
  const parsed = fitmentSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { part_id, engine_model_ids } = parsed.data;

  const { error: delError } = await supabase
    .from("part_fitments")
    .delete()
    .eq("part_id", part_id);
  if (delError) return { ok: false, error: delError.message };

  if (engine_model_ids.length > 0) {
    const { error } = await supabase
      .from("part_fitments")
      .insert(engine_model_ids.map((id) => ({ part_id, engine_model_id: id })));
    if (error) return { ok: false, error: error.message };
  }
  revalidatePath("/master-inventory");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------
const supplierSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Name is required"),
  contact: z.string().trim().max(200).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  /** centavos; null = no limit (warns only, never blocks) */
  credit_limit: z.number().int().min(0).nullable().default(null),
  payment_terms_days: z.number().int().min(0).max(365).nullable().default(null),
  terms_note: z.string().trim().max(500).optional().nullable(),
});

export async function upsertSupplier(input: unknown): Promise<ActionResult> {
  const parsed = supplierSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  const row = {
    ...fields,
    contact: fields.contact || null,
    notes: fields.notes || null,
    terms_note: fields.terms_note || null,
  };
  const supabase = await createClient();
  const query = id
    ? supabase.from("suppliers").update(row).eq("id", id)
    : supabase.from("suppliers").insert(row);
  const { error } = await query;
  if (error) return { ok: false, error: error.message };
  revalidatePath("/suppliers");
  revalidatePath("/suppliers");
  return { ok: true };
}

export async function softDeleteSupplier(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("suppliers")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/suppliers");
  return { ok: true };
}

// Receiving moved to app/(owner)/suppliers/actions.ts — receiving is a
// supplier transaction (it picks a supplier, creates debt, checks the limit).

// ---------------------------------------------------------------------------
// Reference data (engine models, categories): CREATED inline at receiving
// only; EDITED/DEACTIVATED here. They're type definitions, not stock — fixing
// a typo'd model name must not require a receiving.
// ---------------------------------------------------------------------------
const modelEditSchema = z.object({
  id: z.uuid(),
  brand: z.string().trim().min(1, "Brand is required"),
  model: z.string().trim().min(1, "Model is required"),
  horsepower: z.number().min(0).nullable(),
  stroke: z.enum(["2-stroke", "4-stroke"]).nullable(),
  default_warranty_months: z.number().int().min(0),
});

export async function updateEngineModel(input: unknown): Promise<ActionResult> {
  const parsed = modelEditSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.from("engine_models").update(fields).eq("id", id);
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "That brand + model already exists." };
    }
    return { ok: false, error: error.message };
  }
  revalidatePath("/master-inventory");
  revalidatePath("/suppliers");
  return { ok: true };
}

/** Retire a discontinued model — hides it from pickers; existing engines keep it. */
export async function softDeleteEngineModel(id: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("engine_models")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  revalidatePath("/suppliers");
  return { ok: true };
}

export async function updateCategory(id: string, name: string): Promise<ActionResult> {
  const parsed = z
    .object({ id: z.uuid(), name: z.string().trim().min(1, "Name is required") })
    .safeParse({ id, name });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("product_categories")
    .update({ name: parsed.data.name })
    .eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  return { ok: true };
}

/** Retire a category — hides it from pickers; existing products keep it. */
export async function softDeleteCategory(id: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("product_categories")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  return { ok: true };
}

/**
 * Change which supplier a product is reordered from (purchase list grouping,
 * "preferred isn't cheapest" badges). Surfaced on the product's
 * Suppliers & Prices panel.
 */
export async function setPreferredSupplier(
  partId: string,
  supplierId: string | null
): Promise<ActionResult> {
  const parsed = z
    .object({ partId: z.uuid(), supplierId: z.uuid().nullable() })
    .safeParse({ partId, supplierId });
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("parts")
    .update({ preferred_supplier_id: parsed.data.supplierId })
    .eq("id", parsed.data.partId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  revalidatePath("/suppliers");
  revalidatePath("/stock-alerts");
  return { ok: true };
}
