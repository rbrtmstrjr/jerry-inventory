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

// ---------------------------------------------------------------------------
// Bulk add: insert catalog rows, then land initial quantities in master stock
// through the atomic receiving function (so the ledger stays truthful).
// ---------------------------------------------------------------------------
const bulkRowSchema = partSchema.omit({ id: true }).extend({
  initial_qty: z.number().int().min(0).default(0),
});
const bulkSchema = z.array(bulkRowSchema).min(1, "Add at least one row");

export async function bulkAddParts(input: unknown): Promise<ActionResult & { count?: number }> {
  const parsed = bulkSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();

  const rows = parsed.data.map(({ initial_qty: _q, ...r }) => ({
    ...r,
    sku: r.sku || null,
    barcode: r.barcode || null,
    notes: r.notes || null,
  }));

  const { data: inserted, error } = await supabase
    .from("parts")
    .insert(rows)
    .select("id");
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "A barcode in your rows is already in use." };
    }
    return { ok: false, error: error.message };
  }

  const withQty = inserted
    .map((p, i) => ({
      part_id: p.id,
      qty: parsed.data[i].initial_qty,
      unit_cost_centavos: parsed.data[i].cost_centavos,
    }))
    .filter((l) => l.qty > 0);

  if (withQty.length > 0) {
    const { error: rcvError } = await supabase.rpc("fn_receive_stock", {
      p_supplier_id: null,
      p_note: "Initial stock entry (bulk add)",
      p_parts: withQty,
      p_engines: [],
    });
    if (rcvError) {
      return {
        ok: false,
        error: `Parts saved, but initial stock failed: ${rcvError.message}`,
      };
    }
  }

  revalidatePath("/master-inventory");
  return { ok: true, count: inserted.length };
}

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

// ---------------------------------------------------------------------------
// Receiving (atomic through fn_receive_stock)
// ---------------------------------------------------------------------------
const receivingSchema = z
  .object({
    supplier_id: z.uuid().nullable(),
    note: z.string().trim().max(2000).optional().nullable(),
    parts: z
      .array(
        z.object({
          part_id: z.uuid(),
          qty: z.number().int().positive(),
          unit_cost_centavos: z.number().int().min(0),
        })
      )
      .default([]),
    engines: z
      .array(
        z.object({
          serial_number: z.string().trim().min(1, "Serial is required"),
          engine_model_id: z.uuid(),
          condition: z.enum(["brand_new", "second_hand"]).default("brand_new"),
          cost_centavos: z.number().int().min(0),
          price_centavos: z.number().int().min(0),
          warranty_months: z.number().int().min(0).nullable(),
          // optional 3-tier margins; trigger computes tier prices when present
          margin_floor_pct: z.number().min(0).nullable().default(null),
          margin_mid_pct: z.number().min(0).nullable().default(null),
          margin_asking_pct: z.number().min(0).nullable().default(null),
        })
      )
      .default([]),
    payment_status: z.enum(["unpaid", "partial", "paid"]).default("paid"),
    /** Only meaningful when payment_status = 'partial'; the RPC derives the rest. */
    amount_paid_centavos: z.number().int().min(0).nullable().default(null),
    /** null = let the RPC compute it from the supplier's payment terms. */
    due_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    override: z.boolean().default(false),
    override_reason: z.string().trim().max(500).optional().nullable(),
  })
  .refine((v) => v.parts.length + v.engines.length > 0, {
    message: "Add at least one line",
  });

export async function receiveStock(input: unknown): Promise<ActionResult> {
  const parsed = receivingSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_receive_stock", {
    p_supplier_id: parsed.data.supplier_id,
    p_note: parsed.data.note || null,
    p_parts: parsed.data.parts,
    p_engines: parsed.data.engines,
    p_payment_status: parsed.data.payment_status,
    p_amount_paid: parsed.data.amount_paid_centavos,
    p_due_date: parsed.data.due_date,
    p_override: parsed.data.override,
    p_override_reason: parsed.data.override_reason || null,
  });
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "One of those engine serials already exists." };
    }
    return { ok: false, error: error.message };
  }
  revalidatePath("/master-inventory");
  revalidatePath("/suppliers");
  return { ok: true, id: data as string };
}
