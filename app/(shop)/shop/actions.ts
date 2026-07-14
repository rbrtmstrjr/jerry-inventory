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
    engine_ids: z.array(z.uuid()).default([]),
  })
  .refine((v) => v.part_lines.length + v.engine_ids.length > 0, {
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
    p_engine_ids: parsed.data.engine_ids,
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
 * Send everything the shop has recorded (sales + losses) to the owner's
 * approval queue in one batch — at the employee's chosen moment.
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
