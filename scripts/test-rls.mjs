/**
 * RLS proof suite — run with: node scripts/test-rls.mjs
 *
 * Signs in as owner / branch-1 employee / branch-2 employee with the PUBLIC
 * anon key and verifies, over the real API surface:
 *   • employees cannot read master inventory, costs, suppliers, ledger, settings
 *   • employees see ONLY their own shop (stock view, shops, profiles, sales)
 *   • the employee views expose NO cost column at all
 *   • employees cannot record sales for another shop or self-approve
 *   • signed-out (anon) clients get nothing
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

// --- load .env.local -------------------------------------------------------
const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const SHOP1 = "a0000000-0000-4000-8000-000000000001";
const SHOP2 = "a0000000-0000-4000-8000-000000000002";

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

function client() {
  return createClient(URL_, ANON, { auth: { persistSession: false } });
}

async function signIn(email, password) {
  const c = client();
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return c;
}

// --- clients ---------------------------------------------------------------
const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");
const emp1 = await signIn("branch1@jerrysmarine.test", "Branch1!Dev2026");
const emp2 = await signIn("branch2@jerrysmarine.test", "Branch2!Dev2026");
const anon = client(); // never signed in

// --- owner seeds test fixtures ----------------------------------------------
console.log("\nSetup (as owner):");
const { data: cat } = await owner
  .from("product_categories")
  .select("id")
  .eq("name", "Engine Parts")
  .single();

const { data: part, error: partErr } = await owner
  .from("parts")
  .insert({
    name: "RLS-TEST Impeller",
    category_id: cat.id,
    cost_centavos: 15000,
    price_centavos: 25000,
    reorder_level: 2,
  })
  .select()
  .single();
check("owner can create a part (with cost)", !!part, partErr?.message);

const { error: stockErr } = await owner.from("stock_levels").insert([
  { part_id: part.id, shop_id: null, qty: 50 }, // master
  { part_id: part.id, shop_id: SHOP1, qty: 10 },
  { part_id: part.id, shop_id: SHOP2, qty: 7 },
]);
check("owner can set stock (master + both shops)", !stockErr, stockErr?.message);

const { data: model } = await owner
  .from("engine_models")
  .select("id")
  .eq("model", "Enduro E40GMHL")
  .single();

const { data: engine, error: engErr } = await owner
  .from("engines")
  .insert({
    serial_number: "RLS-TEST-SN-001",
    engine_model_id: model.id,
    cost_centavos: 8_000_000,
    price_centavos: 9_500_000,
    status: "delivered",
    shop_id: SHOP1,
  })
  .select()
  .single();
check("owner can create a delivered engine", !!engine, engErr?.message);

// --- employee isolation ------------------------------------------------------
console.log("\nEmployee (Branch 1) — must be blocked from:");
for (const table of [
  "parts",
  "stock_levels",
  "suppliers",
  "engines",
  "stock_movements",
  "warranties",
  "settings",
  "deliveries",
  "receivings",
]) {
  const { data, error } = await emp1.from(table).select("*").limit(5);
  check(
    `read ${table} (base table)`,
    (data ?? []).length === 0,
    error ? `(error: ${error.message})` : `(got ${data?.length} rows!)`
  );
}

console.log("\nEmployee (Branch 1) — scoped visibility:");
{
  const { data } = await emp1.from("profiles").select("*");
  check(
    "profiles: sees only own row",
    data?.length === 1 && data[0].full_name === "Branch 1 Staff",
    `(got ${data?.length})`
  );
}
{
  const { data } = await emp1.from("shops").select("*");
  check(
    "shops: sees only own shop",
    data?.length === 1 && data[0].id === SHOP1,
    `(got ${data?.length})`
  );
}
{
  const { data } = await emp1.from("shop_stock").select("*");
  const onlyOwnShop = (data ?? []).every((r) => r.shop_id === SHOP1);
  const row = data?.find((r) => r.name === "RLS-TEST Impeller");
  check("shop_stock view: only own shop's rows", data?.length === 1 && onlyOwnShop);
  check("shop_stock view: qty + price visible", row?.qty === 10 && row?.price_centavos === 25000);
  check(
    "shop_stock view: NO cost column exists",
    row && !("cost_centavos" in row) && !("cost" in row)
  );
}
{
  const { data } = await emp1.from("shop_engines").select("*");
  const row = data?.[0];
  check("shop_engines view: sees own shop's engine", data?.length === 1 && row?.serial_number === "RLS-TEST-SN-001");
  check("shop_engines view: NO cost column exists", row && !("cost_centavos" in row));
}
{
  const { data } = await emp2.from("shop_engines").select("*");
  check("Branch 2 employee: does NOT see Branch 1's engine", (data ?? []).length === 0);
}

console.log("\nEmployee (Branch 1) — recording sales:");
{
  const { error } = await emp1.from("sales").insert({
    shop_id: SHOP2, // wrong shop!
    recorded_by: "22eeb7b4-684c-4443-b49a-20294cbd10cd",
    status: "pending",
  });
  check("cannot record a sale for ANOTHER shop", !!error);
}
{
  const { error } = await emp1.from("sales").insert({
    shop_id: SHOP1,
    recorded_by: "22eeb7b4-684c-4443-b49a-20294cbd10cd",
    status: "approved", // trying to skip approval!
  });
  check("cannot insert a pre-approved sale", !!error);
}
let saleId = null;
{
  const { data, error } = await emp1
    .from("sales")
    .insert({
      shop_id: SHOP1,
      recorded_by: "22eeb7b4-684c-4443-b49a-20294cbd10cd",
      status: "pending",
    })
    .select()
    .single();
  saleId = data?.id;
  check("CAN record a pending sale for own shop", !!data, error?.message);
}
{
  const { error } = await emp1.from("sale_lines").insert({
    sale_id: saleId,
    part_id: part.id,
    qty: 2,
    unit_price_centavos: 25000,
    line_total_centavos: 50000,
  });
  check("CAN add a sale line to own pending sale", !error, error?.message);
}
{
  const { data, error } = await emp1
    .from("sales")
    .update({ status: "approved" })
    .eq("id", saleId)
    .select();
  // with-check must reject the row; PostgREST reports an error or 0 rows
  check("cannot self-approve own sale", !!error || (data ?? []).length === 0);
}
{
  const { data } = await emp2.from("sales").select("*");
  check("Branch 2 employee: cannot see Branch 1's sale", (data ?? []).length === 0);
}
{
  const { data } = await owner.from("sales").select("*").eq("id", saleId);
  check("owner: sees the pending sale", data?.length === 1);
}
{
  const { data } = await owner.from("parts").select("cost_centavos").eq("id", part.id).single();
  check("owner: can read cost", data?.cost_centavos === 15000);
}

console.log("\nLosses:");
{
  const { error } = await emp1.from("losses").insert({
    shop_id: SHOP1,
    recorded_by: "22eeb7b4-684c-4443-b49a-20294cbd10cd",
    part_id: part.id,
    qty: 1,
    reason: "nasira",
    note: "RLS-TEST basag",
  });
  check("employee CAN record a pending loss (nasira)", !error, error?.message);
}
{
  const { error } = await emp1.from("losses").insert({
    shop_id: SHOP2,
    recorded_by: "22eeb7b4-684c-4443-b49a-20294cbd10cd",
    part_id: part.id,
    qty: 1,
    reason: "nawala",
  });
  check("employee cannot record a loss for another shop", !!error);
}

console.log("\nSigned-out (anon key, no session):");
for (const table of ["parts", "shop_stock", "sales", "shops"]) {
  const { data } = await anon.from(table).select("*").limit(5);
  check(`anon gets nothing from ${table}`, (data ?? []).length === 0);
}

// --- cleanup (as owner) ------------------------------------------------------
console.log("\nCleanup:");
await owner.from("losses").delete().like("note", "RLS-TEST%");
await owner.from("losses").delete().eq("part_id", part.id);
if (saleId) await owner.from("sales").delete().eq("id", saleId);
await owner.from("engines").delete().eq("id", engine.id);
const { error: delPartErr } = await owner.from("parts").delete().eq("id", part.id);
check("fixtures removed", !delPartErr, delPartErr?.message);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
