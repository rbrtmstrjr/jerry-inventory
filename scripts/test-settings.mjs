/**
 * Settings overhaul â€” sections, credentials, business identity, health.
 *
 * What this suite is really defending:
 *
 *  â€¢ `settings` stays OWNER-ONLY, while the business identity printed on paper
 *    becomes readable by shops through `public_settings` â€” and NOTHING else
 *    does. That split is the whole of 0043: before it, a shop printing a
 *    receipt read null and handed the customer a nameless, address-less,
 *    footer-less receipt, while the owner's reprint of the same sale looked
 *    complete.
 *
 *  â€¢ The re-auth gate is tested at the MECHANISM, not through the UI. The UI
 *    can be bypassed; what has to be true is that the wrong password does not
 *    authenticate.
 *
 *  â€¢ Password recovery works end to end. This is the lockout safety net: if it
 *    is broken, Jerry is locked out of his own business with nobody to call. It
 *    is proven against a THROWAWAY account, never the real owner's â€” a crash
 *    halfway through a test that rewrites the owner's password would cause the
 *    exact disaster the feature exists to prevent.
 *
 *  â€¢ The thresholds actually drive behaviour. A setting that changes nothing is
 *    decoration, and this codebase already had two of them.
 *
 * Contribution rate edits + their effective-dating are owned by
 * test-payroll-contributions.mjs (Â§9 proves history is untouched) and are
 * deliberately not repeated here.
 */
import {
  RUN,
  admin,
  owner,
  anonClient,
  check,
  section,
  summary,
  provisionShop,
  seedSupplier,
  cleanup,
} from "./_harness.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const OWNER_EMAIL = "robertmaestro09@gmail.com";
const OWNER_PASSWORD = "rajonrondo09";

// ---------------------------------------------------------------------------
// This suite flips LIVE settings to prove they drive behaviour. Capture the real
// row and put it back however we exit â€” an interrupted run must not leave the
// business with a test business name on its receipts.
// ---------------------------------------------------------------------------
const IDENTITY_COLS = [
  "business_name",
  "address",
  "phone",
  "business_email",
  "business_tin",
  "receipt_footer",
];
const { data: originalSettings, error: readErr } = await owner
  .from("settings")
  .select(
    `${IDENTITY_COLS.join(", ")}, warranty_expiry_alert_days, supplier_limit_warn_pct`
  )
  .eq("id", 1)
  .single();

if (readErr) {
  console.error(
    `Could not read settings â€” has migration 0043 been applied? ${readErr.message}`
  );
  process.exit(1);
}

// Refuse a poisoned baseline â€” see the same guard in test-settings-documents.mjs.
// Capturing leftover "ZZ-TEST" as `original` would restore the junk and call it
// a pass, making the pollution permanent and self-certifying.
if (
  Object.values(originalSettings).some(
    (v) => typeof v === "string" && v.includes("ZZ-TEST")
  )
) {
  console.error(
    `\nRefusing to run: the live settings row already holds test data ` +
      `(${originalSettings.business_name}). Restore the real business identity first.\n`
  );
  process.exit(1);
}

let settingsRestored = false;
async function restoreSettings() {
  if (settingsRestored) return;
  settingsRestored = true;
  await admin.from("settings").update(originalSettings).eq("id", 1);
}

// The guarantee is the try/finally below, NOT these handlers. An exit handler
// cannot await, so an async restore never lands â€” a sibling suite crashed
// mid-run and left "ZZ-TEST Marine" as the live business name exactly this way.
// These are a best-effort for Ctrl-C only.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void restoreSettings().then(() => process.exit(130));
  });
}

try {

const shop = await provisionShop("Settings");
const emp = shop.client;

// â”€â”€ 0. settings is owner-only â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section("Settings is owner-only");
{
  const { data } = await owner.from("settings").select("business_name").eq("id", 1).single();
  check("owner CAN read settings", !!data?.business_name);

  const { data: e } = await emp.from("settings").select("*").limit(5);
  check("employee reads NOTHING from settings", (e ?? []).length === 0, `got ${e?.length}`);

  const { error: upErr } = await emp
    .from("settings")
    .update({ business_name: `ZZ-TEST hijack ${RUN}` })
    .eq("id", 1);
  const { data: after } = await owner.from("settings").select("business_name").eq("id", 1).single();
  check(
    "employee CANNOT change the business name",
    !!upErr || after?.business_name === originalSettings.business_name,
    after?.business_name
  );

  const { data: anonRead } = await anonClient().from("settings").select("*").limit(1);
  check("signed-out reads nothing", (anonRead ?? []).length === 0);
}

// â”€â”€ 1. public_settings â€” the safe view â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section("public_settings exposes identity, and only identity");
{
  const { data: ps, error } = await emp.from("public_settings").select("*").maybeSingle();
  check("employee CAN read public_settings", !!ps && !error, error?.message);

  if (ps) {
    const keys = Object.keys(ps);
    // Structural, not by value: the dial must not EXIST on the row. Same test
    // shape as "shop_stock has no cost column" â€” that rule is the backbone here.
    for (const leaked of [
      "warranty_expiry_alert_days",
      "supplier_limit_warn_pct",
      "payroll_working_days_per_month",
      "contribution_split_semimonthly",
      "default_warranty_months",
    ]) {
      check(`public_settings does NOT expose ${leaked}`, !(leaked in ps));
    }
    check(
      "public_settings carries every identity column",
      IDENTITY_COLS.every((c) => keys.includes(c)),
      keys.join(",")
    );
  }

  const { data: anonPs } = await anonClient().from("public_settings").select("*").limit(1);
  check("signed-out reads nothing from public_settings", (anonPs ?? []).length === 0);
}

// â”€â”€ 2. Business identity reaches the documents â€” for the SHOP too â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section("Business identity reaches printed documents");
{
  const mark = {
    business_name: `ZZ-TEST Marine ${RUN}`,
    address: `ZZ-TEST Wharf Rd ${RUN}`,
    phone: "0917-000-0000",
    business_email: `zz-${RUN.toLowerCase()}@test.local`,
    business_tin: "000-111-222-333",
    receipt_footer: `ZZ-TEST Salamat po ${RUN}`,
  };
  const { error } = await owner.from("settings").update(mark).eq("id", 1);
  check("owner can save business identity", !error, error?.message);

  const { data: asOwner } = await owner.from("public_settings").select("*").maybeSingle();
  check("owner sees the new identity", asOwner?.business_name === mark.business_name);

  // The point of the whole migration: the SHOP â€” which prints nearly every
  // receipt â€” now reads the same identity the owner does.
  const { data: asShop } = await emp.from("public_settings").select("*").maybeSingle();
  check("SHOP sees the same business name", asShop?.business_name === mark.business_name);
  check("SHOP sees the address", asShop?.address === mark.address);
  check("SHOP sees the phone", asShop?.phone === mark.phone);
  check("SHOP sees the TIN", asShop?.business_tin === mark.business_tin);
  check(
    "SHOP sees the receipt footer (it was unreachable before 0043)",
    asShop?.receipt_footer === mark.receipt_footer
  );

  await restoreSettingsInline();
  const { data: back } = await owner.from("public_settings").select("business_name").maybeSingle();
  check("identity restored to the real value", back?.business_name === originalSettings.business_name);
}

/** Put the captured row back mid-run (the exit hook is the crash net). */
async function restoreSettingsInline() {
  await admin.from("settings").update(originalSettings).eq("id", 1);
}

// â”€â”€ 3. The re-auth gate, at the mechanism â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section("Re-auth gate");
{
  // This is exactly what the Account section calls before allowing a password
  // or email change. If a wrong password authenticated here, the gate would be
  // theatre â€” so assert the mechanism, not the form.
  const wrong = await anonClient().auth.signInWithPassword({
    email: OWNER_EMAIL,
    password: `definitely-not-${RUN}`,
  });
  check("WRONG current password is rejected", !!wrong.error, wrong.error?.message);
  check("...and yields no session", !wrong.data?.session);

  const right = await anonClient().auth.signInWithPassword({
    email: OWNER_EMAIL,
    password: OWNER_PASSWORD,
  });
  check("correct current password is accepted", !right.error && !!right.data.session);

  // A failed gate attempt must not disturb the session the owner already holds.
  const { data: still } = await owner.from("settings").select("business_name").eq("id", 1).single();
  check("a failed attempt does not sign the owner out", !!still?.business_name);
}

// â”€â”€ 4. Password recovery, end to end â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section("Password recovery (the lockout safety net)");
{
  // Run against the THROWAWAY employee, never the owner: a crash between
  // "change password" and "restore it" would lock the real account out, which
  // is the very disaster this feature exists to prevent. generateLink also
  // means no live email is sent to anyone.
  const NEW_PASSWORD = `Zz!New${RUN}7b`;

  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: shop.email,
  });
  check("a recovery link can be issued", !linkErr && !!link, linkErr?.message);

  const tokenHash = link?.properties?.hashed_token;
  check("the link carries a recovery token", !!tokenHash);

  // This is what /auth/callback does with the emailed token.
  const recoveryClient = anonClient();
  const { data: verified, error: vErr } = await recoveryClient.auth.verifyOtp({
    type: "recovery",
    token_hash: tokenHash,
  });
  check("the token exchanges for a session", !vErr && !!verified?.session, vErr?.message);

  // This is what /auth/reset does with that session.
  const { error: updErr } = await recoveryClient.auth.updateUser({ password: NEW_PASSWORD });
  check("a new password can be set from the recovery session", !updErr, updErr?.message);

  // The proof: the whole point is being able to get back IN.
  const { data: signedIn, error: siErr } = await anonClient().auth.signInWithPassword({
    email: shop.email,
    password: NEW_PASSWORD,
  });
  check("SIGN-IN WORKS with the new password", !siErr && !!signedIn?.session, siErr?.message);

  const { error: oldErr } = await anonClient().auth.signInWithPassword({
    email: shop.email,
    password: `Zz!${RUN}9a`,
  });
  check("the old password no longer works", !!oldErr);

  const { error: reuseErr } = await anonClient().auth.verifyOtp({
    type: "recovery",
    token_hash: tokenHash,
  });
  check("a recovery token cannot be reused", !!reuseErr, reuseErr?.message);
}

// â”€â”€ 5. Thresholds actually drive behaviour â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section("Thresholds change behaviour, not just the row");
{
  await owner.from("settings").update({ warranty_expiry_alert_days: 45 }).eq("id", 1);
  const { data: d45 } = await owner.rpc("fn_warranty_alert_days");
  check("warranty lead time drives fn_warranty_alert_days (45)", d45 === 45, String(d45));

  await owner.from("settings").update({ warranty_expiry_alert_days: 7 }).eq("id", 1);
  const { data: d7 } = await owner.rpc("fn_warranty_alert_days");
  check("...and follows a change (7)", d7 === 7, String(d7));

  // The supplier warning point must move with the setting, not with a literal.
  const sup = await seedSupplier({ label: "Limits", credit_limit: 100_000_00 });
  const projected = 60_000_00; // 60% of the limit

  // A supplier threshold is meaningless if no receiving can name a supplier.
  // This is the exact select /master-inventory/receiving runs to fill its
  // picker; it asked for `credit_limit_centavos`, which has never existed, so
  // PostgREST failed the whole query and `?? []` rendered the failure as "no
  // suppliers". Assert the ERROR, not the row count â€” an empty list and a
  // broken query look identical downstream, which is precisely how this
  // survived since v1.
  const { error: pickerErr } = await owner
    .from("suppliers")
    .select("id, name, credit_limit, payment_terms_days, terms_note")
    .is("deleted_at", null)
    .order("name");
  check(
    "the Receiving supplier picker query succeeds (every column exists)",
    !pickerErr,
    pickerErr?.message
  );

  await owner.from("settings").update({ supplier_limit_warn_pct: 80 }).eq("id", 1);
  const { data: at80 } = await owner.rpc("fn_supplier_limit_check", {
    p_supplier_id: sup.id,
    p_additional: projected,
  });
  check("at an 80% warning point, 60% utilisation is NOT near the limit", at80?.near_limit === false);

  await owner.from("settings").update({ supplier_limit_warn_pct: 50 }).eq("id", 1);
  const { data: at50 } = await owner.rpc("fn_supplier_limit_check", {
    p_supplier_id: sup.id,
    p_additional: projected,
  });
  check(
    "lowering the warning point to 50% makes the SAME 60% near the limit",
    at50?.near_limit === true,
    JSON.stringify(at50)
  );
  check("...and it still is not over the limit", at50?.would_exceed === false);

  await restoreSettingsInline();
}

// â”€â”€ 6. System health â€” owner-only, and no secrets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section("System health panel");
{
  const { data: jobs, error } = await owner.rpc("fn_cron_job_health");
  check("owner can read job health", !error, error?.message);

  const rows = jobs ?? [];
  for (const name of ["warranty-expiry-daily", "supplier-overdue-daily"]) {
    const j = rows.find((r) => r.jobname === name);
    check(`${name} is scheduled`, !!j, `jobs: ${rows.map((r) => r.jobname).join(",") || "none"}`);
    if (j) check(`${name} reports a stale flag`, typeof j.stale === "boolean");
  }

  if (rows[0]) {
    // A scheduled job's command is a classic place for a service key to sit
    // (the pg_net + service-role pattern), and a failure message can echo the
    // command straight back. Neither may ever cross this boundary.
    const keys = Object.keys(rows[0]);
    for (const leaked of ["command", "return_message", "username", "nodename", "database"]) {
      check(`job health does NOT expose ${leaked}`, !keys.includes(leaked), keys.join(","));
    }
  }

  const { error: empErr } = await emp.rpc("fn_cron_job_health");
  check("employee CANNOT read job health", !!empErr && /owner/i.test(empErr.message), empErr?.message);

  const { error: anonErr } = await anonClient().rpc("fn_cron_job_health");
  check("signed-out cannot read job health", !!anonErr);
}

// â”€â”€ 7. Scope boundary: shop credentials stay on /shops â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
section("Scope boundary");
{
  // Shop logins are per-shop and belong next to map pins and close-shop. If a
  // credential path ever appears under /settings there are two ways to do one
  // thing, and the one-login-per-shop check lives on only one of them.
  const dir = "app/(owner)/settings";
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
  const offenders = files.filter((f) => {
    const src = readFileSync(join(dir, f), "utf8");
    return /createAdminClient|auth\.admin|createEmployee|resetEmployeePassword/.test(src);
  });
  check(
    "no shop-credential management leaked into /settings",
    offenders.length === 0,
    offenders.join(",")
  );

  const shopsSrc = readFileSync("app/(owner)/shops/actions.ts", "utf8");
  check("shop credentials still live on /shops", /createEmployee/.test(shopsSrc));

  // The service role must never be reachable from a client bundle.
  const clientish = files.filter((f) => {
    const src = readFileSync(join(dir, f), "utf8");
    return /"use client"/.test(src) && /SERVICE_ROLE|createAdminClient/.test(src);
  });
  check("no client component touches the service role", clientish.length === 0, clientish.join(","));

  check("settings dir is real", statSync(dir).isDirectory());
}

} finally {
  // Whatever happened above, the live settings row goes back.
  await restoreSettings();
  const { data: back } = await owner
    .from("settings").select("business_name").eq("id", 1).single();
  check(
    "live settings restored",
    back?.business_name === originalSettings.business_name,
    `left as: ${back?.business_name}`
  );
  await cleanup();
  summary();
}
