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
// Supplier quotes — the entered half of the price comparison.
// ---------------------------------------------------------------------------

const quoteSchema = z
  .object({
    supplier_id: z.uuid(),
    part_id: z.uuid().nullable(),
    engine_model_id: z.uuid().nullable(),
    unit_cost_centavos: z.number().int().positive("Price must be more than zero"),
    quoted_at: z.iso.date("Enter the date the quote was given"),
    valid_until: z.iso.date().nullable(),
    note: z.string().trim().max(300).nullable(),
  })
  // mirrors constraint quote_item
  .refine((v) => (v.part_id === null) !== (v.engine_model_id === null), {
    message: "A quote is for exactly one product",
  })
  // mirrors constraint quote_valid_range
  .refine((v) => v.valid_until === null || v.valid_until >= v.quoted_at, {
    message: "Valid-until must be on or after the quote date",
    path: ["valid_until"],
  });

/**
 * Record a quote. Always an INSERT, never an update: quotes are a history —
 * the comparison view takes the latest per supplier × product, and last
 * month's number staying on record is exactly what makes "prices are moving"
 * visible. RLS makes the table owner-only; this action leans on it the same
 * way the rest of this file does.
 */
export async function recordSupplierQuote(input: unknown): Promise<ActionResult> {
  const parsed = quoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { error } = await supabase.from("supplier_quotes").insert({
    ...parsed.data,
    note: parsed.data.note || null,
    created_by: user?.id ?? null,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/suppliers");
  revalidatePath("/stock-alerts/purchase-list");
  return { ok: true };
}

/**
 * Change a product's preferred supplier — the tie-in from the comparison: the
 * "Preferred is ₱X more" badge is only useful if the fix is one click away.
 *
 * Deliberately NOT setProductThreshold (stock-alerts): that action writes
 * reorder_level and preferred_supplier_id together, and the comparison has no
 * business carrying a reorder level just to change a supplier. One concern,
 * one column.
 */
export async function setPreferredSupplier(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      kind: z.enum(["part", "engine_model"]),
      product_id: z.uuid(),
      supplier_id: z.uuid().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const supabase = await createClient();
  const { error } = await supabase
    .from(parsed.data.kind === "part" ? "parts" : "engine_models")
    .update({ preferred_supplier_id: parsed.data.supplier_id })
    .eq("id", parsed.data.product_id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/suppliers");
  revalidatePath("/stock-alerts");
  revalidatePath("/stock-alerts/purchase-list");
  revalidatePath("/master-inventory");
  return { ok: true };
}
