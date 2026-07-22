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
