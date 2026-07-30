"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

/** Approve or reject a shop-filed warranty claim. Approval runs the resolution. */
export async function reviewWarrantyClaim(
  claimId: string,
  action: "approve" | "reject",
  note?: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } =
    action === "approve"
      ? await supabase.rpc("fn_approve_warranty_claim", { p_claim_id: claimId })
      : await supabase.rpc("fn_reject_warranty_claim", {
          p_claim_id: claimId,
          p_note: note ?? "",
        });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/warranties");
  return { ok: true };
}

/** Record / correct the PHYSICAL warranty card's number (0103). The office can
 *  set it for any warranty; the RPC enforces uniqueness across cards. */
export async function setWarrantySerial(
  warrantyId: string,
  serial: string
): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_set_warranty_serial", {
    p_warranty_id: warrantyId,
    p_serial: serial,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/warranties");
  return { ok: true };
}
