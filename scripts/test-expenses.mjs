/**
 * Expenses — the module's own surface: category CRUD, delivery-linked expenses,
 * the PRIVATE receipts bucket, the void flow, and owner-only RLS.
 *
 * Verifies:
 *   • employees read/write NOTHING: neither table, nor the receipts bucket
 *   • categories: create, rename, deactivate, soft-delete; a category in use
 *     cannot be hard-deleted, and soft-deleting one keeps its history readable
 *   • amount must be positive
 *   • expenses attach to a delivery, so a run's true cost is groupable
 *   • receipts are private: no public URL, owner-only signed URLs
 *   • void = clear the path, soft-delete the row, remove the object
 *
 * Expense SCOPE (the shop/company CHECK constraint) and per-shop profitability
 * belong to test-shop-profitability.mjs and are deliberately not repeated here.
 *
 * Provisions its own shop + expense category — it must never write into a real
 * branch, and every expense it books is swept via its own category.
 *
 * Run: node scripts/test-expenses.mjs
 */
import {
  owner, SB_URL, RUN, P, check, section, summary,
  provisionShop, seedPart, seedExpenseCategory, trackReceipt,
  receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const S = await provisionShop("Expenses");
const emp = S.client;

const WEBP_1PX = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=",
  "base64"
);

section("RLS: regular employee is locked out:");
for (const table of ["expense_categories", "expenses"]) {
  const { data } = await emp.from(table).select("*").limit(5);
  check(`employee reads nothing from ${table}`, (data ?? []).length === 0, `got ${data?.length}`);
}

section("Categories CRUD:");
const fuel = await seedExpenseCategory({ label: "Fuel", sort_order: 910 });
const pakyaw = await seedExpenseCategory({ label: "Pakyaw", sort_order: 920 });
const rentCat = await seedExpenseCategory({ label: "Rent", sort_order: 930 });
check("owner can create categories", !!fuel.id && !!pakyaw.id && !!rentCat.id);
check("new categories are active by default", fuel.active === true);
{
  const { error } = await emp.from("expense_categories").insert({ name: `sneaky ${RUN}` });
  check("employee cannot create a category", !!error);
}
{
  const { data } = await owner
    .from("expense_categories").select("id, sort_order")
    .in("id", [rentCat.id, fuel.id, pakyaw.id]).order("sort_order");
  check("categories list in sort_order", data?.map((c) => c.id).join() === [fuel.id, pakyaw.id, rentCat.id].join());
}
{
  const { data, error } = await owner
    .from("expense_categories").update({ name: `ZZ-TEST Fuel & Gas ${RUN}` })
    .eq("id", fuel.id).select().single();
  check("owner can rename a category", !error && /Fuel & Gas/.test(data?.name ?? ""), error?.message);
}
{
  await owner.from("expense_categories").update({ active: false }).eq("id", pakyaw.id);
  const { data } = await owner
    .from("expense_categories").select("id").eq("id", pakyaw.id).eq("active", true);
  check("deactivated category drops out of the active picker", (data ?? []).length === 0);
  await owner.from("expense_categories").update({ active: true }).eq("id", pakyaw.id);
}

section("Amount must be positive:");
for (const [label, amount] of [["zero", 0], ["negative", -500]]) {
  const { error } = await owner.from("expenses").insert({
    category_id: fuel.id, amount, scope: "company", shop_id: null,
    description: `ZZ-TEST bad amount ${RUN}`,
  });
  check(`${label} amount rejected`, !!error);
}

section("Delivery-linked expenses (a run's true cost):");
const part = await seedPart({ label: "Part", cost: 100, price: 200 });
await receive({ parts: [{ part_id: part.id, qty: 2, unit_cost_centavos: 100 }] });
const deliveryId = await deliverAndConfirm(S, { parts: [{ part_id: part.id, qty: 2 }] });

const { data: gas, error: gasErr } = await owner.from("expenses").insert({
  category_id: fuel.id, amount: 80000, scope: "shop", shop_id: S.id,
  delivery_id: deliveryId, description: `ZZ-TEST Gas ${RUN}`, paid_to: "Shell",
  payment_method: "cash",
}).select().single();
const { data: labor } = await owner.from("expenses").insert({
  category_id: pakyaw.id, amount: 50000, scope: "shop", shop_id: S.id,
  delivery_id: deliveryId, description: `ZZ-TEST Pakyaw kay Mang Tony ${RUN}`,
  payment_method: "cash",
}).select().single();
const { data: rent } = await owner.from("expenses").insert({
  category_id: rentCat.id, amount: 500000, scope: "company", shop_id: null,
  description: `ZZ-TEST Bodega rent ${RUN}`, payment_method: "bank",
}).select().single();
check("gas + pakyaw + company rent recorded", !!gas && !!labor && !!rent, gasErr?.message);
{
  const { data } = await owner
    .from("expenses").select("amount").eq("delivery_id", deliveryId).is("deleted_at", null);
  const total = (data ?? []).reduce((s, e) => s + e.amount, 0);
  check(`delivery-linked total = ${P(80000)} + ${P(50000)} = ${P(130000)}`, total === 130000, `(got ${total})`);
}
{
  // the unlinked company expense must NOT be pulled into the run's cost
  const { data } = await owner
    .from("expenses").select("id").eq("delivery_id", deliveryId).is("deleted_at", null);
  check("an expense with no delivery stays out of the run's cost",
    !(data ?? []).some((e) => e.id === rent.id) && (data ?? []).length === 2);
}
{
  const { data } = await owner.from("expenses")
    .select("expense_date").eq("id", gas.id).single();
  const phToday = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
  check("expense_date defaults to PH today", data?.expense_date === phToday, `(got ${data?.expense_date})`);
}

section("A category in use is soft-deleted, never hard-deleted:");
{
  const { error } = await owner.from("expense_categories").delete().eq("id", fuel.id);
  check("hard-deleting a category in use is blocked by the FK", !!error, "delete accepted!");
}
{
  await owner.from("expense_categories").update({ deleted_at: new Date().toISOString() }).eq("id", fuel.id);
  const { data } = await owner
    .from("expenses").select("amount, expense_categories(name)").eq("id", gas.id).single();
  check("history still resolves its category after soft-delete", !!data?.expense_categories?.name);
  await owner.from("expense_categories").update({ deleted_at: null }).eq("id", fuel.id);
}

section("Private receipts bucket:");
const receiptPath = trackReceipt(`${gas.id}.webp`);
{
  const { error } = await owner.storage
    .from("receipts").upload(receiptPath, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("owner uploads receipt", !error, error?.message);
  await owner.from("expenses").update({ receipt_image_path: receiptPath }).eq("id", gas.id);
}
{
  const { error } = await emp.storage
    .from("receipts").upload(trackReceipt(`sneaky-${RUN}.webp`), WEBP_1PX, { contentType: "image/webp" });
  check("employee cannot upload to the receipts bucket", !!error, "upload accepted!");
}
{
  const res = await fetch(`${SB_URL}/storage/v1/object/public/receipts/${receiptPath}`);
  check("receipt NOT reachable via a public URL (private bucket)", res.status !== 200, `(got ${res.status})`);
}
{
  const { data, error } = await owner.storage.from("receipts").createSignedUrl(receiptPath, 60);
  check("owner can mint a signed URL", !error && !!data?.signedUrl, error?.message);
  if (data?.signedUrl) {
    const res = await fetch(data.signedUrl);
    const type = res.headers.get("content-type") ?? "";
    check("signed URL serves the WebP to the owner", res.status === 200 && type.includes("webp"));
  }
}
{
  const { data, error } = await emp.storage.from("receipts").createSignedUrl(receiptPath, 60);
  check("employee CANNOT mint a signed URL", !!error || !data?.signedUrl);
}
{
  const { data } = await emp.storage.from("receipts").download(receiptPath);
  check("employee CANNOT download the object directly", !data);
}

section("Void (soft-delete) + receipt cleanup:");
{
  // replicates voidExpense: clear the path, soft-delete the row, drop the object
  await owner.from("expenses")
    .update({ deleted_at: new Date().toISOString(), receipt_image_path: null })
    .eq("id", gas.id);
  const { error } = await owner.storage.from("receipts").remove([receiptPath]);
  check("void removes the receipt object", !error, error?.message);
  const { data } = await owner.from("expenses").select("id").eq("id", gas.id).is("deleted_at", null);
  check("voided expense gone from active lists", (data ?? []).length === 0);
  const { data: still } = await owner.from("expenses").select("id, amount").eq("id", gas.id).single();
  check("voided expense row is KEPT (audit trail)", !!still && still.amount === 80000);
}
{
  const { data } = await owner
    .from("expenses").select("amount").eq("delivery_id", deliveryId).is("deleted_at", null);
  const total = (data ?? []).reduce((s, e) => s + e.amount, 0);
  check(`voiding the gas drops the run's cost to ${P(50000)}`, total === 50000, `(got ${total})`);
}

section("Employee cannot write expenses:");
{
  const { error } = await emp.from("expenses").insert({
    category_id: pakyaw.id, amount: 100, scope: "shop", shop_id: S.id,
    description: `ZZ-TEST sneaky ${RUN}`,
  });
  check("employee cannot insert an expense", !!error, "insert accepted!");
}
{
  const { data } = await emp.from("expenses").update({ amount: 1 }).eq("id", labor.id).select();
  check("employee cannot edit an expense", (data ?? []).length === 0);
}
{
  const { data } = await emp.from("expenses").delete().eq("id", labor.id).select();
  check("employee cannot delete an expense", (data ?? []).length === 0);
}

section("Cleanup:");
await cleanup();
summary();
