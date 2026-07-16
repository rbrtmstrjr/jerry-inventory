/**
 * Administration — settings, shop CRUD, and the employee lifecycle
 * (create → scoped access → reassign → password reset → deactivate → blocked).
 *
 * Proves:
 *   • settings is owner-only: the owner reads/writes it, employees cannot
 *   • the owner creates shops; employees cannot create or edit them
 *   • a new employee is locked to exactly one shop and blocked from costs
 *   • reassigning the profile moves the employee's scope immediately
 *   • a password reset invalidates the old password
 *   • deactivating a profile removes ALL scoped access and the ability to
 *     record sales, and leaves other employees untouched
 *
 * Provisions its own shops + logins — it must never touch a real branch, and
 * it never overwrites a real settings value (see the no-op write below).
 *
 * Run: node scripts/test-admin.mjs
 */
import {
  owner, admin, anonClient, RUN, check, section, summary,
  provisionShop, trackShop, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("ADM A");
const B = await provisionShop("ADM B");
const empA = A.client;
const empB = B.client;
const PASSWORD = `Zz!${RUN}9a`; // provisionShop's password scheme

section("Settings:");
{
  const { data, error } = await owner.from("settings").select("*").eq("id", 1).single();
  check("owner can read settings", !error && !!data, error?.message);
  check("business name is set", typeof data?.business_name === "string" && data.business_name.length > 0,
    `got ${data?.business_name}`);

  // The old script wrote a marker footer then NULLED it — on a live DB that
  // destroys the real receipt footer. Writing the current value back proves the
  // owner's UPDATE permission and leaves the row byte-identical.
  const { data: upd, error: uErr } = await owner
    .from("settings").update({ receipt_footer: data.receipt_footer }).eq("id", 1).select();
  check("owner can update settings", !uErr && (upd ?? []).length === 1, uErr?.message);
  const { data: after } = await owner.from("settings").select("receipt_footer").eq("id", 1).single();
  check("real settings value untouched", after?.receipt_footer === data.receipt_footer);
}
{
  const { data } = await empA.from("settings").select("*");
  check("employee cannot read settings", (data ?? []).length === 0);
}
{
  const { data, error } = await empA
    .from("settings").update({ business_name: "hacked" }).eq("id", 1).select();
  check("employee cannot touch settings", !!error || (data ?? []).length === 0);
}
{
  const { data } = await anonClient().from("settings").select("*");
  check("anon cannot read settings", (data ?? []).length === 0);
}

section("Shops:");
const { data: newShop, error: shopErr } = await owner
  .from("shops")
  .insert({ name: `ZZ-TEST ADM Branch ${RUN}`, location: "Test Pier", active: true })
  .select()
  .single();
check("owner can create a shop", !!newShop, shopErr?.message);
trackShop(newShop?.id, "ADM Branch"); // so cleanup() sweeps it — never left behind
{
  const { error } = await owner
    .from("shops").update({ location: "Test Pier 2" }).eq("id", newShop.id);
  check("owner can edit a shop", !error, error?.message);
}
{
  const { error } = await empA.from("shops").insert({ name: `ZZ-TEST sneaky ${RUN}` });
  check("employee cannot create shops", !!error);
}
{
  const { data, error } = await empA
    .from("shops").update({ name: "renamed" }).eq("id", A.id).select();
  check("employee cannot rename their own shop", !!error || (data ?? []).length === 0);
}

section("Employee lifecycle (the same steps the UI action runs):");
{
  check("auth account created", !!A.userId);
  const { data } = await owner.from("profiles").select("*").eq("id", A.userId).single();
  check("profile created, locked to one shop", data?.shop_id === A.id && data?.role === "employee");
}
{
  const { data } = await empA.from("shops").select("id");
  check("new employee sees ONLY their shop", data?.length === 1 && data[0].id === A.id);
  const { data: parts } = await empA.from("parts").select("*").limit(1);
  check("new employee blocked from parts/costs", (parts ?? []).length === 0);
}

section("Reassign shop:");
{
  const { error } = await owner
    .from("profiles").update({ shop_id: B.id }).eq("id", A.userId).eq("role", "employee");
  check("owner reassigns employee to the other shop", !error, error?.message);
  // auth_shop_id() reads profiles live, so the scope moves without re-login.
  const { data } = await empA.from("shops").select("id");
  check("employee scope follows reassignment", data?.length === 1 && data[0].id === B.id);
}
{
  const { data, error } = await empA
    .from("profiles").update({ shop_id: A.id }).eq("id", A.userId).select();
  check("employee cannot reassign themselves", !!error || (data ?? []).length === 0);
}

section("Password reset:");
{
  const { error } = await admin.auth.admin.updateUserById(A.userId, { password: "NewPass!67890" });
  check("password reset via admin", !error, error?.message);
  const c = anonClient();
  const { error: oldErr } = await c.auth.signInWithPassword({ email: A.email, password: PASSWORD });
  check("old password no longer works", !!oldErr);
  const { error: newErr } = await c.auth.signInWithPassword({ email: A.email, password: "NewPass!67890" });
  check("new password works", !newErr, newErr?.message);
  await c.auth.signOut();
}

section("Deactivate:");
{
  const { error } = await owner.from("profiles").update({ active: false }).eq("id", A.userId);
  check("owner deactivates employee", !error, error?.message);
  // auth_shop_id() checks active → all shop-scoped reads vanish
  const { data: shops } = await empA.from("shops").select("id");
  const { data: stock } = await empA.from("shop_stock").select("*").limit(1);
  check("deactivated: shop + stock access gone", (shops ?? []).length === 0 && (stock ?? []).length === 0);
  const { error: recErr } = await empA.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null, p_part_lines: [], p_engine_ids: [],
  });
  check(
    "deactivated: cannot record sales",
    !!recErr && /only shop employees/i.test(recErr.message),
    recErr?.message
  );
}
{
  // A deactivated login must not even authenticate its way back to data.
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email: A.email, password: "NewPass!67890" });
  const { data: shops } = await c.from("shops").select("id");
  check("deactivated: fresh sign-in still sees nothing", !error && (shops ?? []).length === 0);
  await c.auth.signOut();
}
{
  const { data } = await empB.from("shops").select("id");
  check("other employees unaffected", data?.length === 1 && data[0].id === B.id);
}

section("Cleanup:");
await cleanup();
summary();
