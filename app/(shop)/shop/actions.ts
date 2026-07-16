"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

const saleSchema = z
  .object({
    customer_id: z.uuid().nullable(),
    customer: z
      .object({
        name: z.string().trim().min(1),
        phone: z.string().trim().optional(),
        address: z.string().trim().optional(),
      })
      .nullable(),
    part_lines: z
      .array(z.object({ part_id: z.uuid(), qty: z.number().int().positive() }))
      .default([]),
    // engines carry a negotiated agreed price (centavos); the server re-checks
    // it against the hidden hard floor
    engine_lines: z
      .array(
        z.object({
          engine_id: z.uuid(),
          agreed_price_centavos: z.number().int().positive(),
        })
      )
      .default([]),
    payment_type: z.enum(["full", "partial"]).default("full"),
    amount_paid_centavos: z.number().int().min(0).nullable().default(null),
  })
  .refine((v) => v.part_lines.length + v.engine_lines.length > 0, {
    message: "Add at least one item",
  });

export async function recordSale(input: unknown): Promise<ActionResult> {
  const parsed = saleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_record_sale", {
    p_customer_id: parsed.data.customer_id,
    p_customer: parsed.data.customer,
    p_part_lines: parsed.data.part_lines,
    p_engine_ids: [],
    p_engine_lines: parsed.data.engine_lines,
    p_payment_type: parsed.data.payment_type,
    p_amount_paid_centavos: parsed.data.amount_paid_centavos,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  return { ok: true, id: data as string };
}

const lossSchema = z
  .object({
    part_id: z.uuid().nullable(),
    engine_id: z.uuid().nullable(),
    qty: z.number().int().positive(),
    reason: z.enum(["nasira", "nawala", "expired", "sample", "correction"]),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((v) => (v.part_id === null) !== (v.engine_id === null), {
    message: "Pick exactly one item",
  });

export async function recordLoss(input: unknown): Promise<ActionResult> {
  const parsed = lossSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_record_loss", {
    p_part_id: parsed.data.part_id,
    p_engine_id: parsed.data.engine_id,
    p_qty: parsed.data.qty,
    p_reason: parsed.data.reason,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  return { ok: true, id: data as string };
}

/**
 * Record a payment against an utang balance. It POSTS IMMEDIATELY — the money
 * is already owed, so collecting it isn't an approval decision. The balance
 * drops at once, Admin is alerted, and it stays in the payment history.
 */
export async function recordUtangPayment(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      sale_id: z.uuid(),
      amount_centavos: z.number().int().positive(),
      note: z.string().trim().max(2000).optional().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_record_utang_payment", {
    p_sale_id: parsed.data.sale_id,
    p_amount_centavos: parsed.data.amount_centavos,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/receivables");
  revalidatePath("/shop/submissions");
  return { ok: true, id: data as string };
}

/**
 * Void a posted payment (typo/mistake). Soft-deleted so it stays in the
 * history; the balance goes straight back up and Admin is alerted.
 */
export async function voidUtangPayment(
  id: string,
  reason?: string
): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_void_utang_payment", {
    p_id: id,
    p_reason: reason?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/receivables");
  return { ok: true };
}

/**
 * Send everything the shop has recorded (sales + losses) to the owner's
 * approval queue in one batch — at the employee's chosen moment.
 * Utang payments are NOT part of this: they post on record.
 */
export async function submitShopBatch(): Promise<
  { ok: true; sales: number; losses: number } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_submit_shop_batch");
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  const counts = data as { sales: number; losses: number };
  return { ok: true, sales: counts.sales, losses: counts.losses };
}

/**
 * Confirm what physically arrived. The shop can ONLY enter counts and notes —
 * anything short simply stays in transit for the owner to decide on. There is
 * deliberately no reject/return/write-off path here.
 */
export async function confirmDelivery(input: unknown): Promise<
  { ok: true; landed: number; short: number } | { ok: false; error: string }
> {
  const parsed = z
    .object({
      delivery_id: z.uuid(),
      lines: z
        .array(
          z.object({
            line_id: z.uuid(),
            qty_received: z.number().int().min(0),
            shop_note: z.string().trim().max(500).optional().nullable(),
          })
        )
        .min(1, "Count every line"),
      note: z.string().trim().max(2000).optional().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_confirm_delivery", {
    p_delivery_id: parsed.data.delivery_id,
    p_lines: parsed.data.lines,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/deliveries");
  revalidatePath("/shop");
  const res = data as { landed: number; short: number };
  return { ok: true, landed: res.landed, short: res.short };
}

/**
 * Ask the owner to deliver stock. This is a REQUEST — it never touches stock
 * and never enters the sales approval queue; the owner converts it into a
 * real delivery through the existing flow.
 */
export async function createDeliveryRequest(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      lines: z
        .array(
          z
            .object({
              part_id: z.uuid().nullable().default(null),
              engine_model_id: z.uuid().nullable().default(null),
              qty_requested: z.number().int().positive(),
              note: z.string().trim().max(500).optional().nullable(),
            })
            .refine((l) => (l.part_id === null) !== (l.engine_model_id === null), {
              message: "Each line needs exactly one product",
            })
        )
        .min(1, "Add at least one item"),
      note: z.string().trim().max(2000).optional().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_create_delivery_request", {
    p_lines: parsed.data.lines,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/low-stock");
  return { ok: true, id: data as string };
}

/**
 * Set/clear a product photo for an item in the employee's OWN shop.
 * The DB function enforces the shop scope and locks the path to {id}.webp.
 */
export async function setShopProductImage(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      kind: z.enum(["part", "engine"]),
      id: z.uuid(),
      path: z
        .string()
        .regex(/^[0-9a-f-]{36}(-\d+)?\.webp$/)
        .nullable()
        .default(null),
      clear: z.boolean().default(false),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_set_product_image", {
    p_kind: parsed.data.kind,
    p_id: parsed.data.id,
    p_path: parsed.data.path,
    p_clear: parsed.data.clear,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop");
  revalidatePath("/shop/record-sale");
  return { ok: true };
}

/** Cancel own RECORDED or PENDING sale (RLS blocks anything else). */
export async function cancelSale(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sales")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "Only not-yet-reviewed submissions can be cancelled.",
    };
  }
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  return { ok: true };
}

/** Cancel own RECORDED or PENDING loss. */
export async function cancelLoss(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("losses")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "Only not-yet-reviewed submissions can be cancelled.",
    };
  }
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  return { ok: true };
}
