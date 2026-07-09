"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

const settingsSchema = z.object({
  business_name: z.string().trim().min(1, "Business name is required"),
  address: z.string().trim().max(300).optional().nullable(),
  phone: z.string().trim().max(50).optional().nullable(),
  receipt_footer: z.string().trim().max(500).optional().nullable(),
  default_warranty_months: z.number().int().min(0).max(120),
});

export async function updateSettings(input: unknown): Promise<ActionResult> {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("settings")
    .update({
      ...parsed.data,
      address: parsed.data.address || null,
      phone: parsed.data.phone || null,
      receipt_footer: parsed.data.receipt_footer || null,
    })
    .eq("id", 1);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/settings");
  return { ok: true };
}
