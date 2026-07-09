"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

const claimSchema = z.object({
  warranty_id: z.uuid(),
  claim_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
  issue: z.string().trim().min(1, "Describe the issue"),
  action_taken: z.string().trim().max(2000).optional().nullable(),
});

export async function addClaim(input: unknown): Promise<ActionResult> {
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.from("warranty_claims").insert({
    warranty_id: parsed.data.warranty_id,
    claim_date: parsed.data.claim_date,
    issue: parsed.data.issue,
    action_taken: parsed.data.action_taken || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/warranties");
  return { ok: true };
}
