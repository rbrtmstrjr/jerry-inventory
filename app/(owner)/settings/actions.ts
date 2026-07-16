"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { AGENCY_LABEL } from "@/lib/contributions";
import { formatCentavos } from "@/lib/format";
import type { ResolvedContribution } from "@/lib/db-types";

type ActionResult = { ok: true } | { ok: false; error: string };

/**
 * Re-verify the owner in the action itself.
 *
 * RLS already refuses a non-owner write, so this is belt to its braces — but a
 * Server Action is an independently addressable POST endpoint and does NOT
 * inherit the (owner) layout's gate. /shops/actions.ts makes the same call for
 * the same reason. The payoff is also a sentence instead of a raw Postgres RLS
 * error.
 */
async function requireOwnerAction(): Promise<boolean> {
  const profile = await getProfile();
  return profile?.role === "owner";
}

const DENIED = "Only the owner can change settings." as const;

/**
 * Every document that prints business identity.
 *
 * These are all dynamic (they read cookies), so nothing is statically cached
 * and this is mostly belt-and-braces — but the moment one of them gains a cache
 * hint, a stale letterhead is exactly the bug nobody thinks to look for.
 * Dynamic routes need the literal segment pattern, not a filled-in path.
 */
function revalidateDocuments() {
  revalidatePath("/settings");
  revalidatePath("/receipt/[saleId]", "page");
  revalidatePath("/deliveries/[id]/note", "page");
  revalidatePath("/warranties/[id]/certificate", "page");
  revalidatePath("/shop/warranties/[id]/certificate", "page");
  revalidatePath("/payroll/payslip/[entryId]", "page");
  revalidatePath("/counts/[id]/sheet", "page");
  revalidatePath("/stock-alerts/purchase-list");
}

// ---------------------------------------------------------------------------
// Business identity — everything here lands on printed paper.
//
// Note `address` / `phone` / `receipt_footer`, NOT business_address /
// business_contact. Those columns have existed since 0001 and are already read
// by the receipt, delivery note, certificate and payslip; a second pair under
// new names would be two columns holding one fact, with the documents reading
// the old ones.
// ---------------------------------------------------------------------------
const businessSettingsSchema = z.object({
  business_name: z.string().trim().min(1, "Business name is required"),
  address: z.string().trim().max(300).nullable(),
  phone: z.string().trim().max(50).nullable(),
  business_email: z.email("Enter a valid business email").max(200).nullable(),
  business_tin: z.string().trim().max(50).nullable(),
  receipt_footer: z.string().trim().max(500).nullable(),
});

export async function updateBusinessSettings(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: DENIED };

  const parsed = businessSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("settings")
    .update({
      business_name: parsed.data.business_name,
      address: parsed.data.address || null,
      phone: parsed.data.phone || null,
      business_email: parsed.data.business_email || null,
      business_tin: parsed.data.business_tin || null,
      receipt_footer: parsed.data.receipt_footer || null,
    })
    .eq("id", 1);
  if (error) return { ok: false, error: error.message };

  revalidateDocuments();
  return { ok: true };
}

const defaultsSchema = z.object({
  default_warranty_months: z.number().int().min(0).max(120),
});

export async function updateDefaults(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: DENIED };

  const parsed = defaultsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.from("settings").update(parsed.data).eq("id", 1);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Alert thresholds.
//
// Both mirror their settings CHECK constraint; the DB stays the authority.
// `warranty_expiry_alert_days` has no upper bound in the DB, so 365 is a UI
// sanity bound only — 0 stays legal because it means something (alert on the
// day of expiry), and banning a value the DB accepts would be this form
// inventing a rule.
// ---------------------------------------------------------------------------
const alertSettingsSchema = z.object({
  warranty_expiry_alert_days: z
    .number()
    .int()
    .min(0, "Lead time cannot be negative")
    .max(365, "Lead time must be 365 days or less"),
  supplier_limit_warn_pct: z
    .number()
    .int()
    .min(1, "Warning percent must be between 1 and 100")
    .max(100, "Warning percent must be between 1 and 100"),
  // Deliberately absent from the original Settings overhaul: no quotes feature
  // existed and a dial that controls nothing is decoration. 0046 built the
  // feature, so the dial and its editor arrived together. 1..365 mirrors the
  // settings CHECK.
  quote_stale_days: z
    .number()
    .int()
    .min(1, "Staleness must be between 1 and 365 days")
    .max(365, "Staleness must be between 1 and 365 days"),
});

export async function updateAlertSettings(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: DENIED };

  const parsed = alertSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.from("settings").update(parsed.data).eq("id", 1);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/settings");
  // The thresholds change who gets warned and when, on pages that read them.
  revalidatePath("/suppliers");
  revalidatePath("/warranties");
  return { ok: true };
}

// ===========================================================================
// Government contribution rates — the rate book.
//
// RATES ARE DATA. Nothing below carries a rate, bracket, MSC, floor, ceiling
// or percentage as a literal: every value is either the owner's input or a row
// read back from `contribution_brackets`. A new circular is a data edit here,
// never a redeploy.
//
// The zod schemas mirror the table's CHECK constraints so a bad row is
// rejected with a sentence instead of a Postgres error — but the DB stays the
// authority. Anything only the DB can know (the exclusion constraint, numeric
// precision) is caught on the way back out by describeBracketError().
// ===========================================================================

const agencyEnum = z.enum(["sss", "philhealth", "pagibig"]);
const basisEnum = z.enum(["msc_bracket", "percent_of_salary", "fixed"]);

/**
 * A percentage — numeric(6,3), NOT money. The DB's only bound is `>= 0`, so
 * that is the only bound here: an upper limit would be this code inventing a
 * rate ceiling of its own, which is exactly what the feature forbids.
 */
const percent = z.number().min(0, "A percent cannot be negative");
const centavos = z.number().int().min(0, "Amount cannot be negative");

const bracketSchema = z
  .object({
    id: z.uuid().optional(),
    agency: agencyEnum,
    effective_from: z.iso.date("Enter an effective-from date"),
    effective_to: z.iso.date().nullable(),
    salary_min_centavos: centavos,
    salary_max_centavos: centavos.nullable(),
    basis: basisEnum,
    credited_salary_centavos: centavos.nullable(),
    ee_percent: percent,
    er_percent: percent,
    basis_floor_centavos: centavos.nullable(),
    basis_ceiling_centavos: centavos.nullable(),
    er_extra_centavos: centavos,
    ee_amount_centavos: centavos.nullable(),
    er_amount_centavos: centavos.nullable(),
    note: z.string().trim().max(300).nullable(),
    source_ref: z.string().trim().max(300).nullable(),
  })
  // mirrors constraint bracket_date_range
  .refine((d) => d.effective_to === null || d.effective_to >= d.effective_from, {
    message: "Effective-to must be on or after effective-from",
    path: ["effective_to"],
  })
  // mirrors constraint bracket_salary_range
  .refine(
    (d) => d.salary_max_centavos === null || d.salary_max_centavos >= d.salary_min_centavos,
    {
      message: "The salary maximum must be at or above the minimum",
      path: ["salary_max_centavos"],
    }
  )
  // mirrors constraint bracket_msc_only_for_sss
  .refine((d) => d.credited_salary_centavos === null || d.basis === "msc_bracket", {
    message: "A credited salary (MSC) only belongs on an MSC-bracket row",
    path: ["credited_salary_centavos"],
  })
  // mirrors constraint bracket_msc_has_credited
  .refine((d) => d.basis !== "msc_bracket" || d.credited_salary_centavos !== null, {
    message: "An MSC-bracket row needs its credited salary (MSC)",
    path: ["credited_salary_centavos"],
  })
  // mirrors constraint bracket_fixed_has_amounts
  .refine(
    (d) =>
      d.basis !== "fixed" || (d.ee_amount_centavos !== null && d.er_amount_centavos !== null),
    {
      message: "A fixed row needs both an employee and an employer amount",
      path: ["ee_amount_centavos"],
    }
  );

type DbError = { code?: string; message?: string; details?: string | null };

/**
 * Turn a Postgres constraint violation into something an owner can act on.
 *
 * The headline case is `contribution_brackets_no_overlap` — a GiST exclusion
 * constraint that refuses to let two live rows for one agency cover the same
 * salary on the same day. That constraint is what makes a contribution
 * unambiguous, so the message names the remedy (effective-date the old row
 * out) instead of dumping "conflicting key value violates exclusion
 * constraint on relation".
 */
function describeBracketError(error: DbError): string {
  const blob = `${error.message ?? ""} ${error.details ?? ""}`;

  if (error.code === "23P01" || blob.includes("contribution_brackets_no_overlap")) {
    return (
      "Overlapping rate. Another live row for this agency already covers part of " +
      "this salary range on these dates, and two rows must never both match the " +
      "same salary on the same day. Either narrow the salary range, or — if this " +
      "is a new circular — set the outgoing rows' effective-to date to the day " +
      "before this one starts. The New circular button does that closing step for you."
    );
  }
  if (blob.includes("bracket_msc_has_credited")) {
    return "An MSC-bracket row needs its credited salary (MSC).";
  }
  if (blob.includes("bracket_msc_only_for_sss")) {
    return "A credited salary (MSC) only belongs on an MSC-bracket row.";
  }
  if (blob.includes("bracket_fixed_has_amounts")) {
    return "A fixed row needs both an employee and an employer amount.";
  }
  if (blob.includes("bracket_date_range")) {
    return "Effective-to must be on or after effective-from.";
  }
  if (blob.includes("bracket_salary_range")) {
    return "The salary maximum must be at or above the minimum.";
  }
  if (error.code === "22003") {
    return "That percent is out of range — the rate book stores up to 3 decimal places.";
  }
  return error.message || "Could not save the rate.";
}

export async function upsertContributionBracket(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: DENIED };

  const parsed = bracketSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...row } = parsed.data;

  const supabase = await createClient();
  const { error } = id
    ? await supabase.from("contribution_brackets").update(row).eq("id", id)
    : await supabase.from("contribution_brackets").insert(row);
  if (error) return { ok: false, error: describeBracketError(error) };

  revalidatePath("/settings");
  return { ok: true };
}

/** Soft-delete, like everything else here — the row stays for audit. */
export async function softDeleteContributionBracket(id: string): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: DENIED };

  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) return { ok: false, error: "Invalid id" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("contribution_brackets")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", parsed.data);
  if (error) return { ok: false, error: describeBracketError(error) };

  revalidatePath("/settings");
  return { ok: true };
}

/** The day before an ISO date, in UTC so no timezone can shift it. */
function previousDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const newCircularSchema = z.object({
  agency: agencyEnum,
  effective_from: z.iso.date("Enter the date the new circular takes effect"),
  source_ref: z.string().trim().min(1, "Cite the circular this comes from").max(300),
  /** null = keep each copied row's own percent. Never defaulted to a number. */
  ee_percent: percent.nullable(),
  er_percent: percent.nullable(),
});

/**
 * A new circular, the way the agencies actually issue one: close the current
 * rows out on the day before the new rates start, then copy them forward as a
 * new effective-dated set. History is never edited and never deleted — that is
 * the whole point of effective-dating, and it is why SSS's 61 rows are one
 * dialog instead of 61 forms.
 *
 * Order matters: the outgoing rows must be closed BEFORE the new ones are
 * inserted, or the exclusion constraint (rightly) rejects the insert. There is
 * no RPC to wrap both in one transaction, so a failed insert is compensated by
 * reopening exactly the rows we closed — the owner is never left holding a
 * superseded rate book with no replacement.
 */
export async function startNewCircular(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: DENIED };

  const parsed = newCircularSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { agency, effective_from, source_ref, ee_percent, er_percent } = parsed.data;
  const closeOn = previousDay(effective_from);

  const supabase = await createClient();
  const { data: live, error: readErr } = await supabase
    .from("contribution_brackets")
    .select(
      `id, agency, effective_from, effective_to, salary_min_centavos, salary_max_centavos,
       basis, credited_salary_centavos, ee_percent, er_percent, basis_floor_centavos,
       basis_ceiling_centavos, er_extra_centavos, ee_amount_centavos, er_amount_centavos, note`
    )
    .eq("agency", agency)
    .is("deleted_at", null);
  if (readErr) return { ok: false, error: readErr.message };

  const open = (live ?? []).filter((r) => r.effective_to === null);
  if (open.length === 0) {
    return {
      ok: false,
      error: "There are no current rates for this agency to supersede. Add the first row instead.",
    };
  }

  const tooLate = open.find((r) => r.effective_from >= effective_from);
  if (tooLate) {
    return {
      ok: false,
      error:
        `The current rates already start on ${tooLate.effective_from}. A new circular has to ` +
        `take effect after that date, so the outgoing rows can be closed the day before.`,
    };
  }

  // A closed set reaching past the new start date would still overlap. Rare, and
  // safer to stop than to guess which set the owner meant to supersede.
  const straddles = (live ?? []).find(
    (r) => r.effective_to !== null && r.effective_to >= effective_from
  );
  if (straddles) {
    return {
      ok: false,
      error:
        `A rate set for this agency already runs to ${straddles.effective_to}, past the new ` +
        `start date. Adjust that set's effective-to date first, then start the circular.`,
    };
  }

  const openIds = open.map((r) => r.id);
  const { error: closeErr } = await supabase
    .from("contribution_brackets")
    .update({ effective_to: closeOn })
    .in("id", openIds);
  if (closeErr) return { ok: false, error: describeBracketError(closeErr) };

  const copies = open.map((r) => ({
    agency: r.agency,
    effective_from,
    effective_to: null,
    salary_min_centavos: r.salary_min_centavos,
    salary_max_centavos: r.salary_max_centavos,
    basis: r.basis,
    credited_salary_centavos: r.credited_salary_centavos,
    // null = carry the outgoing row's own rate forward, unchanged
    ee_percent: ee_percent ?? r.ee_percent,
    er_percent: er_percent ?? r.er_percent,
    basis_floor_centavos: r.basis_floor_centavos,
    basis_ceiling_centavos: r.basis_ceiling_centavos,
    er_extra_centavos: r.er_extra_centavos,
    ee_amount_centavos: r.ee_amount_centavos,
    er_amount_centavos: r.er_amount_centavos,
    note: r.note,
    source_ref,
  }));

  const { error: insertErr } = await supabase.from("contribution_brackets").insert(copies);
  if (insertErr) {
    // Compensate: reopen exactly what we closed, so a failure changes nothing.
    await supabase.from("contribution_brackets").update({ effective_to: null }).in("id", openIds);
    return { ok: false, error: describeBracketError(insertErr) };
  }

  revalidatePath("/settings");
  return { ok: true };
}

const contributionSettingsSchema = z.object({
  // 1..31 mirrors the settings CHECK. A count of days, not a rate.
  payroll_working_days_per_month: z
    .number()
    .int()
    .min(1, "Working days must be between 1 and 31")
    .max(31, "Working days must be between 1 and 31"),
  contribution_split_semimonthly: z.enum(["half_each", "second_cutoff"]),
});

export async function updateContributionSettings(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction())) return { ok: false, error: DENIED };

  const parsed = contributionSettingsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const supabase = await createClient();
  const { error } = await supabase.from("settings").update(parsed.data).eq("id", 1);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

const previewSchema = z.object({
  agency: agencyEnum,
  basis_centavos: centavos,
  on_date: z.iso.date("Pick a date to check against"),
});

/**
 * Ask the DATABASE what a salary resolves to — the same function payroll calls.
 * A preview computed in TypeScript would be a second implementation of the
 * rules living in application code, i.e. precisely what this feature exists to
 * prevent. If the preview and the payslip ever disagreed, the preview would be
 * worthless.
 */
export async function previewContribution(
  input: unknown
): Promise<{ ok: true; result: ResolvedContribution } | { ok: false; error: string }> {
  if (!(await requireOwnerAction())) return { ok: false, error: DENIED };

  const parsed = previewSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { agency, basis_centavos, on_date } = parsed.data;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_resolve_contribution", {
    p_agency: agency,
    p_basis_centavos: basis_centavos,
    p_on_date: on_date,
  });

  // fn_resolve_contribution RAISES when no row covers the salary rather than
  // silently returning zero — a gap must be loud, because a quiet zero is an
  // under-remittance. Say so in the owner's terms, not in centavos.
  if (error) {
    if (/bracket covers/i.test(error.message)) {
      return {
        ok: false,
        error:
          `No ${AGENCY_LABEL[agency]} rate covers ${formatCentavos(basis_centavos)} on ${on_date}. ` +
          `The rate book has a gap there — payroll would refuse to compute rather than ` +
          `contribute nothing, so add a row covering that salary.`,
      };
    }
    return { ok: false, error: error.message };
  }

  const result = (data as ResolvedContribution[] | null)?.[0];
  if (!result) return { ok: false, error: "No bracket covers that salary on that date." };
  return { ok: true, result };
}
