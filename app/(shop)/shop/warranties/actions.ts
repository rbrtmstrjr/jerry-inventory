"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

const claimSchema = z
  .object({
    warranty_id: z.uuid(),
    issue: z.string().trim().min(1, "Describe the issue").max(2000),
    resolution: z.enum(["repair", "replace", "refund"]),
    replacement_engine_id: z.uuid().optional().nullable(),
    refund_centavos: z.number().int().positive().optional().nullable(),
  })
  .refine((v) => v.resolution !== "replace" || !!v.replacement_engine_id, {
    message: "Pick a replacement engine",
    path: ["replacement_engine_id"],
  })
  .refine((v) => v.resolution !== "refund" || !!v.refund_centavos, {
    message: "Enter the refund amount",
    path: ["refund_centavos"],
  });

/** Shop files a warranty claim — it waits for Admin approval before anything moves. */
export async function requestWarrantyClaim(input: unknown): Promise<ActionResult> {
  const parsed = claimSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_request_warranty_claim", {
    p_warranty_id: parsed.data.warranty_id,
    p_issue: parsed.data.issue,
    p_resolution: parsed.data.resolution,
    p_replacement_engine_id: parsed.data.replacement_engine_id ?? null,
    p_refund_centavos: parsed.data.refund_centavos ?? null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/warranties");
  return { ok: true };
}

export async function cancelWarrantyClaim(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_cancel_warranty_claim", { p_claim_id: id });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/warranties");
  return { ok: true };
}

/**
 * Record / correct the PHYSICAL warranty card's number (0103). The card is
 * printed by Gerwin's external system — the app only remembers which card
 * went with which engine sale. fn_set_warranty_serial re-checks the caller
 * is the selling shop (or the office) and enforces uniqueness across cards.
 */
export async function setWarrantySerial(
  warrantyId: string,
  serial: string
): Promise<ActionResult> {
  if (!z.uuid().safeParse(warrantyId).success) return { ok: false, error: "Invalid warranty" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_set_warranty_serial", {
    p_warranty_id: warrantyId,
    p_serial: serial,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/warranties");
  return { ok: true };
}
