"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/expenses");
  revalidatePath("/expenses/categories");
  revalidatePath("/expenses/reports");
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
const expenseSchema = z
  .object({
    id: z.uuid().optional(),
    category_id: z.uuid("Pick a category"),
    amount: z.number().int().positive("Amount must be more than ₱0"),
    expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
    scope: z.enum(["shop", "company"]),
    shop_id: z.uuid().nullable(),
    delivery_id: z.uuid().nullable(),
    description: z.string().trim().min(1, "Describe the expense"),
    paid_to: z.string().trim().max(200).optional().nullable(),
    payment_method: z.enum(["cash", "gcash", "bank", "other"]),
    reference_no: z.string().trim().max(100).optional().nullable(),
  })
  .refine((v) => (v.scope === "shop" ? !!v.shop_id : v.shop_id === null), {
    message: "Shop-scoped expenses need a shop; company-wide must not have one",
  });

export async function upsertExpense(input: unknown): Promise<ActionResult> {
  const parsed = expenseSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const row = {
    ...fields,
    paid_to: fields.paid_to || null,
    reference_no: fields.reference_no || null,
    ...(id ? {} : { recorded_by: user?.id ?? null }),
  };

  const query = id
    ? supabase.from("expenses").update(row).eq("id", id).select("id").single()
    : supabase.from("expenses").insert(row).select("id").single();
  const { data, error } = await query;
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true, id: data.id };
}

/** Void (soft-delete) an expense — history stays queryable if ever needed. */
export async function voidExpense(id: string): Promise<ActionResult> {
  const supabase = await createClient();

  const { data: exp } = await supabase
    .from("expenses")
    .select("receipt_image_path")
    .eq("id", id)
    .single();

  const { error } = await supabase
    .from("expenses")
    .update({ deleted_at: new Date().toISOString(), receipt_image_path: null })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  if (exp?.receipt_image_path) {
    await supabase.storage.from("receipts").remove([exp.receipt_image_path]);
  }
  revalidate();
  return { ok: true };
}

/** Set/clear the receipt path (object managed client-side by owner). */
export async function setExpenseReceipt(
  id: string,
  path: string | null
): Promise<ActionResult> {
  const parsed = z
    .object({ id: z.uuid(), path: z.string().regex(/^[\w.\-\/]+$/).nullable() })
    .safeParse({ id, path });
  if (!parsed.success) return { ok: false, error: "Invalid receipt path" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("expenses")
    .update({ receipt_image_path: parsed.data.path })
    .eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------
const categorySchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Name is required"),
  sort_order: z.number().int().min(0).default(100),
  active: z.boolean().default(true),
});

export async function upsertExpenseCategory(input: unknown): Promise<ActionResult> {
  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  const supabase = await createClient();
  const query = id
    ? supabase.from("expense_categories").update(fields).eq("id", id)
    : supabase.from("expense_categories").insert(fields);
  const { error } = await query;
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function softDeleteExpenseCategory(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("expense_categories")
    .update({ deleted_at: new Date().toISOString(), active: false })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}
