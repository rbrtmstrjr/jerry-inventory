/**
 * 0099 — Admin accounts (the light owner tier).
 *
 * is_owner() now means OFFICE TIER (owner or admin, active): every daily
 * policy/RPC accepts the admin with no sweeping. is_primary_owner() (Gerry
 * alone) guards the three DB-enforced surfaces: profiles management, shops
 * structure, settings writes. Deactivation = profiles.active=false, which
 * both helpers check — so it cuts database access, not just the UI.
 *
 * Refuses to run (exit 2) until 0099 is applied — probing a live database
 * for functions it doesn't have yet would report failures that are really
 * "not migrated yet".
 */
import {
  owner, admin, anonClient, signIn, RUN, check, section, summary,
  provisionShop, seedPart, cleanup,
} from "./_harness.mjs";

// ── gate: 0099 must be applied ──────────────────────────────────────────────
{
  const { error } = await owner.rpc("is_primary_owner");
  if (error && /could not find/i.test(error.message)) {
    console.error("test-admin-accounts: migration 0099_admin_accounts.sql is not applied — run it in the SQL editor first.");
    process.exit(2);
  }
}

const ADMIN_EMAIL = `zz-admin-${RUN.toLowerCase()}@test.local`;
const ADMIN_PASSWORD = `Zz-test-${RUN}`;
let adminUserId = null;

try {
  // ── fixtures ──────────────────────────────────────────────────────────────
  const shop = await provisionShop("AdmAcct");
  const part = await seedPart({ label: "AdmAcct" });

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: ADMIN_EMAIL, password: ADMIN_PASSWORD, email_confirm: true,
  });
  if (createErr) throw new Error(`fixture admin auth user: ${createErr.message}`);
  adminUserId = created.user.id;

  section("Profiles CHECK (two office roles, employee unchanged)");
  {
    const { error } = await admin.from("profiles").insert({
      id: adminUserId, full_name: `ZZ-TEST Admin ${RUN}`, role: "admin", shop_id: null,
    });
    check("an admin profile (no shop) is accepted", !error, error?.message);

    const { error: bad } = await admin.from("profiles")
      .update({ shop_id: shop.id }).eq("id", adminUserId);
    check("an admin WITH a shop is refused by the CHECK",
      /profiles_role_shop|check/i.test(bad?.message ?? ""), bad?.message);
  }

  const adm = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD);

  section("Office tier: the admin runs daily operations");
  {
    const { data: iso } = await adm.rpc("is_owner");
    const { data: ipo } = await adm.rpc("is_primary_owner");
    check("admin passes is_owner() (office tier)", iso === true);
    check("admin does NOT pass is_primary_owner()", ipo === false);

    const { data: p, error } = await adm.from("parts").select("id").eq("id", part.id).maybeSingle();
    check("admin reads the owner-only catalog", !error && !!p, error?.message);

    const { data: s } = await adm.from("settings").select("business_name").eq("id", 1).maybeSingle();
    check("admin READS settings (documents + dials need it)", !!s?.business_name);
  }

  section("Gerry-only surfaces hold at the database");
  {
    const { data: su } = await adm.from("settings")
      .update({ business_name: `ZZ-TEST ${RUN}` }).eq("id", 1).select("id");
    check("admin cannot WRITE settings (0 rows)", (su ?? []).length === 0, JSON.stringify(su));

    const { data: sh } = await adm.from("shops")
      .update({ name: `ZZ-TEST Renamed ${RUN}` }).eq("id", shop.id).select("id");
    check("admin cannot write shops (0 rows)", (sh ?? []).length === 0);

    const { error: ins } = await adm.from("shops").insert({ name: `ZZ-TEST Rogue ${RUN}` });
    check("admin cannot open a shop", !!ins, ins?.message);

    const { error: mint } = await adm.from("profiles").insert({
      id: crypto.randomUUID(), full_name: `ZZ-TEST Rogue ${RUN}`, role: "admin",
    });
    check("admin cannot mint a login (profiles RLS)", !!mint, mint?.message);
  }

  section("Gerry keeps full power");
  {
    const { data: g } = await owner.rpc("is_primary_owner");
    check("owner login passes is_primary_owner()", g === true);

    const { data: same } = await owner.from("settings").select("business_name").eq("id", 1).single();
    const { data: su } = await owner.from("settings")
      .update({ business_name: same.business_name }).eq("id", 1).select("id");
    check("owner can still write settings", (su ?? []).length === 1);

    const { data: sh } = await owner.from("shops")
      .update({ name: shop.name }).eq("id", shop.id).select("id");
    check("owner can still write shops", (sh ?? []).length === 1);

    const { data: pu } = await owner.from("profiles")
      .update({ full_name: `ZZ-TEST Admin ${RUN}` }).eq("id", adminUserId).select("id");
    check("owner manages the admin's profile", (pu ?? []).length === 1);
  }

  section("Notifications reach the office automatically");
  {
    const { data: note, error } = await admin.from("notifications").insert({
      recipient_role: "owner", type: "master_low_stock",
      title: `ZZ-TEST alert ${RUN}`,
    }).select("id").single();
    check("fixture owner-notification created", !error, error?.message);

    const { data: seen } = await adm.from("notifications").select("id").eq("id", note.id).maybeSingle();
    check("admin SEES owner-role notifications (daily alerts flow to the office)", !!seen);
    await admin.from("notifications").delete().eq("id", note.id);
  }

  section("Deactivation cuts database access, not just the UI");
  {
    await admin.from("profiles").update({ active: false }).eq("id", adminUserId);
    const { data: iso } = await adm.rpc("is_owner");
    const { data: p } = await adm.from("parts").select("id").eq("id", part.id).maybeSingle();
    check("deactivated admin fails is_owner()", iso === false);
    check("deactivated admin reads nothing", !p);

    // the dead session cannot reactivate itself
    const { data: self } = await adm.from("profiles")
      .update({ active: true }).eq("id", adminUserId).select("id");
    check("deactivated admin cannot reactivate itself", (self ?? []).length === 0);

    await admin.from("profiles").update({ active: true }).eq("id", adminUserId);
    const { data: back } = await adm.rpc("is_owner");
    check("reactivation restores access (flag is reversible)", back === true);
  }

  section("Employees unchanged");
  {
    const { data: iso } = await shop.client.rpc("is_owner");
    const { data: p } = await shop.client.from("parts").select("id").eq("id", part.id).maybeSingle();
    check("employee still fails is_owner()", iso === false);
    check("employee still blocked from the catalog", !p);

    const { data: anonIso, error: anonErr } = await anonClient().rpc("is_owner");
    check("anon is nobody", anonErr != null || anonIso === false);
  }
} finally {
  // the fixture admin has no recorded history, so the auth delete cascades
  // cleanly onto the profile — exactly the rule the delete action encodes
  if (adminUserId) await admin.auth.admin.deleteUser(adminUserId);
  await cleanup();
}
summary();
