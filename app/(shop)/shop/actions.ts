"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

const saleSchema = z
  .object({
    customer_id: z.uuid().nullable(),
    customer: z
      .object({
        name: z.string().trim().min(1),
        phone: z.string().trim().optional(),
        address: z.string().trim().optional(),
      })
      .nullable(),
    // every line carries a negotiable per-unit price (centavos); the server
    // rejects anything priced at or below its cost
    part_lines: z
      .array(
        z.object({
          part_id: z.uuid(),
          qty: z.number().int().positive(),
          unit_price_centavos: z.number().int().positive().nullable().optional(),
        })
      )
      .default([]),
    engine_lines: z
      .array(
        z.object({
          engine_id: z.uuid(),
          agreed_price_centavos: z.number().int().positive(),
        })
      )
      .default([]),
    payment_type: z.enum(["full", "partial"]).default("full"),
    amount_paid_centavos: z.number().int().min(0).nullable().default(null),
    // how the money was tendered — same set as a shop expense's method
    payment_method: z.enum(["cash", "gcash", "bank", "other"]).default("cash"),
    // suki card (0072) — the server re-derives the card prices and clamps;
    // the client's prices are only a preview
    discount_card_id: z.uuid().nullable().default(null),
  })
  .refine((v) => v.part_lines.length + v.engine_lines.length > 0, {
    message: "Add at least one item",
  });

export async function recordSale(input: unknown): Promise<ActionResult> {
  const parsed = saleSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_record_sale", {
    p_customer_id: parsed.data.customer_id,
    p_customer: parsed.data.customer,
    p_part_lines: parsed.data.part_lines,
    p_engine_lines: parsed.data.engine_lines,
    p_payment_type: parsed.data.payment_type,
    p_amount_paid_centavos: parsed.data.amount_paid_centavos,
    p_payment_method: parsed.data.payment_method,
    p_discount_card_id: parsed.data.discount_card_id,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  return { ok: true, id: data as string };
}

export interface SukiCardInfo {
  card_id: string;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  engine_pct: number;
  part_pct: number;
}

/**
 * Resolve a scanned suki card. Goes through the guarded definer
 * fn_lookup_discount_card — the shop's ONLY window into cards: the customer +
 * the two live percentages, nothing else. Unknown/inactive → not found.
 */
export async function lookupDiscountCard(
  cardNo: unknown
): Promise<{ ok: true; card: SukiCardInfo } | { ok: false; error: string }> {
  const parsed = z.string().trim().min(1).max(40).safeParse(cardNo);
  if (!parsed.success) return { ok: false, error: "Scan or type a card number" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_lookup_discount_card", {
    p_card_no: parsed.data,
  });
  if (error) return { ok: false, error: error.message };
  const row = Array.isArray(data) ? data[0] : null;
  if (!row) {
    return { ok: false, error: "No active suki card with that number" };
  }
  return { ok: true, card: row as SukiCardInfo };
}

const lossSchema = z
  .object({
    part_id: z.uuid().nullable(),
    engine_id: z.uuid().nullable(),
    qty: z.number().int().positive(),
    reason: z.enum(["nasira", "nawala", "expired", "sample", "correction"]),
    note: z.string().trim().max(2000).optional().nullable(),
  })
  .refine((v) => (v.part_id === null) !== (v.engine_id === null), {
    message: "Pick exactly one item",
  });

export async function recordLoss(input: unknown): Promise<ActionResult> {
  const parsed = lossSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_record_loss", {
    p_part_id: parsed.data.part_id,
    p_engine_id: parsed.data.engine_id,
    p_qty: parsed.data.qty,
    p_reason: parsed.data.reason,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  return { ok: true, id: data as string };
}

/**
 * Record a payment against an utang balance. It POSTS IMMEDIATELY — the money
 * is already owed, so collecting it isn't an approval decision. The balance
 * drops at once, Admin is alerted, and it stays in the payment history.
 */
export async function recordUtangPayment(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      sale_id: z.uuid(),
      amount_centavos: z.number().int().positive(),
      method: z.enum(["cash", "gcash", "bank", "other"]),
      payer_name: z.string().trim().min(1, "The payer's name is required").max(120),
      payer_contact: z.string().trim().max(50).optional().nullable(),
      note: z.string().trim().max(2000).optional().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_record_utang_payment", {
    p_sale_id: parsed.data.sale_id,
    p_amount_centavos: parsed.data.amount_centavos,
    p_note: parsed.data.note || null,
    p_method: parsed.data.method,
    p_payer_name: parsed.data.payer_name,
    p_payer_contact: parsed.data.payer_contact || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/receivables");
  revalidatePath("/shop/submissions");
  return { ok: true, id: data as string };
}

/**
 * Void a posted payment (typo/mistake). Soft-deleted so it stays in the
 * history; the balance goes straight back up and Admin is alerted.
 */
export async function voidUtangPayment(
  id: string,
  reason?: string
): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_void_utang_payment", {
    p_id: id,
    p_reason: reason?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/receivables");
  return { ok: true };
}

const shopExpenseSchema = z
  .object({
    amount_centavos: z.number().int().positive("Amount must be positive"),
    description: z.string().trim().min(1, "A description is required").max(500),
    category_id: z.uuid().nullable().default(null),
    proposed_category: z.string().trim().max(120).optional().nullable(),
    expense_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .default(null),
    paid_to: z.string().trim().max(200).optional().nullable(),
    payment_method: z.enum(["cash", "gcash", "bank", "other"]).default("cash"),
    reference_no: z.string().trim().max(100).optional().nullable(),
    // uploaded client-side to the shop's own prefix; the RPC re-checks it
    receipt_path: z
      .string()
      .regex(/^shop-[0-9a-f-]{36}\/[0-9a-f-]{36}\.webp$/)
      .nullable()
      .default(null),
  })
  .refine((v) => (v.category_id !== null) !== !!v.proposed_category?.trim(), {
    message: "Pick a category or propose a new one",
  });

/** Record a shop expense — saves as `recorded`; rides the submission batch. */
export async function recordShopExpense(input: unknown): Promise<ActionResult> {
  const parsed = shopExpenseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_record_shop_expense", {
    p_amount_centavos: parsed.data.amount_centavos,
    p_description: parsed.data.description,
    p_category_id: parsed.data.category_id,
    p_proposed_category: parsed.data.proposed_category?.trim() || null,
    p_expense_date: parsed.data.expense_date,
    p_paid_to: parsed.data.paid_to?.trim() || null,
    p_payment_method: parsed.data.payment_method,
    p_reference_no: parsed.data.reference_no?.trim() || null,
    p_receipt_path: parsed.data.receipt_path,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/expenses");
  revalidatePath("/shop/submissions");
  return { ok: true, id: data as string };
}

/**
 * Send everything the shop has recorded (sales + losses + expenses) to the
 * owner's approval queue in one batch — at the employee's chosen moment.
 * Utang payments are NOT part of this: they post on record.
 */
export async function submitShopBatch(): Promise<
  | { ok: true; sales: number; losses: number; expenses: number }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_submit_shop_batch");
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  revalidatePath("/shop/expenses");
  const counts = data as { sales: number; losses: number; expenses: number };
  return {
    ok: true,
    sales: counts.sales,
    losses: counts.losses,
    expenses: counts.expenses ?? 0,
  };
}

/**
 * Confirm what physically arrived. The shop can ONLY enter counts and notes —
 * anything short simply stays in transit for the owner to decide on. There is
 * deliberately no reject/return/write-off path here.
 */
export async function confirmDelivery(input: unknown): Promise<
  | { ok: true; landed: number; damaged: number; missing: number; short: number }
  | { ok: false; error: string }
> {
  const parsed = z
    .object({
      delivery_id: z.uuid(),
      lines: z
        .array(
          z.object({
            line_id: z.uuid(),
            qty_received: z.number().int().min(0),
            qty_damaged: z.number().int().min(0).default(0),
            shop_note: z.string().trim().max(500).optional().nullable(),
            damage_photo_path: z.string().trim().max(400).optional().nullable(),
          })
        )
        .min(1, "Count every line"),
      note: z.string().trim().max(2000).optional().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_confirm_delivery", {
    p_delivery_id: parsed.data.delivery_id,
    p_lines: parsed.data.lines,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/deliveries");
  revalidatePath("/shop");
  const res = data as { landed: number; damaged: number; missing: number; short: number };
  return { ok: true, landed: res.landed, damaged: res.damaged, missing: res.missing, short: res.short };
}

/**
 * Ask the owner to deliver stock. This is a REQUEST — it never touches stock
 * and never enters the sales approval queue; the owner converts it into a
 * real delivery through the existing flow.
 */
export async function createDeliveryRequest(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      lines: z
        .array(
          z
            .object({
              part_id: z.uuid().nullable().default(null),
              engine_model_id: z.uuid().nullable().default(null),
              // a free-text product the shop doesn't carry yet (0077)
              custom_name: z.string().trim().min(1).max(200).nullable().default(null),
              qty_requested: z.number().int().positive(),
              note: z.string().trim().max(500).optional().nullable(),
            })
            .refine(
              (l) =>
                (l.part_id !== null ? 1 : 0) +
                  (l.engine_model_id !== null ? 1 : 0) +
                  (l.custom_name !== null ? 1 : 0) ===
                1,
              { message: "Each line needs exactly one product" }
            )
        )
        .min(1, "Add at least one item"),
      note: z.string().trim().max(2000).optional().nullable(),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_create_delivery_request", {
    p_lines: parsed.data.lines,
    p_note: parsed.data.note || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/low-stock");
  return { ok: true, id: data as string };
}

const transferSchema = z.object({
  to_shop_id: z.uuid(),
  // each line is a part (with a positive qty) XOR an engine (qty 1 implied)
  lines: z
    .array(
      z
        .object({
          part_id: z.uuid().nullable().default(null),
          engine_id: z.uuid().nullable().default(null),
          qty: z.number().int().positive().nullable().default(null),
        })
        .refine((l) => (l.part_id === null) !== (l.engine_id === null), {
          message: "Each line is a part or an engine",
        })
        .refine((l) => l.part_id === null || (l.qty ?? 0) > 0, {
          message: "Parts need a quantity",
        })
    )
    .min(1, "Add at least one item"),
  note: z.string().trim().max(2000).optional().nullable(),
});

/**
 * Request a stock transfer to another shop. This is a REQUEST — it moves no
 * stock; the owner approves it, then the destination confirms arrival exactly
 * like a master delivery. The RPC enforces destination ≠ own shop and on-hand.
 */
export async function requestTransfer(input: unknown): Promise<ActionResult> {
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_request_transfer", {
    p_to_shop_id: parsed.data.to_shop_id,
    p_lines: parsed.data.lines.map((l) =>
      l.part_id ? { part_id: l.part_id, qty: l.qty } : { engine_id: l.engine_id }
    ),
    p_note: parsed.data.note?.trim() || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/transfers");
  revalidatePath("/shop");
  return { ok: true, id: data as string };
}

/** Cancel own transfer — the RPC allows it only while status='requested'. */
export async function cancelTransfer(deliveryId: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(deliveryId).success) {
    return { ok: false, error: "Invalid id" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_cancel_transfer", {
    p_delivery_id: deliveryId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/transfers");
  revalidatePath("/shop");
  return { ok: true };
}

const returnSchema = z.object({
  reason: z.string().trim().max(500).optional().nullable(),
  parts: z
    .array(
      z.object({
        part_id: z.uuid(),
        qty_good: z.number().int().min(0).default(0),
        qty_damaged: z.number().int().min(0).default(0),
      })
    )
    .default([]),
  engines: z
    .array(
      z.object({
        engine_id: z.uuid(),
        condition: z.enum(["good", "damaged"]).default("good"),
      })
    )
    .default([]),
}).refine((v) => v.parts.length + v.engines.length > 0, {
  message: "Add at least one item to return",
});

/**
 * Request a return to Admin (this shop's stock → master). A REQUEST — moves no
 * stock; the owner approves it, which lands good units back in master and books
 * damaged as a loss. The shop picks the reason + marks damaged here.
 */
export async function requestReturn(input: unknown): Promise<ActionResult> {
  const parsed = returnSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_request_return", {
    p_reason: parsed.data.reason?.trim() || null,
    p_parts: parsed.data.parts.map((p) => ({
      part_id: p.part_id,
      qty_good: p.qty_good,
      qty_damaged: p.qty_damaged,
    })),
    p_engine_ids: parsed.data.engines,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/transfers");
  revalidatePath("/shop");
  return { ok: true, id: data as string };
}

/** Cancel own return — the RPC allows it only while status='requested'. */
export async function cancelReturn(returnId: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(returnId).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_cancel_return", { p_return_id: returnId });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop/transfers");
  return { ok: true };
}

/**
 * Set/clear a product photo for an item in the employee's OWN shop.
 * The DB function enforces the shop scope and locks the path to {id}.webp.
 */
export async function setShopProductImage(input: unknown): Promise<ActionResult> {
  const parsed = z
    .object({
      kind: z.enum(["part", "engine"]),
      id: z.uuid(),
      path: z
        .string()
        .regex(/^[0-9a-f-]{36}(-\d+)?\.webp$/)
        .nullable()
        .default(null),
      clear: z.boolean().default(false),
    })
    .safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_set_product_image", {
    p_kind: parsed.data.kind,
    p_id: parsed.data.id,
    p_path: parsed.data.path,
    p_clear: parsed.data.clear,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shop");
  revalidatePath("/shop/record-sale");
  return { ok: true };
}

/** Cancel own RECORDED or PENDING sale (RLS blocks anything else). */
export async function cancelSale(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sales")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "Only not-yet-reviewed submissions can be cancelled.",
    };
  }
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  return { ok: true };
}

/** Cancel own RECORDED or PENDING loss. */
export async function cancelLoss(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("losses")
    .delete()
    .eq("id", id)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data || data.length === 0) {
    return {
      ok: false,
      error: "Only not-yet-reviewed submissions can be cancelled.",
    };
  }
  revalidatePath("/shop");
  revalidatePath("/shop/submissions");
  return { ok: true };
}
