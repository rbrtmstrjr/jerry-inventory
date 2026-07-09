/**
 * Deliverable 10 verification — settings, shop CRUD, employee lifecycle
 * (create → scoped access → reassign → deactivate → blocked), password reset.
 * Run: node scripts/test-admin.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const SHOP1 = "a0000000-0000-4000-8000-000000000001";
const SHOP2 = "a0000000-0000-4000-8000-000000000002";
const RUN = Date.now().toString(36).toUpperCase();
const EMP_EMAIL = `adm-test-${RUN.toLowerCase()}@jerrysmarine.test`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

const anonClient = () =>
  createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });

async function signIn(email, password) {
  const c = anonClient();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");
const emp1 = await signIn("branch1@jerrysmarine.test", "Branch1!Dev2026");
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

console.log("Settings:");
{
  const { error } = await owner
    .from("settings")
    .update({ receipt_footer: `ADM-TEST footer ${RUN}` })
    .eq("id", 1);
  check("owner can update settings", !error, error?.message);
  const { data } = await owner.from("settings").select("receipt_footer").eq("id", 1).single();
  check("settings persisted", data?.receipt_footer === `ADM-TEST footer ${RUN}`);
}
{
  const { data, error } = await emp1
    .from("settings")
    .update({ business_name: "hacked" })
    .eq("id", 1)
    .select();
  check("employee cannot touch settings", !!error || (data ?? []).length === 0);
}
await owner.from("settings").update({ receipt_footer: null }).eq("id", 1);

console.log("\nShops:");
const { data: newShop, error: shopErr } = await owner
  .from("shops")
  .insert({ name: `ADM-TEST Branch ${RUN}`, location: "Test Pier", active: true })
  .select()
  .single();
check("owner can create a shop", !!newShop, shopErr?.message);
{
  const { error } = await emp1.from("shops").insert({ name: "sneaky shop" });
  check("employee cannot create shops", !!error);
}

console.log("\nEmployee lifecycle (the same steps the UI action runs):");
const { data: newUser, error: cuErr } = await admin.auth.admin.createUser({
  email: EMP_EMAIL,
  password: "AdmTest!12345",
  email_confirm: true,
});
check("auth account created", !!newUser?.user, cuErr?.message);
{
  const { error } = await admin.from("profiles").insert({
    id: newUser.user.id,
    full_name: `ADM-TEST Staff ${RUN}`,
    role: "employee",
    shop_id: newShop.id,
  });
  check("profile created, locked to new shop", !error, error?.message);
}
const empNew = await signIn(EMP_EMAIL, "AdmTest!12345");
{
  const { data } = await empNew.from("shops").select("id");
  check("new employee sees ONLY their shop", data?.length === 1 && data[0].id === newShop.id);
  const { data: parts } = await empNew.from("parts").select("*").limit(1);
  check("new employee blocked from parts/costs", (parts ?? []).length === 0);
}

console.log("\nReassign shop:");
{
  const { error } = await owner
    .from("profiles")
    .update({ shop_id: SHOP2 })
    .eq("id", newUser.user.id)
    .eq("role", "employee");
  check("owner reassigns employee to Branch 2", !error, error?.message);
  const { data } = await empNew.from("shops").select("id");
  check("employee scope follows reassignment", data?.length === 1 && data[0].id === SHOP2);
}

console.log("\nPassword reset:");
{
  const { error } = await admin.auth.admin.updateUserById(newUser.user.id, {
    password: "NewPass!67890",
  });
  check("password reset via admin", !error, error?.message);
  const c = anonClient();
  const { error: oldErr } = await c.auth.signInWithPassword({
    email: EMP_EMAIL, password: "AdmTest!12345",
  });
  check("old password no longer works", !!oldErr);
  const { error: newErr } = await c.auth.signInWithPassword({
    email: EMP_EMAIL, password: "NewPass!67890",
  });
  check("new password works", !newErr);
  await c.auth.signOut();
}

console.log("\nDeactivate:");
{
  const { error } = await owner
    .from("profiles")
    .update({ active: false })
    .eq("id", newUser.user.id);
  check("owner deactivates employee", !error, error?.message);
  // auth_shop_id() checks active → all shop-scoped reads vanish
  const { data: shops } = await empNew.from("shops").select("id");
  const { data: stock } = await empNew.from("shop_stock").select("*").limit(1);
  check("deactivated: shop + stock access gone", (shops ?? []).length === 0 && (stock ?? []).length === 0);
  const { error: recErr } = await empNew.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null, p_part_lines: [], p_engine_ids: [],
  });
  check("deactivated: cannot record sales", !!recErr);
}
{
  const { data: sh1 } = await emp1.from("shops").select("id");
  check("other employees unaffected", sh1?.length === 1 && sh1[0].id === SHOP1);
}

console.log("\nCleanup:");
{
  const del = await admin.auth.admin.deleteUser(newUser.user.id); // cascades profile
  const { error } = await owner
    .from("shops")
    .update({ deleted_at: new Date().toISOString(), active: false })
    .eq("id", newShop.id);
  check("fixtures cleaned", !del.error && !error, del.error?.message ?? error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
