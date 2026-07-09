"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult =
  | { ok: true; id?: string; created?: number }
  | { ok: false; error: string };

export async function createCountSnapshot(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({ shop_id: z.uuid("Pick a shop"), note: z.string().trim().max(500).optional() })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_create_count_snapshot", {
    p_shop_id: parsed.data.shop_id,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/counts");
  return { ok: true, id: data as string };
}

const saveSchema = z.object({
  snapshot_id: z.uuid(),
  lines: z.array(
    z.object({
      line_id: z.uuid(),
      counted_qty: z.number().int().min(0).nullable(),
    })
  ),
});

export async function saveCount(input: unknown): Promise<ActionResult> {
  const parsed = saveSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_save_count", {
    p_snapshot_id: parsed.data.snapshot_id,
    p_lines: parsed.data.lines,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/counts/${parsed.data.snapshot_id}`);
  revalidatePath("/counts");
  return { ok: true };
}

const shortagesSchema = z.object({
  snapshot_id: z.uuid(),
  lines: z.array(
    z.object({
      line_id: z.uuid(),
      reason: z.enum(["nasira", "nawala", "expired", "correction"]),
    })
  ),
});

export async function recordCountShortages(input: unknown): Promise<ActionResult> {
  const parsed = shortagesSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_record_count_shortages", {
    p_snapshot_id: parsed.data.snapshot_id,
    p_lines: parsed.data.lines,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/counts/${parsed.data.snapshot_id}`);
  revalidatePath("/approvals");
  return { ok: true, created: data as number };
}
