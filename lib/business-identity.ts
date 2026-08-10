import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { BusinessIdentity } from "@/lib/db-types";

/** The one fallback, in one place. Reading `public_settings` keeps it a last
 *  resort rather than the normal path for every document a shop prints. */
const FALLBACK: BusinessIdentity = {
  business_name: "Gerwin Trading",
  address: null,
  phone: null,
  business_email: null,
  business_tin: null,
  receipt_footer: null,
};

/** TAKES THE CALLER'S CLIENT — never build a second one per request, or the two
 *  race to rotate the refresh token and the document 404s with no error. */
export async function getBusinessIdentity(
  supabase: SupabaseClient
): Promise<BusinessIdentity> {
  const { data } = await supabase
    .from("public_settings")
    .select("business_name, address, phone, business_email, business_tin, receipt_footer")
    .maybeSingle();

  return (data as BusinessIdentity | null) ?? FALLBACK;
}
