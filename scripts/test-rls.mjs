/**
 * RLS proof suite — the security backbone.
 *
 * Over the real API surface with the PUBLIC anon key, verifies:
 *   • employees cannot read master inventory, costs, suppliers, ledger, settings
 *   • employees see ONLY their own shop (stock view, shops, profiles, sales)
 *   • the employee-facing views expose NO cost column at all
 *   • employees cannot record for another shop, nor self-approve
 *   • signed-out (anon) clients get nothing
 *
 * Provisions its own two shops — it must never write into a real branch.
 *
 * Run: node scripts/test-rls.mjs
 */
import {
  owner, anonClient, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, seedSupplier, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("RLS A");
const B = await provisionShop("RLS B");
const emp1 = A.client;
const emp2 = B.client;
const anon = anonClient();

section("Setup (as owner):");
const part = await seedPart({ label: "Impeller", cost: 15000, price: 25000, reorder_level: 2 });
check("owner can create a part (with cost)", !!part.id);

const { error: stockErr } = await owner.from("stock_levels").insert([
  { part_id: part.id, shop_id: null, qty: 50 },
  { part_id: part.id, shop_id: A.id, qty: 10 },
  { part_id: part.id, shop_id: B.id, qty: 7 },
]);
check("owner can set stock (master + both shops)", !stockErr, stockErr?.message);

const model = await seedEngineModel({ brand: "RLS", model: "Enduro", hp: 40 });
const { data: engine, error: engErr } = await owner.from("engines").insert({
  serial_number: `RLS-${RUN}-SN1`,
  engine_model_id: model.id,
  cost_centavos: 8_000_000,
  price_centavos: 9_500_000,
  status: "delivered",
  shop_id: A.id,
}).select().single();
check("owner can create a delivered engine", !!engine, engErr?.message);
await seedSupplier({ label: "Vendor" });

section("Employee — must be blocked from base tables:");
for (const table of [
  "parts", "stock_levels", "suppliers", "engines", "stock_movements",
  "warranties", "settings", "deliveries", "receivings",
  // cost/debt surfaces added by later add-ons
  "expenses", "sale_line_costs", "supplier_payments", "receiving_balances",
  "supplier_payables", "master_low_stock", "reviewed_items",
]) {
  const { data, error } = await emp1.from(table).select("*").limit(5);
  check(
    `read ${table}`,
    (data ?? []).length === 0,
    error ? `error: ${error.message}` : `got ${data?.length} rows!`
  );
}

section("Employee — scoped visibility:");
{
  const { data } = await emp1.from("profiles").select("*");
  check("profiles: sees only own row", data?.length === 1 && data[0].id === A.userId, `got ${data?.length}`);
}
{
  const { data } = await emp1.from("shops").select("*");
  check("shops: sees only own shop", data?.length === 1 && data[0].id === A.id, `got ${data?.length}`);
}
{
  const { data } = await emp1.from("shop_stock").select("*");
  const onlyOwn = (data ?? []).every((r) => r.shop_id === A.id);
  const row = data?.find((r) => r.part_id === part.id);
  check("shop_stock: only own shop's rows", data?.length === 1 && onlyOwn, `got ${data?.length}`);
  check("shop_stock: qty + price visible", row?.qty === 10 && row?.price_centavos === 25000);
  check(
    "shop_stock: NO cost column exists",
    !!row && !("cost_centavos" in row) && !("cost" in row)
  );
}
{
  const { data } = await emp1.from("shop_engines").select("*");
  const row = data?.[0];
  check(
    "shop_engines: sees own shop's engine",
    data?.length === 1 && row?.serial_number === `RLS-${RUN}-SN1`
  );
  check("shop_engines: NO cost column exists", !!row && !("cost_centavos" in row));
  check(
    "shop_engines: NO margin columns either",
    !!row && !("margin_floor_pct" in row) && !("margin_asking_pct" in row)
  );
}
{
  const { data } = await emp2.from("shop_engines").select("*");
  check("shop B employee: does NOT see shop A's engine", (data ?? []).length === 0);
}

section("Employee — recording sales:");
{
  const { error } = await emp1.from("sales").insert({
    shop_id: B.id, recorded_by: A.userId, status: "pending",
  });
  check("cannot record a sale for ANOTHER shop", !!error);
}
{
  const { error } = await emp1.from("sales").insert({
    shop_id: A.id, recorded_by: A.userId, status: "approved",
  });
  check("cannot insert a pre-approved sale", !!error);
}
{
  // Since 0016 a shop may only insert `recorded`. Going straight to `pending`
  // would skip the submit step and make the sale visible to the owner without
  // the shop ever sending it.
  const { error } = await emp1.from("sales").insert({
    shop_id: A.id, recorded_by: A.userId, status: "pending",
  });
  check("cannot skip `recorded` and insert straight to `pending`", !!error);
}
let saleId = null;
{
  const { data, error } = await emp1.from("sales").insert({
    shop_id: A.id, recorded_by: A.userId, status: "recorded",
  }).select().single();
  saleId = data?.id;
  check("CAN record a sale for own shop (status=recorded)", !!data, error?.message);
}
{
  const { error } = await emp1.from("sale_lines").insert({
    sale_id: saleId, part_id: part.id, qty: 2,
    unit_price_centavos: 25000, line_total_centavos: 50000,
  });
  check("CAN add a sale line to own pending sale", !error, error?.message);
}
{
  const { data, error } = await emp1
    .from("sales").update({ status: "approved" }).eq("id", saleId).select();
  check("cannot self-approve own sale", !!error || (data ?? []).length === 0);
}
{
  const { error } = await emp1.rpc("fn_approve_sale", { p_sale_id: saleId });
  check("cannot approve via the RPC either", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { data } = await emp2.from("sales").select("*");
  check("shop B employee: cannot see shop A's sale", (data ?? []).length === 0);
}
{
  const { data } = await owner.from("sales").select("*").eq("id", saleId);
  check("owner: sees the pending sale", data?.length === 1);
}
{
  const { data } = await owner.from("parts").select("cost_centavos").eq("id", part.id).single();
  check("owner: can read cost", data?.cost_centavos === 15000);
}

section("Losses:");
{
  const { error } = await emp1.from("losses").insert({
    shop_id: A.id, recorded_by: A.userId, part_id: part.id,
    qty: 1, reason: "nasira", status: "recorded", note: `RLS-TEST basag ${RUN}`,
  });
  check("employee CAN record a loss (nasira)", !error, error?.message);
}
{
  const { error } = await emp1.from("losses").insert({
    shop_id: A.id, recorded_by: A.userId, part_id: part.id,
    qty: 1, reason: "nasira", status: "approved",
  });
  check("employee cannot self-approve a loss", !!error);
}
{
  const { error } = await emp1.from("losses").insert({
    shop_id: B.id, recorded_by: A.userId, part_id: part.id, qty: 1, reason: "nawala",
  });
  check("employee cannot record a loss for another shop", !!error);
}

section("Signed-out (anon key, no session):");
for (const table of ["parts", "shop_stock", "sales", "shops", "expenses", "settings"]) {
  const { data } = await anon.from(table).select("*").limit(5);
  check(`anon gets nothing from ${table}`, (data ?? []).length === 0);
}

section("Cleanup:");
await cleanup();
summary();
