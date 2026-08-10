import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Role = "owner" | "admin" | "employee";

/** Office tier: runs the whole owner-side app day to day (0099). */
export const OFFICE_ROLES: readonly Role[] = ["owner", "admin"];

export interface Profile {
  id: string;
  full_name: string;
  role: Role;
  shop_id: string | null;
}

/** Current user's profile (role + shop scope), or null if signed out.
 *  cache() dedupes it per request — layout, page, and actions share one hit. */
export const getProfile = cache(async (): Promise<Profile | null> => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const query = () =>
    supabase
      .from("profiles")
      .select("id, full_name, role, shop_id, active")
      .eq("id", user.id)
      .maybeSingle();

  // Retry once, then throw: a transient query failure must not read as
  // "signed out" (it bounced signed-in users through /login → /dashboard).
  let res = await query();
  if (res.error) res = await query();
  if (res.error) throw new Error(`Profile lookup failed: ${res.error.message}`);

  const { data } = res;
  if (!data || !data.active) return null; // deactivated accounts get nothing
  const { active: _active, ...profile } = data;
  return profile as Profile;
});

/** Require an office session (owner OR admin); employees go to their shop view. */
export async function requireOwner(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (!OFFICE_ROLES.includes(profile.role)) redirect("/shop");
  return profile;
}

/** Require Gerry himself — the four pages an admin never sees (0099). */
export async function requirePrimaryOwner(): Promise<Profile> {
  const profile = await requireOwner();
  if (profile.role !== "owner") redirect("/dashboard");
  return profile;
}

/** Non-redirecting tier check for server actions that must return an
 *  ActionResult — requirePrimaryOwner() redirects, which they cannot. */
export async function isPrimaryOwner(): Promise<boolean> {
  const profile = await getProfile();
  return profile?.role === "owner";
}

/** Require an employee session with a shop assignment. */
export async function requireEmployee(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "employee") redirect("/dashboard");
  return profile;
}
