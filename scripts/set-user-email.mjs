/**
 * Change a login's email address — the thing the dashboard's Users table has no
 * control for.
 *
 * Uses the Auth Admin API, NOT raw SQL. An email lives in `auth.users` AND in
 * `auth.identities`; updating the table directly leaves the two out of step and
 * the account unable to sign in. `admin.updateUserById` keeps them together.
 *
 * `email_confirm: true` applies the change immediately with no confirmation
 * mail — which is the point. The in-app flow (Settings → Account) is the one
 * that emails; this is the administrative override for when that cannot work:
 * the old address is undeliverable, or nobody can reach that inbox any more.
 *
 * STAGING/LOCAL ONLY — see scripts/_env-guard.mjs. Production account changes
 * go through the dashboard so they leave a human trail rather than a shell
 * history entry.
 *
 * Run: node scripts/set-user-email.mjs <current-email> <new-email>
 */
import { createClient } from "@supabase/supabase-js";
import { assertWritableEnv, readEnvFile } from "./_env-guard.mjs";

assertWritableEnv("set-user-email (it rewrites a login's email address)");

const [currentEmail, newEmail] = process.argv.slice(2);
if (!currentEmail || !newEmail) {
  console.error("Usage: node scripts/set-user-email.mjs <current-email> <new-email>");
  process.exit(1);
}
if (!/^\S+@\S+\.\S+$/.test(newEmail)) {
  console.error(`"${newEmail}" is not a valid email address.`);
  process.exit(1);
}

const env = readEnvFile();
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// listUsers is paginated; walk it rather than assuming one page.
async function findByEmail(email) {
  const target = email.toLowerCase();
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === target);
    if (hit) return hit;
    if (data.users.length < 200) return null; // last page
  }
  return null;
}

const user = await findByEmail(currentEmail);
if (!user) {
  console.error(`No user found with email ${currentEmail}`);
  process.exit(1);
}

const clash = await findByEmail(newEmail);
if (clash && clash.id !== user.id) {
  console.error(`${newEmail} is already used by another account (${clash.id}).`);
  process.exit(1);
}

const { data, error } = await admin.auth.admin.updateUserById(user.id, {
  email: newEmail,
  email_confirm: true, // apply now — no confirmation round trip
});
if (error) {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
}

console.log(`${currentEmail}  ->  ${data.user.email}`);
console.log(`uid ${data.user.id} (unchanged — the profile row and all attribution follow the uid)`);
