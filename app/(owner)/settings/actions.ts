"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";

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
  // Suki card rates (0072) — data, not code. 0 legally means "no discount on
  // that kind"; the CHECK allows 0..100 and the RPC caps the price above cost.
  suki_engine_discount_pct: z
    .number()
    .int()
    .min(0, "Engine discount must be between 0 and 100 percent")
    .max(100, "Engine discount must be between 0 and 100 percent"),
  suki_part_discount_pct: z
    .number()
    .int()
    .min(0, "Part discount must be between 0 and 100 percent")
    .max(100, "Part discount must be between 0 and 100 percent"),
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
  revalidatePath("/suki-cards");
  return { ok: true };
}
