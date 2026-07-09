import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export type Role = "owner" | "employee";

export interface Profile {
  id: string;
  full_name: string;
  role: Role;
  shop_id: string | null;
}

/** Current user's profile (role + shop scope), or null if signed out. */
export async function getProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data } = await supabase
    .from("profiles")
    .select("id, full_name, role, shop_id, active")
    .eq("id", user.id)
    .single();

  if (!data || !data.active) return null; // deactivated accounts get nothing
  const { active: _active, ...profile } = data;
  return profile as Profile;
}

/** Require an owner session; employees are sent to their shop view. */
export async function requireOwner(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "owner") redirect("/shop");
  return profile;
}

/** Require an employee session with a shop assignment. */
export async function requireEmployee(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) redirect("/login");
  if (profile.role !== "employee") redirect("/dashboard");
  return profile;
}
