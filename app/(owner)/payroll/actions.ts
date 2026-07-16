"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

type ActionResult =
  | { ok: true; id?: string; count?: number }
  | { ok: false; error: string };

function revalidate() {
  revalidatePath("/payroll");
  revalidatePath("/payroll/staff");
  revalidatePath("/payroll/positions");
  revalidatePath("/payroll/reports");
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------
const positionSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1, "Title is required"),
  shop_id: z.uuid().nullable(), // null = global
  default_pay_rate: z.number().int().min(0).nullable(),
  active: z.boolean().default(true),
});

export async function upsertPosition(input: unknown): Promise<ActionResult> {
  const parsed = positionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  const supabase = await createClient();
  const query = id
    ? supabase.from("positions").update(fields).eq("id", id)
    : supabase.from("positions").insert(fields);
  const { error } = await query;
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function softDeletePosition(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("positions")
    .update({ deleted_at: new Date().toISOString(), active: false })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Staff
// ---------------------------------------------------------------------------
/** A government ID number is free text — agencies format them differently and
 *  a stale format rule would reject a valid number. Store what's on the card. */
const govIdSchema = z.string().trim().max(40).optional().nullable();

const staffSchema = z.object({
  id: z.uuid().optional(),
  full_name: z.string().trim().min(1, "Name is required"),
  shop_id: z.uuid("Pick a shop"),
  position_id: z.uuid().nullable(),
  pay_type: z.enum(["daily", "monthly"]),
  pay_rate: z.number().int().min(0),
  date_hired: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  active: z.boolean().default(true),
  notes: z.string().trim().max(2000).optional().nullable(),
  sss_no: govIdSchema,
  philhealth_no: govIdSchema,
  pagibig_no: govIdSchema,
  /** Casual helpers who aren't enrolled → false → zero contributions. */
  contributions_enabled: z.boolean().default(true),
});

export async function upsertStaff(input: unknown): Promise<ActionResult> {
  const parsed = staffSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  // Empty inputs mean "no number on file", not an empty string.
  const row = {
    ...fields,
    notes: fields.notes || null,
    sss_no: fields.sss_no || null,
    philhealth_no: fields.philhealth_no || null,
    pagibig_no: fields.pagibig_no || null,
  };
  const supabase = await createClient();
  const query = id
    ? supabase.from("staff").update(row).eq("id", id)
    : supabase.from("staff").insert(row);
  const { error } = await query;
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/** Soft-delete keeps all historical payroll intact. */
export async function softDeleteStaff(id: string): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("staff")
    .update({ deleted_at: new Date().toISOString(), active: false })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pay periods & entries (atomic via DB functions)
// ---------------------------------------------------------------------------
const periodSchema = z.object({
  label: z.string().trim().min(1, "Label is required"),
  start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a start date"),
  end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick an end date"),
  frequency: z.enum(["weekly", "semi_monthly", "monthly"]),
});

export async function createPayPeriod(input: unknown): Promise<ActionResult> {
  const parsed = periodSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_create_pay_period", {
    p_label: parsed.data.label,
    p_start: parsed.data.start_date,
    p_end: parsed.data.end_date,
    p_frequency: parsed.data.frequency,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true, id: data as string };
}

const daysSchema = z.object({
  period_id: z.uuid(),
  lines: z.array(
    z.object({
      entry_id: z.uuid(),
      days_worked: z.number().min(0).max(31),
    })
  ),
});

export async function savePayrollDays(input: unknown): Promise<ActionResult> {
  const parsed = daysSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_save_payroll_days", {
    p_period_id: parsed.data.period_id,
    p_lines: parsed.data.lines,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/payroll/${parsed.data.period_id}`);
  revalidate();
  return { ok: true };
}

export async function approvePayPeriod(periodId: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(periodId).success) return { ok: false, error: "Invalid period" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_approve_pay_period", {
    p_period_id: periodId,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/payroll/${periodId}`);
  revalidate();
  return { ok: true, count: data as number };
}

export async function markPayrollPaid(
  periodId: string,
  entryIds: string[] | "all"
): Promise<ActionResult> {
  if (!z.uuid().safeParse(periodId).success) return { ok: false, error: "Invalid period" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_mark_payroll_paid", {
    p_period_id: periodId,
    p_entry_ids: entryIds === "all" ? [] : entryIds,
    p_all: entryIds === "all",
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/payroll/${periodId}`);
  revalidate();
  return { ok: true, count: data as number };
}

export async function setPayPeriodStatus(
  periodId: string,
  finalize: boolean
): Promise<ActionResult> {
  if (!z.uuid().safeParse(periodId).success) return { ok: false, error: "Invalid period" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_set_pay_period_status", {
    p_period_id: periodId,
    p_finalize: finalize,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/payroll/${periodId}`);
  revalidate();
  return { ok: true };
}
