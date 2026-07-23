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
  revalidatePath("/payroll/advances");
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
  birthday: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  image_path: z.string().nullable(),
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
  // whether THIS run withholds gov benefits — semi-monthly only (null = the
  // legacy date/split behavior; monthly/weekly stay null)
  deduct_contributions: z.boolean().nullable().default(null),
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
    p_deduct_contributions: parsed.data.deduct_contributions,
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

// ---------------------------------------------------------------------------
// Vale / cash advances
// ---------------------------------------------------------------------------
const advanceSchema = z.object({
  staff_id: z.uuid(),
  amount_centavos: z.number().int().positive("Enter an amount"),
  note: z.string().trim().max(2000).optional().nullable(),
  advance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

/** Record a cash advance (vale) a staffer took — builds their running balance. */
export async function recordStaffAdvance(input: unknown): Promise<ActionResult> {
  const parsed = advanceSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_record_staff_advance", {
    p_staff_id: parsed.data.staff_id,
    p_amount_centavos: parsed.data.amount_centavos,
    p_note: parsed.data.note || null,
    p_date: parsed.data.advance_date || null,
  });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

export async function voidStaffAdvance(id: string): Promise<ActionResult> {
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid advance" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_void_staff_advance", { p_id: id });
  if (error) return { ok: false, error: error.message };
  revalidate();
  return { ok: true };
}

/** Set the vale deducted on one payslip. Server caps it to available net + the
 *  outstanding balance and returns the amount actually applied. */
export async function savePayrollVale(
  entryId: string,
  periodId: string,
  requestedCentavos: number
): Promise<ActionResult> {
  if (!z.uuid().safeParse(entryId).success) return { ok: false, error: "Invalid entry" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_save_payroll_vale", {
    p_entry_id: entryId,
    p_requested_centavos: Math.max(0, Math.round(requestedCentavos)),
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/payroll/${periodId}`);
  revalidate();
  return { ok: true, count: data as number };
}

/** Override the three government employee-share amounts (centavos) on one
 *  payslip — for enrolled staff on probation, typically ₱0. A present agency is
 *  overridden; net recomputes as gross − Σee − vale. */
export async function saveEntryContributions(
  entryId: string,
  periodId: string,
  amounts: { sss?: number; philhealth?: number; pagibig?: number }
): Promise<ActionResult> {
  const parsed = z
    .object({
      sss: z.number().int().min(0).optional(),
      philhealth: z.number().int().min(0).optional(),
      pagibig: z.number().int().min(0).optional(),
    })
    .safeParse(amounts);
  if (!z.uuid().safeParse(entryId).success) return { ok: false, error: "Invalid entry" };
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid amounts" };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fn_save_entry_contributions", {
    p_entry_id: entryId,
    p_amounts: parsed.data,
  });
  if (error) return { ok: false, error: error.message };
  revalidatePath(`/payroll/${periodId}`);
  revalidate();
  return { ok: true };
}
