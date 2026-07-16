"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/approvals");
  revalidatePath("/dashboard");
  revalidatePath("/master-inventory");
  revalidatePath("/receivables");
}

export async function approveSale(id: string, note?: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_approve_sale", {
    p_sale_id: id,
    p_note: note?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/** Approve every pending item in a shop's batch in one shot. */
export async function approveBatch(
  id: string,
  note?: string
): Promise<{ ok: true; sales: number; losses: number } | { ok: false; error: string }> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_approve_batch", {
    p_batch_id: id,
    p_note: note?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  const counts = data as { sales: number; losses: number };
  return { ok: true, sales: counts.sales, losses: counts.losses };
}

export async function approveLoss(id: string, note?: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_approve_loss", {
    p_loss_id: id,
    p_note: note?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

const reviewSchema = z.object({
  kind: z.enum(["sale", "loss"]),
  id: z.uuid(),
  action: z.enum(["question", "reject"]),
  note: z.string().trim().max(2000),
});

export async function reviewSubmission(input: unknown): Promise<ActionResult> {
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_review_submission", {
    p_kind: parsed.data.kind,
    p_id: parsed.data.id,
    p_action: parsed.data.action,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}
