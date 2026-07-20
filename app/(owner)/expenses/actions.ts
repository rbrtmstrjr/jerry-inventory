"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

function revalidate() {
  revalidatePath("/expenses");
  revalidatePath("/expenses/categories");
  revalidatePath("/expenses/reports");
  revalidatePath("/approvals");
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
/** Shop claims not yet approved belong to the approval flow, never edited here. */
async function assertEditable(
  supabase: Awaited<ReturnType<typeof createClient>>,
  id: string
): Promise<string | null> {
  const { data } = await supabase
    .from("expenses")
    .select("source, status")
    .eq("id", id)
    .single();
  if (!data) return "Expense not found";
  if (data.source === "shop" && data.status !== "approved") {
    return "This shop claim is under review — decide it on the Approval Queue";
  }
  return null;
}

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

  if (id) {
    const blocked = await assertEditable(supabase, id);
    if (blocked) return { ok: false, error: blocked };
  }

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

  const blocked = await assertEditable(supabase, id);
  if (blocked) return { ok: false, error: blocked };

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

// ---------------------------------------------------------------------------
// Shop-proposed categories (status='proposed') — owner-only direct updates
// ---------------------------------------------------------------------------

/** Activate a proposal, optionally renaming it first ("Rename" = rename+approve). */
export async function approveProposedCategory(
  id: string,
  newName?: string
): Promise<ActionResult> {
  const parsed = z
    .object({ id: z.uuid(), name: z.string().trim().min(1).optional() })
    .safeParse({ id, name: newName?.trim() || undefined });
  if (!parsed.success) return { ok: false, error: "Invalid input" };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("expense_categories")
    .update({
      status: "active",
      ...(parsed.data.name ? { name: parsed.data.name } : {}),
    })
    .eq("id", parsed.data.id)
    .eq("status", "proposed")
    .is("deleted_at", null)
    .select("id");
  if (error) return { ok: false, error: error.message };
  if (!data?.length) return { ok: false, error: "Proposal not found" };
  revalidate();
  return { ok: true };
}

/** Move the proposal's expenses into an existing active category, then retire it. */
export async function mergeProposedCategory(
  proposalId: string,
  targetId: string
): Promise<ActionResult> {
  const parsed = z
    .object({ proposalId: z.uuid(), targetId: z.uuid() })
    .safeParse({ proposalId, targetId });
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  if (parsed.data.proposalId === parsed.data.targetId) {
    return { ok: false, error: "Pick a different category to merge into" };
  }

  const supabase = await createClient();
  const { data: target } = await supabase
    .from("expense_categories")
    .select("id")
    .eq("id", parsed.data.targetId)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();
  if (!target) return { ok: false, error: "Target category not found or not active" };

  const { error: moveError } = await supabase
    .from("expenses")
    .update({ category_id: parsed.data.targetId })
    .eq("category_id", parsed.data.proposalId)
    .is("deleted_at", null);
  if (moveError) return { ok: false, error: moveError.message };

  const { error } = await supabase
    .from("expense_categories")
    .update({ deleted_at: new Date().toISOString(), active: false })
    .eq("id", parsed.data.proposalId)
    .eq("status", "proposed");
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/** Dismiss a proposal — only when no non-rejected expense still references it. */
export async function dismissProposedCategory(id: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid id" };
  const supabase = await createClient();

  const { count } = await supabase
    .from("expenses")
    .select("id", { count: "exact", head: true })
    .eq("category_id", id)
    .neq("status", "rejected")
    .is("deleted_at", null);
  if ((count ?? 0) > 0) {
    return {
      ok: false,
      error: `${count} expense(s) still use this proposal — merge it into an existing category instead`,
    };
  }

  const { error } = await supabase
    .from("expense_categories")
    .update({ deleted_at: new Date().toISOString(), active: false })
    .eq("id", id)
    .eq("status", "proposed");
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}
