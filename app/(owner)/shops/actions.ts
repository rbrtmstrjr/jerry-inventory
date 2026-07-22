"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getProfile } from "@/lib/auth";
import { SHOP_COLOR_KEYS } from "@/lib/shop-colors";

type ActionResult = { ok: true; id?: string } | { ok: false; error: string };

async function requireOwnerAction(): Promise<string | null> {
  const profile = await getProfile();
  if (!profile || profile.role !== "owner") return null;
  return profile.id;
}

// ---------------------------------------------------------------------------
// Shops
// ---------------------------------------------------------------------------
const shopSchema = z.object({
  id: z.uuid().optional(),
  name: z.string().trim().min(1, "Name is required"),
  location: z.string().trim().max(200).optional().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
  active: z.boolean().default(true),
  // Palette KEY, never a hex — resolved to theme tokens at render (0050).
  color_key: z
    .enum(SHOP_COLOR_KEYS)
    .nullable()
    .default(null),
});

export async function upsertShop(input: unknown): Promise<ActionResult> {
  const parsed = shopSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { id, ...fields } = parsed.data;
  const row = { ...fields, location: fields.location || null };
  const supabase = await createClient();
  // Return the id on insert too, so the caller can upload the shop logo against
  // the new row (same two-step pattern as products: save row → upload image).
  const query = id
    ? supabase.from("shops").update(row).eq("id", id).select("id").single()
    : supabase.from("shops").insert(row).select("id").single();
  const { data, error } = await query;
  if (error) {
    // partial unique index on color_key (live shops) — surface it kindly
    if (error.code === "23505" && /color_key/.test(error.message)) {
      return { ok: false, error: "That color is already used by another shop." };
    }
    return { ok: false, error: error.message };
  }
  revalidatePath("/shops");
  return { ok: true, id: data?.id ?? id };
}

/** Persist (or clear) a shop's logo object path after the Storage upload. */
export async function setShopLogo(
  shopId: string,
  logoPath: string | null
): Promise<ActionResult> {
  const ownerId = await requireOwnerAction();
  if (!ownerId) return { ok: false, error: "Only the owner can edit shops" };
  if (!z.uuid().safeParse(shopId).success) return { ok: false, error: "Invalid shop" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("shops")
    .update({ logo_path: logoPath })
    .eq("id", shopId);
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shops");
  return { ok: true };
}

/**
 * Close a shop permanently (bankruptcy / not earning). Guarded: everything
 * must be settled first — stock returned to master, engines moved, staff
 * reassigned or deactivated, and no submissions waiting in the queue.
 */
export async function closeShop(id: string): Promise<ActionResult> {
  const ownerId = await requireOwnerAction();
  if (!ownerId) return { ok: false, error: "Only the owner can close shops" };
  if (!z.uuid().safeParse(id).success) return { ok: false, error: "Invalid shop" };

  const supabase = await createClient();

  const [stockRes, enginesRes, loginRes, payrollStaffRes, salesRes, lossesRes] =
    await Promise.all([
      supabase.from("stock_levels").select("qty").eq("shop_id", id).gt("qty", 0),
      supabase
        .from("engines")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", id)
        .eq("status", "delivered")
        .is("deleted_at", null),
      // the shop's shared login account
      supabase
        .from("profiles")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", id)
        .eq("active", true)
        .is("deleted_at", null),
      // people on payroll at this shop
      supabase
        .from("staff")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", id)
        .eq("active", true)
        .is("deleted_at", null),
      supabase
        .from("sales")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", id)
        .in("status", ["pending", "questioned"])
        .is("deleted_at", null),
      supabase
        .from("losses")
        .select("id", { count: "exact", head: true })
        .eq("shop_id", id)
        .in("status", ["pending", "questioned"])
        .is("deleted_at", null),
    ]);

  const units = (stockRes.data ?? []).reduce((s, r) => s + r.qty, 0);
  if (units > 0) {
    return {
      ok: false,
      error: `${units} part unit(s) still at this shop — return them to master first (Deliveries & Returns → New Return).`,
    };
  }
  if ((enginesRes.count ?? 0) > 0) {
    return {
      ok: false,
      error: `${enginesRes.count} engine(s) still at this shop — return them to master first.`,
    };
  }
  if ((loginRes.count ?? 0) > 0) {
    return {
      ok: false,
      error: "The shop's login is still enabled — disable it first (… menu → Change Credentials).",
    };
  }
  if ((payrollStaffRes.count ?? 0) > 0) {
    return {
      ok: false,
      error: `${payrollStaffRes.count} employee(s) still on payroll for this shop — deactivate or reassign them in Payroll → Staff.`,
    };
  }
  const pending = (salesRes.count ?? 0) + (lossesRes.count ?? 0);
  if (pending > 0) {
    return {
      ok: false,
      error: `${pending} submission(s) still awaiting approval for this shop — approve or reject them first.`,
    };
  }

  const { error } = await supabase
    .from("shops")
    .update({ active: false, deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/shops");
  revalidatePath("/deliveries");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Employees (auth admin — owner verified first, service role only after)
// ---------------------------------------------------------------------------
const employeeSchema = z.object({
  email: z.email("Valid email required"),
  password: z.string().min(8, "Password needs at least 8 characters"),
  full_name: z.string().trim().min(1, "Name is required"),
  shop_id: z.uuid("Pick a shop"),
});

export async function createEmployee(input: unknown): Promise<ActionResult> {
  const ownerId = await requireOwnerAction();
  if (!ownerId) return { ok: false, error: "Only the owner can manage employees" };

  const parsed = employeeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // One shared login per shop — helpers/cashiers are people, not accounts.
  const supabaseCheck = await createClient();
  const { count } = await supabaseCheck
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("shop_id", parsed.data.shop_id)
    .eq("role", "employee")
    .is("deleted_at", null);
  if ((count ?? 0) > 0) {
    return {
      ok: false,
      error: "This shop already has a login account — each shop gets exactly one.",
    };
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
    role: "employee",
    shop_id: parsed.data.shop_id,
  });
  if (profileError) {
    // don't leave an orphaned auth account behind
    await admin.auth.admin.deleteUser(created.user.id);
    return { ok: false, error: profileError.message };
  }

  revalidatePath("/shops");
  return { ok: true, id: created.user.id };
}

const updateEmployeeSchema = z.object({
  id: z.uuid(),
  full_name: z.string().trim().min(1),
  shop_id: z.uuid(),
  active: z.boolean(),
});

export async function updateEmployee(input: unknown): Promise<ActionResult> {
  const ownerId = await requireOwnerAction();
  if (!ownerId) return { ok: false, error: "Only the owner can manage employees" };

  const parsed = updateEmployeeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (parsed.data.id === ownerId) {
    return { ok: false, error: "You cannot edit your own account here." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      full_name: parsed.data.full_name,
      shop_id: parsed.data.shop_id,
      active: parsed.data.active,
    })
    .eq("id", parsed.data.id)
    .eq("role", "employee");
  if (error) return { ok: false, error: error.message };
  revalidatePath("/shops");
  return { ok: true };
}

/**
 * Change a shop login's credentials: email (username), optionally a new
 * password, and whether the account is enabled.
 */
const credentialsSchema = z.object({
  id: z.uuid(),
  email: z.email("Valid email required"),
  password: z
    .string()
    .min(8, "Password needs at least 8 characters")
    .optional()
    .or(z.literal("")),
  active: z.boolean(),
});

export async function updateShopCredentials(input: unknown): Promise<ActionResult> {
  const ownerId = await requireOwnerAction();
  if (!ownerId) return { ok: false, error: "Only the owner can manage shop logins" };

  const parsed = credentialsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (parsed.data.id === ownerId) {
    return { ok: false, error: "You cannot edit your own account here." };
  }

  const supabase = await createClient();
  const { data: target } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", parsed.data.id)
    .single();
  if (target?.role !== "employee") {
    return { ok: false, error: "Not a shop login account." };
  }

  const admin = createAdminClient();
  const authUpdate: { email: string; password?: string; email_confirm?: boolean } = {
    email: parsed.data.email,
    email_confirm: true,
  };
  if (parsed.data.password) authUpdate.password = parsed.data.password;

  const { error: authError } = await admin.auth.admin.updateUserById(
    parsed.data.id,
    authUpdate
  );
  if (authError) {
    return {
      ok: false,
      error: /already/i.test(authError.message)
        ? "That email is already used by another account."
        : authError.message,
    };
  }

  const { error } = await supabase
    .from("profiles")
    .update({ active: parsed.data.active })
    .eq("id", parsed.data.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/shops");
  return { ok: true };
}

const resetSchema = z.object({
  id: z.uuid(),
  password: z.string().min(8, "Password needs at least 8 characters"),
});

export async function resetEmployeePassword(input: unknown): Promise<ActionResult> {
  const ownerId = await requireOwnerAction();
  if (!ownerId) return { ok: false, error: "Only the owner can manage employees" };

  const parsed = resetSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  if (parsed.data.id === ownerId) {
    return { ok: false, error: "Change your own password from your Supabase account." };
  }

  // only employee accounts may be reset through this screen
  const supabase = await createClient();
  const { data: target } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", parsed.data.id)
    .single();
  if (target?.role !== "employee") {
    return { ok: false, error: "Not an employee account." };
  }

  const admin = createAdminClient();
  const { error } = await admin.auth.admin.updateUserById(parsed.data.id, {
    password: parsed.data.password,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
