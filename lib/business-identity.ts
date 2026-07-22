import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { BusinessIdentity } from "@/lib/db-types";

/**
 * The one fallback, in one place.
 *
 * Six documents used to carry their own `settings?.business_name ?? "Gerwin
 * Trading"`, which meant six copies of a hardcoded business name that a rename
 * would have to find. Worse, the fallback was load-bearing rather than
 * defensive: `settings` is owner-only, so a shop printing a receipt ALWAYS hit
 * it and always printed a nameless, addressless, footerless receipt.
 *
 * Reading `public_settings` (0043) means the fallback is now what it always
 * should have been — an if-the-database-is-broken last resort, not the normal
 * path for half the documents this business prints.
 */
const FALLBACK: BusinessIdentity = {
  business_name: "Gerwin Trading",
  address: null,
  phone: null,
  business_email: null,
  business_tin: null,
  receipt_footer: null,
};

/**
 * Business identity for a printed document. Safe for owner AND shop callers.
 *
 * TAKES THE CALLER'S CLIENT — it must not build its own.
 *
 * The first version called createClient() itself, which put TWO Supabase server
 * clients in one request. Both attach to the same cookie jar and both may
 * refresh the session, and Supabase rotates refresh tokens: whichever client
 * refreshes second presents a token that has just been retired, gets
 * "Invalid Refresh Token: Refresh Token Not Found", and ends up with no
 * session. RLS then returns nothing, `.single()` yields null, and the page
 * calls notFound() — so the document 404s with no error anywhere in the page's
 * own code. /counts/[id] rendered while /counts/[id]/sheet 404'd on the very
 * same id, which is what gave it away.
 *
 * One client per request. Concurrent queries on ONE client are fine — they're
 * plain HTTP calls carrying the same token — so callers still keep this inside
 * their existing Promise.all and pay nothing for the extra read.
 */
export async function getBusinessIdentity(
  supabase: SupabaseClient
): Promise<BusinessIdentity> {
  const { data } = await supabase
    .from("public_settings")
    .select("business_name, address, phone, business_email, business_tin, receipt_footer")
    .maybeSingle();

  return (data as BusinessIdentity | null) ?? FALLBACK;
}
