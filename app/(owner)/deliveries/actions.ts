"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

const transferSchema = z
  .object({
    shop_id: z.uuid("Pick a shop"),
    note: z.string().trim().max(2000).optional().nullable(),
    parts: z
      .array(
        z.object({
          part_id: z.uuid(),
          qty: z.number().int().positive(),
        })
      )
      .default([]),
    engine_ids: z.array(z.uuid()).default([]),
  })
  .refine((v) => v.parts.length + v.engine_ids.length > 0, {
    message: "Add at least one line",
  });

export async function deliverStock(input: unknown): Promise<ActionResult> {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_deliver_stock", {
    p_shop_id: parsed.data.shop_id,
    p_note: parsed.data.note || null,
    p_parts: parsed.data.parts,
    p_engine_ids: parsed.data.engine_ids,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/deliveries");
  revalidatePath("/master-inventory");
  return { ok: true, id: data as string };
}

/**
 * Resolve a shortfall that's still sitting in transit — OWNER ONLY.
 * Either it's found (back to master) or it's gone (transit write-off, which
 * reports keep separate from a shop loss and from a return).
 */
export async function resolveDeliveryDiscrepancy(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      delivery_line_id: z.uuid(),
      qty: z.number().int().positive(),
      resolution: z.enum(["returned_to_master", "written_off"]),
      reason: z.string().trim().max(2000).optional().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: parsed.data.delivery_line_id,
    p_qty: parsed.data.qty,
    p_resolution: parsed.data.resolution,
    p_reason: parsed.data.reason || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/deliveries");
  revalidatePath("/master-inventory");
  revalidatePath("/reports");
  return { ok: true };
}

export async function returnStock(input: unknown): Promise<ActionResult> {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_return_stock", {
    p_shop_id: parsed.data.shop_id,
    p_reason: parsed.data.note || null,
    p_parts: parsed.data.parts,
    p_engine_ids: parsed.data.engine_ids,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/deliveries");
  revalidatePath("/master-inventory");
  return { ok: true, id: data as string };
}
