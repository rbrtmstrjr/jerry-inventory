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
