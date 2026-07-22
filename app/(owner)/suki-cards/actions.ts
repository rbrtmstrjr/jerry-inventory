"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";

type ActionResult =
  | { ok: true; id?: string; card_no?: string }
  | { ok: false; error: string };

// A Server Action doesn't inherit the layout gate — re-check the caller.
async function requireOwnerAction(): Promise<string | null> {
  const profile = await getProfile();
  if (!profile || profile.role !== "owner") return null;
  return profile.id;
}

const createSchema = z
  .object({
    customer_id: z.uuid().nullable(),
    new_customer: z
      .object({
        name: z.string().trim().min(1, "Customer name is required"),
        phone: z.string().trim().optional(),
      })
      .nullable(),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .refine((v) => (v.customer_id === null) !== (v.new_customer === null), {
    message: "Pick an existing customer or enter a new one",
  });

/** Issue a card — for an existing customer, or create the customer inline. */
export async function createDiscountCard(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: "Owner only" };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();

  let customerId = parsed.data.customer_id;
  if (!customerId && parsed.data.new_customer) {
    const { data, error } = await supabase
      .from("customers")
      .insert({
        name: parsed.data.new_customer.name,
        phone: parsed.data.new_customer.phone || null,
      })
      .select("id")
      .single();
    if (error) return { ok: false, error: error.message };
    customerId = data.id;
  }

  const { data, error } = await supabase.rpc("fn_create_discount_card", {
    p_customer_id: customerId,
    p_note: parsed.data.note ?? null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/suki-cards");
  return {
    ok: true,
    id: (data as { id: string }).id,
    card_no: (data as { card_no: string }).card_no,
  };
}

export async function setDiscountCardStatus(
  cardId: string,
  status: "active" | "inactive"
): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: "Owner only" };
  if (!z.uuid().safeParse(cardId).success) return { ok: false, error: "Invalid card" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_set_discount_card_status", {
    p_card_id: cardId,
    p_status: status,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/suki-cards");
  return { ok: true };
}

/** Lost card: deactivate the old one, mint a fresh number for the same suki. */
export async function reissueDiscountCard(cardId: string): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: "Owner only" };
  if (!z.uuid().safeParse(cardId).success) return { ok: false, error: "Invalid card" };
  const supabase = await createClient();

  const { data: card, error: readErr } = await supabase
    .from("discount_cards")
    .select("customer_id, status")
    .eq("id", cardId)
    .is("deleted_at", null)
    .single();
  if (readErr || !card) return { ok: false, error: "Card not found" };

  if (card.status === "active") {
    const { error } = await supabase.rpc("fn_set_discount_card_status", {
      p_card_id: cardId,
      p_status: "inactive",
    });
    if (error) return { ok: false, error: error.message };
  }
  const { data, error } = await supabase.rpc("fn_create_discount_card", {
    p_customer_id: card.customer_id,
    p_note: "Reissued (previous card deactivated)",
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/suki-cards");
  return {
    ok: true,
    id: (data as { id: string }).id,
    card_no: (data as { card_no: string }).card_no,
  };
}
