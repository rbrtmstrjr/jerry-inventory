"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isPrimaryOwner } from "@/lib/auth";

type ActionResult = { ok: true } | { ok: false; error: string };

/** Gerry-only: whoever handles the cash must not be able to erase its record.
 *  Soft-deletes, so the entry stays struck-through. The RPC re-checks. */
export async function voidUtangPayment(
  id: string,
  reason?: string
): Promise<ActionResult> {
  if (!(await isPrimaryOwner()))
    return { ok: false, error: "Only the owner can void a payment" };
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };

  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_void_utang_payment", {
    p_id: id,
    p_reason: reason?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath("/receivables");
  return { ok: true };
}
