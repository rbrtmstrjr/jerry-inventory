"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true } | { ok: false; error: string };

// Requests live on Stock Alerts now; fulfilling one still creates a delivery,
// so both pages (and the shop's low-stock history) must refresh.
function revalidate() {
  revalidatePath("/stock-alerts");
  revalidatePath("/deliveries");
  revalidatePath("/shop/low-stock");
}

/** Link a request to the delivery just made through the EXISTING delivery flow. */
export async function fulfillDeliveryRequest(
  requestId: string,
  deliveryId: string
): Promise<ActionResult> {
  const parsed = z
    .object({ requestId: z.uuid(), deliveryId: z.uuid() })
    .safeParse({ requestId, deliveryId });
  if (!parsed.success) return { ok: false, error: "Invalid id" };

  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_fulfill_delivery_request", {
    p_request_id: parsed.data.requestId,
    p_delivery_id: parsed.data.deliveryId,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function dismissDeliveryRequest(
  id: string,
  reason?: string
): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_dismiss_delivery_request", {
    p_request_id: id,
    p_reason: reason?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}
