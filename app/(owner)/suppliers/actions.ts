"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Record a payment to a supplier. Owner-only (re-checked in the RPC).
 *
 * This is stock COST (COGS) — it must never also be logged in the Expenses
 * module, which is for fuel/labour/rent. Double-counting it there would
 * overstate expenses and understate margin.
 */
export async function recordSupplierPayment(input: unknown): Promise<
  | { ok: true; allocations: { receiving_id: string; amount: number }[]; outstanding: number }
  | { ok: false; error: string }
> {
  const parsed = z
    .object({
      supplier_id: z.uuid(),
      amount_centavos: z.number().int().positive(),
      /** null = allocate FIFO across the oldest open receivings */
      receiving_id: z.uuid().nullable().default(null),
      paid_at: z.string().nullable().default(null),
      method: z.enum(["cash", "bank", "gcash", "check", "other"]).default("cash"),
      reference_no: z.string().trim().max(200).optional().nullable(),
      note: z.string().trim().max(2000).optional().nullable(),
      receipt_image_path: z
        .string()
        .regex(/^[\w.\-/]+$/)
        .nullable()
        .default(null),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_record_supplier_payment", {
    p_supplier_id: parsed.data.supplier_id,
    p_amount: parsed.data.amount_centavos,
    p_receiving_id: parsed.data.receiving_id,
    p_paid_at: parsed.data.paid_at,
    p_method: parsed.data.method,
    p_reference_no: parsed.data.reference_no || null,
    p_note: parsed.data.note || null,
    p_receipt_image_path: parsed.data.receipt_image_path,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/suppliers");
  revalidatePath("/suppliers");
  const res = data as {
    allocations: { receiving_id: string; amount: number }[];
    outstanding: number;
  };
  return { ok: true, allocations: res.allocations ?? [], outstanding: res.outstanding };
}

/** Live "what will this receiving do to the limit?" feedback. */
export async function checkSupplierLimit(
  supplierId: string,
  additionalCentavos: number
): Promise<ActionResult & { data?: Record<string, unknown> }> {
  if (!z.uuid().safeParse(supplierId).success) {
    return { ok: false, error: "Invalid supplier" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_supplier_limit_check", {
    p_supplier_id: supplierId,
    p_additional: Math.max(0, Math.round(additionalCentavos)),
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, data: data as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Receiving (atomic through fn_receive_stock) — moved here from
// master-inventory: receiving is a supplier transaction. It picks a supplier,
// creates supplier debt, checks their credit limit, and feeds payables.
// ---------------------------------------------------------------------------
/** A product born on the receiving itself (0048) — catalog cost comes from the line. */
const newPartSchema = z.object({
  name: z.string().trim().min(1, "New product needs a name"),
  category_id: z.uuid().nullable().default(null),
  sku: z.string().trim().max(64).optional().nullable(),
  barcode: z.string().trim().max(64).optional().nullable(),
  generate_barcode: z.boolean().default(false),
  unit: z.string().trim().min(1).default("pc"),
  price_centavos: z.number().int().min(0),
  reorder_level: z.number().int().min(0).default(0),
});

const newModelSchema = z.object({
  brand: z.string().trim().min(1, "New model needs a brand"),
  model: z.string().trim().min(1, "New model needs a model name"),
  horsepower: z.number().min(0).nullable().default(null),
  stroke: z.enum(["2-stroke", "4-stroke"]).nullable().default(null),
  default_warranty_months: z.number().int().min(0).default(12),
});

const receivingSchema = z
  .object({
    // Stock always comes from someone — receiving is the single entry point.
    supplier_id: z.uuid({ error: "Pick the supplier" }),
    note: z.string().trim().max(2000).optional().nullable(),
    parts: z
      .array(
        z
          .object({
            part_id: z.uuid().optional(),
            new_part: newPartSchema.optional(),
            qty: z.number().int().positive(),
            unit_cost_centavos: z.number().int().min(0),
          })
          .refine((l) => !!l.part_id !== !!l.new_part, {
            message: "A part line is either an existing item or a new product",
          })
      )
      .default([]),
    engines: z
      .array(
        z
          .object({
            serial_number: z.string().trim().min(1, "Serial is required"),
            engine_model_id: z.uuid().optional(),
            new_model: newModelSchema.optional(),
            condition: z.enum(["brand_new", "second_hand"]).default("brand_new"),
            cost_centavos: z.number().int().min(0),
            price_centavos: z.number().int().min(0),
            warranty_months: z.number().int().min(0).nullable(),
          })
          .refine((l) => !!l.engine_model_id !== !!l.new_model, {
            message: "An engine line is either an existing model or a new one",
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
    /** How the up-front money moved. Same set as supplier_payments.method. */
    payment_method: z
      .enum(["cash", "bank", "gcash", "check", "other"])
      .nullable()
      .default(null),
    reference_no: z.string().trim().max(100).nullable().default(null),
  })
  .refine((v) => v.parts.length + v.engines.length > 0, {
    message: "Add at least one line",
  });

export async function receiveStock(
  input: unknown
): Promise<{ ok: true; id: string; newPartIds: string[] } | { ok: false; error: string }> {
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
    p_payment_method: parsed.data.payment_method,
    p_reference_no: parsed.data.reference_no || null,
  });
  if (error) {
    if (error.code === "23505") {
      return { ok: false, error: "One of those engine serials already exists." };
    }
    return { ok: false, error: error.message };
  }
  const receivingId = data as string;

  // Which parts were BORN on this receiving? now() is fixed inside the RPC's
  // transaction, so an inline-created part has created_at = the receiving's
  // own created_at; pre-existing parts are strictly older. Drives the
  // post-save "print labels for new products" action.
  let newPartIds: string[] = [];
  if (parsed.data.parts.some((l) => l.new_part)) {
    const { data: rcv } = await supabase
      .from("receivings").select("created_at").eq("id", receivingId).single();
    const { data: lines } = await supabase
      .from("receiving_lines").select("part_id").eq("receiving_id", receivingId)
      .not("part_id", "is", null);
    const ids = (lines ?? []).map((l) => l.part_id as string);
    if (rcv && ids.length) {
      const { data: born } = await supabase
        .from("parts").select("id").in("id", ids).gte("created_at", rcv.created_at);
      newPartIds = (born ?? []).map((p) => p.id);
    }
  }

  revalidatePath("/master-inventory");
  revalidatePath("/suppliers");
  return { ok: true, id: receivingId, newPartIds };
}
