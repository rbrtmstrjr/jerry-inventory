"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { isPrimaryOwner } from "@/lib/auth";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Void a posted utang payment (0101) — Gerry's alone, above even the admin:
 * the person who can erase a money record must not be anyone who handles the
 * money. Soft-deleted, so the entry stays in the history struck-through, the
 * balance goes straight back up, and the office is alerted.
 *
 * fn_void_utang_payment re-checks is_primary_owner() server-side — this check
 * just turns a raw RLS error into a sentence.
 */
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
