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
      resolution: z.enum(["returned_to_master", "returned_to_source", "written_off"]),
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

/**
 * Approve or reject a shop-to-shop transfer — OWNER ONLY. Approve debits the
 * source shop into transit; reject requires a note the source shop will see.
 */
export async function approveTransfer(
  deliveryId: string,
  action: "approve" | "reject",
  note?: string | null
): Promise<ActionResult> {
  const parsed = z
    .object({
      delivery_id: z.uuid(),
      action: z.enum(["approve", "reject"]),
      note: z.string().trim().max(2000).optional().nullable(),
    })
    .safeParse({ delivery_id: deliveryId, action, note });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (parsed.data.action === "reject" && !parsed.data.note) {
    return { ok: false, error: "A rejection needs a note for the shop" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_approve_transfer", {
    p_delivery_id: parsed.data.delivery_id,
    p_action: parsed.data.action,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/deliveries");
  return { ok: true };
}

/**
 * Approve or reject a shop's RETURN request (0065). Approve lands good units
 * back in master + books damaged as an approved loss at cost; reject needs a
 * note. No transit step — the owner is the receiver.
 */
export async function reviewReturn(
  returnId: string,
  action: "approve" | "reject",
  note?: string | null
): Promise<ActionResult> {
  const parsed = z
    .object({
      return_id: z.uuid(),
      action: z.enum(["approve", "reject"]),
      note: z.string().trim().max(2000).optional().nullable(),
    })
    .safeParse({ return_id: returnId, action, note });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (parsed.data.action === "reject" && !parsed.data.note) {
    return { ok: false, error: "A rejection needs a note for the shop" };
  }
  const supabase = await createClient();
  const { error } =
    parsed.data.action === "approve"
      ? await supabase.rpc("fn_approve_return", { p_return_id: parsed.data.return_id })
      : await supabase.rpc("fn_reject_return", {
          p_return_id: parsed.data.return_id,
          p_note: parsed.data.note,
        });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/deliveries");
  return { ok: true };
}

// Returns are INSPECTED (0058): good → master, damaged → approved loss @cost.
const returnSchema = z
  .object({
    shop_id: z.uuid("Pick a shop"),
    note: z.string().trim().max(2000).optional().nullable(),
    parts: z
      .array(
        z.object({
          part_id: z.uuid(),
          qty_good: z.number().int().min(0).default(0),
          qty_damaged: z.number().int().min(0).default(0),
          damage_note: z.string().trim().max(500).optional().nullable(),
        })
      )
      .default([]),
    engines: z
      .array(
        z.object({
          engine_id: z.uuid(),
          condition: z.enum(["good", "damaged"]).default("good"),
          damage_note: z.string().trim().max(500).optional().nullable(),
        })
      )
      .default([]),
  })
  .refine((v) => v.parts.length + v.engines.length > 0, {
    message: "Add at least one line",
  });

export async function returnStock(input: unknown): Promise<ActionResult> {
  const parsed = returnSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_return_stock", {
    p_shop_id: parsed.data.shop_id,
    p_reason: parsed.data.note || null,
    p_parts: parsed.data.parts.map((p) => ({
      part_id: p.part_id,
      qty_good: p.qty_good,
      qty_damaged: p.qty_damaged,
      note: p.damage_note ?? null,
    })),
    p_engine_ids: parsed.data.engines.map((e) => ({
      engine_id: e.engine_id,
      condition: e.condition,
      note: e.damage_note ?? null,
    })),
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/deliveries");
  revalidatePath("/master-inventory");
  return { ok: true, id: data as string };
}
