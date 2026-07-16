/**
 * Harness self-test — the other suites are only as trustworthy as this.
 *
 * Proves the harness can provision a real working shop+employee, drive the full
 * stock path, and then remove every trace WITHOUT touching live data.
 *
 * Run: node scripts/test-harness.mjs
 */
import {
  owner, admin, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, seedSupplier, seedCustomer,
  receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

// Snapshot the live world so we can prove we didn't disturb it.
const before = {};
for (const t of ["shops", "parts", "sales", "expenses", "engines", "suppliers"]) {
  const { count } = await admin.from(t).select("*", { count: "exact", head: true });
  before[t] = count;
}

section("Provisioning:");
const A = await provisionShop("Alpha");
const B = await provisionShop("Bravo");
check("two temp shops with distinct ids", !!A.id && !!B.id && A.id !== B.id);
check("each shop got a working employee login", !!A.client && !!B.client);
check("temp shops are clearly named", A.name.startsWith("ZZ-TEST") && A.name.includes(RUN));

{
  const { data } = await A.client.from("shops").select("id");
  check("employee A sees only its own shop", data?.length === 1 && data[0].id === A.id);
}
{
  // The scoping that matters: A must not see B, even though both are temp.
  const { data } = await A.client.from("shop_stock").select("shop_id").eq("shop_id", B.id);
  check("employee A sees nothing of shop B", (data ?? []).length === 0);
}

section("Fixtures:");
const part = await seedPart({ label: "Bolt", cost: 500, price: 1200 });
check("part seeded with cost + price", part.cost_centavos === 500 && part.price_centavos === 1200);
const model = await seedEngineModel({ brand: "ZZ", model: "E", hp: 40 });
check("engine model seeded", !!model.id);
const sup = await seedSupplier({ label: "Vendor" });
check("supplier seeded", !!sup.id);
const cust = await seedCustomer({ label: "Walk-in" });
check("customer seeded", !!cust.id);

section("Stock path (master → transit → shop):");
await receive({
  parts: [{ part_id: part.id, qty: 20, unit_cost_centavos: 500 }],
  engines: [{
    serial_number: `ZZ-${RUN}-E1`, engine_model_id: model.id,
    condition: "brand_new", cost_centavos: 300000, price_centavos: 450000,
    warranty_months: 12,
  }],
});
{
  const { data } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).single();
  check("20 units landed in master", data?.qty === 20);
}
{
  const { data } = await owner
    .from("engines").select("id, status").eq("serial_number", `ZZ-${RUN}-E1`).single();
  check("engine received into master", data?.status === "in_master");
}

const { data: eng } = await owner
  .from("engines").select("id").eq("serial_number", `ZZ-${RUN}-E1`).single();
await deliverAndConfirm(A, {
  parts: [{ part_id: part.id, qty: 12 }],
  engine_ids: [eng.id],
});
{
  const { data } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).eq("shop_id", A.id).single();
  check("12 units landed at shop A after confirm", data?.qty === 12);
}
{
  const { data } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).single();
  check("master drew down to 8", data?.qty === 8);
}
{
  // deliverAndConfirm confirms in full, so the transit bucket must be empty.
  const { data } = await owner
    .from("stock_in_transit").select("qty").eq("shop_id", A.id);
  check("nothing left in transit for shop A", (data ?? []).length === 0);
}
{
  const { data } = await A.client.from("shop_stock").select("qty, price_centavos").eq("part_id", part.id);
  check("employee sees the stock through shop_stock", data?.[0]?.qty === 12);
  check(
    "shop_stock exposes price but no cost",
    data?.[0]?.price_centavos === 1200 && !("cost_centavos" in (data?.[0] ?? {}))
  );
}

section("Cleanup (the part everything else depends on):");
await cleanup();

for (const t of ["shops", "parts", "sales", "expenses", "engines", "suppliers"]) {
  const { count } = await admin.from(t).select("*", { count: "exact", head: true });
  check(`${t}: ${before[t]} rows before → ${count} after (live data untouched)`, count === before[t]);
}
{
  const { data } = await admin.from("stock_levels").select("id").eq("part_id", part.id);
  check("no orphan stock_levels left behind", (data ?? []).length === 0);
}
{
  const { data } = await admin.from("stock_movements").select("id").eq("part_id", part.id);
  check("no orphan stock_movements left behind", (data ?? []).length === 0);
}

summary();
