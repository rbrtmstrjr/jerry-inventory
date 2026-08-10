"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";

type ActionResult = { ok: true } | { ok: false; error: string };

/** A Server Action is its own POST endpoint and does NOT inherit the layout's
 *  gate. RLS still backs this; the payoff is a sentence, not a raw RLS error. */
async function requireOwnerAction(): Promise<boolean> {
  const profile = await getProfile();
  return profile?.role === "owner";
}

const DENIED = "Only the owner can change settings." as const;

/** Every document printing business identity. All dynamic today, but a stale
 *  letterhead is the bug nobody looks for. Use the literal segment pattern. */
function revalidateDocuments() {
  revalidatePath("/settings");
  revalidatePath("/receipt/[saleId]", "page");
  revalidatePath("/deliveries/[id]/note", "page");
  revalidatePath("/counts/[id]/sheet", "page");
  revalidatePath("/stock-alerts/purchase-list");
}

// ── Business identity — everything here lands on printed paper ──────────────
// `address`/`phone`, NOT business_address/business_contact: one fact, one column.
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

// ── Alert thresholds ────────────────────────────────────────────────────────
// Mirror the settings CHECKs; the DB stays the authority. 365 is a UI bound only.
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
  // 1..365 mirrors the settings CHECK.
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

// ── Admin accounts (0099) — Gerry mints the office logins ───────────────────
// role === 'owner' STRICTLY; profiles RLS is is_primary_owner()-only behind it.
const createAdminSchema = z.object({
  full_name: z.string().trim().min(1, "Name is required"),
  email: z.email("Valid email required"),
  password: z.string().min(8, "Password needs at least 8 characters"),
});

export async function createAdminAccount(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction()))
    return { ok: false, error: "Only the owner can manage admin accounts" };

  const parsed = createAdminSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const admin = createAdminClient();
  const { data: created, error: authError } = await admin.auth.admin.createUser({
    email: parsed.data.email,
    password: parsed.data.password,
    email_confirm: true,
  });
  if (authError) {
    return {
      ok: false,
      error: /already/i.test(authError.message)
        ? "That email already has an account."
        : authError.message,
    };
  }

  const { error: profileError } = await admin.from("profiles").insert({
    id: created.user.id,
    full_name: parsed.data.full_name,
    role: "admin",
    shop_id: null,
  });
  if (profileError) {
    // don't leave an orphaned auth account behind
    await admin.auth.admin.deleteUser(created.user.id);
    return { ok: false, error: profileError.message };
  }

  revalidatePath("/settings");
  return { ok: true };
}

/** Resolve the target and refuse anything that isn't an admin profile — this
 *  API must never be able to touch Gerry's own login or a shop login. */
async function getAdminTarget(id: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("profiles")
    .select("id, role")
    .eq("id", id)
    .single();
  return data?.role === "admin" ? data : null;
}

const setActiveSchema = z.object({ id: z.uuid(), active: z.boolean() });

export async function setAdminActive(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction()))
    return { ok: false, error: "Only the owner can manage admin accounts" };

  const parsed = setActiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  if (!(await getAdminTarget(parsed.data.id)))
    return { ok: false, error: "Not an admin account" };

  // Both getProfile() and the DB helpers check `active`, so flipping this flag
  // cuts app AND database access — nothing else to revoke.
  const admin = createAdminClient();
  const { error } = await admin
    .from("profiles")
    .update({ active: parsed.data.active })
    .eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/settings");
  return { ok: true };
}

const updateCredsSchema = z
  .object({
    id: z.uuid(),
    full_name: z.string().trim().min(1).optional(),
    email: z.email("Valid email required").optional(),
    password: z.string().min(8, "Password needs at least 8 characters").optional(),
  })
  .refine((v) => v.full_name || v.email || v.password, {
    message: "Nothing to change",
  });

export async function updateAdminCredentials(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction()))
    return { ok: false, error: "Only the owner can manage admin accounts" };

  const parsed = updateCredsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (!(await getAdminTarget(parsed.data.id)))
    return { ok: false, error: "Not an admin account" };

  const admin = createAdminClient();
  if (parsed.data.email || parsed.data.password) {
    const { error } = await admin.auth.admin.updateUserById(parsed.data.id, {
      ...(parsed.data.email ? { email: parsed.data.email, email_confirm: true } : {}),
      ...(parsed.data.password ? { password: parsed.data.password } : {}),
    });
    if (error) {
      return {
        ok: false,
        error: /already/i.test(error.message)
          ? "That email already has an account."
          : error.message,
      };
    }
  }
  if (parsed.data.full_name) {
    const { error } = await admin
      .from("profiles")
      .update({ full_name: parsed.data.full_name })
      .eq("id", parsed.data.id);
    if (error) return { ok: false, error: error.message };
  }

  revalidatePath("/settings");
  return { ok: true };
}

const deleteAdminSchema = z.object({ id: z.uuid() });

export async function deleteAdminAccount(input: unknown): Promise<ActionResult> {
  if (!(await requireOwnerAction()))
    return { ok: false, error: "Only the owner can manage admin accounts" };

  const parsed = deleteAdminSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid input" };
  if (!(await getAdminTarget(parsed.data.id)))
    return { ok: false, error: "Not an admin account" };

  // Deleting the auth user cascades onto the profile. Attribution FKs refuse
  // once the admin has history — deactivate instead.
  const admin = createAdminClient();
  const { error } = await admin.auth.admin.deleteUser(parsed.data.id);
  if (error) {
    // GoTrue's FK-refused delete surfaces as a bodyless 500 (message "{}"),
    // so anything unreadable gets the real explanation instead
    const msg = typeof error.message === "string" ? error.message : "";
    return {
      ok: false,
      error: !/[a-z]/i.test(msg) || /database error/i.test(msg)
        ? "This admin already has recorded history, so the account can't be deleted — deactivate it instead."
        : msg,
    };
  }

  revalidatePath("/settings");
  return { ok: true };
}
