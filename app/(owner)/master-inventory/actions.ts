"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

async function requireOwner(): Promise<boolean> {
  const profile = await getProfile();
  return profile?.role === "owner";
}

// ---------------------------------------------------------------------------
// Add custom product / engine (0059) — supplier OPTIONAL. Creation still goes
// through fn_receive_stock (the ONLY door, 0049); p_supplier_id NULL means a
// supplier-less, no-debt receiving. A chosen supplier is attribution only
// (preferred_supplier_id) — never a payable.
// ---------------------------------------------------------------------------
const addProductSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    category_id: z.uuid().nullable().default(null),
    sku: z.string().trim().max(64).nullable().default(null),
    barcode: z.string().trim().max(64).nullable().default(null),
    generate_barcode: z.boolean().default(false),
    unit: z.string().trim().min(1).default("pc"),
    cost_centavos: z.number().int().min(0),
    price_centavos: z.number().int().min(0),
    qty: z.number().int().min(0).default(0),
    reorder_level: z.number().int().min(0).default(0),
    preferred_supplier_id: z.uuid().nullable().default(null),
  })
  .refine((v) => v.price_centavos > v.cost_centavos, {
    message: "Selling price must be above cost",
    path: ["price_centavos"],
  });

export async function addProduct(input: unknown): Promise<ActionResult> {
  if (!(await requireOwner())) return { ok: false, error: "Only the owner can add products" };
  const parsed = addProductSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_receive_stock", {
    p_supplier_id: null,
    p_note: `Custom add: ${d.name}`,
    p_parts: [
      {
        qty: d.qty,
        unit_cost_centavos: d.cost_centavos,
        new_part: {
          name: d.name,
          category_id: d.category_id,
          sku: d.sku,
          barcode: d.barcode,
          generate_barcode: d.generate_barcode,
          unit: d.unit,
          price_centavos: d.price_centavos,
          reorder_level: d.reorder_level,
          preferred_supplier_id: d.preferred_supplier_id,
        },
      },
    ],
  });
  if (error) return { ok: false, error: error.message };

  // the RPC returns the receiving id, not the part — look up the just-created
  // part (for the Print-label offer). Single-owner app, so newest-by-name is fine.
  const { data: part } = await supabase
    .from("parts")
    .select("id")
    .eq("name", d.name)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  revalidatePath("/master-inventory");
  return { ok: true, id: part?.id };
}

const addEngineSchema = z
  .object({
    serial_number: z.string().trim().min(1, "Serial is required"),
    engine_model_id: z.uuid().nullable().default(null),
    new_model: z
      .object({
        brand: z.string().trim().min(1),
        model: z.string().trim().min(1),
        horsepower: z.number().positive().nullable().default(null),
        stroke: z.enum(["2-stroke", "4-stroke"]).nullable().default(null),
        default_warranty_months: z.number().int().min(0).default(12),
      })
      .nullable()
      .default(null),
    condition: z.enum(["brand_new", "second_hand"]).default("brand_new"),
    cost_centavos: z.number().int().min(0),
    price_centavos: z.number().int().min(0),
    warranty_months: z.number().int().min(0).nullable().default(null),
    preferred_supplier_id: z.uuid().nullable().default(null),
  })
  .refine((v) => v.engine_model_id !== null || v.new_model !== null, {
    message: "Pick an engine model or create a new one",
    path: ["engine_model_id"],
  })
  .refine((v) => v.price_centavos > v.cost_centavos, {
    message: "Selling price must be above cost",
    path: ["price_centavos"],
  });

export async function addEngine(input: unknown): Promise<ActionResult> {
  if (!(await requireOwner())) return { ok: false, error: "Only the owner can add engines" };
  const parsed = addEngineSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const d = parsed.data;
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_receive_stock", {
    p_supplier_id: null,
    p_note: `Custom add: engine ${d.serial_number}`,
    p_engines: [
      {
        serial_number: d.serial_number,
        engine_model_id: d.engine_model_id,
        new_model: d.new_model
          ? { ...d.new_model, preferred_supplier_id: d.preferred_supplier_id }
          : null,
        condition: d.condition,
        cost_centavos: d.cost_centavos,
        price_centavos: d.price_centavos,
        warranty_months: d.warranty_months,
      },
    ],
  });
  if (error) return { ok: false, error: error.message };
  // attribution on an EXISTING model: stamp preferred if it had none (never overwrite)
  if (d.engine_model_id && d.preferred_supplier_id) {
    await supabase
      .from("engine_models")
      .update({ preferred_supplier_id: d.preferred_supplier_id })
      .eq("id", d.engine_model_id)
      .is("preferred_supplier_id", null);
  }
  const { data: eng } = await supabase
    .from("engines")
    .select("id")
    .eq("serial_number", d.serial_number)
    .maybeSingle();
  revalidatePath("/master-inventory");
  return { ok: true, id: eng?.id };
}

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

/**
 * Read-only preview of whether a duplicate part can be merged (0052). Mirrors
 * fn_merge_parts's preconditions so the dialog can grey out blocked sources
 * before anyone clicks. The RPC re-checks server-side — this is UX, not the gate.
 */
export async function checkPartMergeable(
  sourceId: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!z.uuid().safeParse(sourceId).success) return { ok: false, reason: "Invalid part" };
  const supabase = await createClient();

  const { data: stock } = await supabase
    .from("stock_levels")
    .select("qty, shops(name)")
    .eq("part_id", sourceId)
    .gt("qty", 0)
    .order("qty", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (stock) {
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const loc = (stock as any).shops?.name ?? "master";
    return { ok: false, reason: `${stock.qty} on hand at ${loc} — sell, return, or count to zero first` };
  }

  const { data: transit } = await supabase
    .from("delivery_lines")
    .select("qty_outstanding")
    .eq("part_id", sourceId)
    .gt("qty_outstanding", 0)
    .limit(1)
    .maybeSingle();
  if (transit) return { ok: false, reason: "Still has units in transit — confirm or resolve the delivery first" };

  const { data: openSale } = await supabase
    .from("sale_lines")
    .select("id, sales!inner(status, deleted_at)")
    .eq("part_id", sourceId)
    .in("sales.status", ["recorded", "pending", "questioned"])
    .is("sales.deleted_at", null)
    .limit(1)
    .maybeSingle();
  const { data: openLoss } = await supabase
    .from("losses")
    .select("id")
    .eq("part_id", sourceId)
    .in("status", ["recorded", "pending", "questioned"])
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (openSale || openLoss)
    return { ok: false, reason: "On an unsubmitted or pending sale/loss — resolve it first" };

  return { ok: true };
}

/** Fold a duplicate part into a survivor (catalog identity only — 0052). */
export async function mergeParts(
  sourceId: string,
  targetId: string,
  note?: string | null
): Promise<ActionResult> {
  const parsed = z
    .object({ sourceId: z.uuid(), targetId: z.uuid(), note: z.string().trim().max(500).optional().nullable() })
    .safeParse({ sourceId, targetId, note });
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_merge_parts", {
    p_source_id: parsed.data.sourceId,
    p_target_id: parsed.data.targetId,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/master-inventory");
  revalidatePath("/suppliers");
  return { ok: true };
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
const engineEditSchema = z.object({
  id: z.uuid(),
  condition: z.enum(["brand_new", "second_hand"]),
  cost_centavos: z.number().int().min(0),
  price_centavos: z.number().int().min(0),
  warranty_months: z.number().int().min(0).nullable(),
});

export async function updateEngine(input: unknown): Promise<ActionResult> {
  const parsed = engineEditSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  const supabase = await createClient();
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

// Refresh both the Products page (category dropdowns/filter read its data) and
// the Category tab so a change shows everywhere with no reload.
function revalidateCategories() {
  revalidatePath("/master-inventory");
  revalidatePath("/master-inventory/categories");
}

/**
 * Create a product category (the missing piece — 0059 era). Owner-only.
 * Case-insensitive dedupe: an ACTIVE match is rejected; a RETIRED match is
 * RESTORED (predictable — you can't end up with two "Oil & Lubricants").
 */
export async function createCategory(name: string): Promise<ActionResult> {
  if (!(await requireOwner())) return { ok: false, error: "Only the owner can manage categories" };
  const parsed = z.string().trim().min(1, "Category name is required").max(60).safeParse(name);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const trimmed = parsed.data;
  const supabase = await createClient();

  // case-insensitive match across active + retired (name has a UNIQUE index,
  // but it's case-sensitive, so match manually)
  const { data: matches } = await supabase
    .from("product_categories")
    .select("id, name, deleted_at")
    .ilike("name", trimmed);
  const active = (matches ?? []).find((m) => !m.deleted_at);
  if (active) return { ok: false, error: `“${active.name}” already exists.` };
  const retired = (matches ?? []).find((m) => m.deleted_at);
  if (retired) {
    const { error } = await supabase
      .from("product_categories")
      .update({ deleted_at: null, name: trimmed })
      .eq("id", retired.id);
    if (error) return { ok: false, error: error.message };
    revalidateCategories();
    return { ok: true, id: retired.id };
  }

  const { data, error } = await supabase
    .from("product_categories")
    .insert({ name: trimmed })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return { ok: false, error: `“${trimmed}” already exists.` };
    return { ok: false, error: error.message };
  }
  revalidateCategories();
  return { ok: true, id: data.id };
}

export async function updateCategory(id: string, name: string): Promise<ActionResult> {
  if (!(await requireOwner())) return { ok: false, error: "Only the owner can manage categories" };
  const parsed = z
    .object({ id: z.uuid(), name: z.string().trim().min(1, "Name is required").max(60) })
    .safeParse({ id, name });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("product_categories")
    .update({ name: parsed.data.name })
    .eq("id", parsed.data.id);
  if (error) {
    if (error.code === "23505") return { ok: false, error: "Another category already has that name." };
    return { ok: false, error: error.message };
  }
  revalidateCategories();
  return { ok: true };
}

/** Retire a category — hides it from pickers; existing products keep it. */
export async function softDeleteCategory(id: string): Promise<ActionResult> {
  if (!(await requireOwner())) return { ok: false, error: "Only the owner can manage categories" };
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase
    .from("product_categories")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidateCategories();
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
