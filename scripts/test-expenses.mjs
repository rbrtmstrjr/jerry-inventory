/**
 * Expenses verification — owner-only RLS, scope constraint, delivery-linked
 * totals, PRIVATE receipts bucket (owner-only read/write), void cleanup.
 * Run: node scripts/test-expenses.mjs
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
const RUN = Date.now().toString(36).toUpperCase();
const FUEL_CAT = "c0000000-0000-4000-8000-000000000001";
const PAKYAW_CAT = "c0000000-0000-4000-8000-000000000003";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

async function signIn(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return c;
}

const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");
const emp1 = await signIn("branch1@jerrysmarine.test", "Branch1!Dev2026");

const WEBP_1PX = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=",
  "base64"
);

console.log("RLS: regular employee locked out:");
for (const table of ["expense_categories", "expenses"]) {
  const { data } = await emp1.from(table).select("*").limit(5);
  check(`employee reads nothing from ${table}`, (data ?? []).length === 0);
}
{
  const { error } = await emp1.from("expenses").insert({
    category_id: FUEL_CAT, amount: 100, scope: "company", shop_id: null, description: "sneaky",
  });
  check("employee cannot insert expenses", !!error);
}
{
  const { error } = await emp1.storage
    .from("receipts")
    .upload(`sneaky-${RUN}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("employee cannot upload to receipts bucket", !!error);
}

console.log("\nScope constraint:");
{
  const { error } = await owner.from("expenses").insert({
    category_id: FUEL_CAT, amount: 100, scope: "shop", shop_id: null, description: "bad",
  });
  check("shop scope without shop_id rejected", !!error);
}
{
  const { error } = await owner.from("expenses").insert({
    category_id: FUEL_CAT, amount: 100, scope: "company", shop_id: SHOP1, description: "bad",
  });
  check("company scope WITH shop_id rejected", !!error);
}

console.log("\nDelivery-linked expenses (a run's true cost):");
// fixture: small delivery to link against
const { data: cat } = await owner.from("product_categories").select("id").limit(1).single();
const { data: part } = await owner.from("parts")
  .insert({ name: `EXP-TEST Part ${RUN}`, category_id: cat.id, cost_centavos: 100, price_centavos: 200 })
  .select().single();
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `EXP-TEST ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 2, unit_cost_centavos: 100 }], p_engines: [],
});
const { data: deliveryId } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: SHOP1, p_note: `EXP-TEST run ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 2 }], p_engine_ids: [],
});

const { data: gas, error: gasErr } = await owner.from("expenses").insert({
  category_id: FUEL_CAT, amount: 80000, scope: "shop", shop_id: SHOP1,
  delivery_id: deliveryId, description: `EXP-TEST Gas ${RUN}`, paid_to: "Shell",
  payment_method: "cash",
}).select().single();
const { data: pakyaw } = await owner.from("expenses").insert({
  category_id: PAKYAW_CAT, amount: 50000, scope: "shop", shop_id: SHOP1,
  delivery_id: deliveryId, description: `EXP-TEST Pakyaw kay Mang Tony ${RUN}`,
  payment_method: "cash",
}).select().single();
const { data: rent } = await owner.from("expenses").insert({
  category_id: "c0000000-0000-4000-8000-000000000006", amount: 500000, scope: "company",
  shop_id: null, description: `EXP-TEST Bodega rent ${RUN}`, payment_method: "bank",
}).select().single();
check("gas + pakyaw + company rent recorded", !!gas && !!pakyaw && !!rent, gasErr?.message);

{
  const { data } = await owner
    .from("expenses")
    .select("amount")
    .eq("delivery_id", deliveryId)
    .is("deleted_at", null);
  const total = (data ?? []).reduce((s, e) => s + e.amount, 0);
  check("delivery-linked total = ₱800 + ₱500 = ₱1,300", total === 130000, `(got ${total})`);
}
{
  const { data } = await owner.from("expenses").select("amount, scope").like("description", `EXP-TEST%`);
  const company = (data ?? []).filter((e) => e.scope === "company").reduce((s, e) => s + e.amount, 0);
  const shop = (data ?? []).filter((e) => e.scope === "shop").reduce((s, e) => s + e.amount, 0);
  check("company vs shop split reports separately (₱5,000 / ₱1,300)", company === 500000 && shop === 130000);
}

console.log("\nPrivate receipts bucket:");
const receiptPath = `${gas.id}.webp`;
{
  const { error } = await owner.storage
    .from("receipts")
    .upload(receiptPath, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("owner uploads receipt", !error, error?.message);
  await owner.from("expenses").update({ receipt_image_path: receiptPath }).eq("id", gas.id);
}
{
  const res = await fetch(
    `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/receipts/${receiptPath}`
  );
  check("receipt NOT reachable via public URL (private bucket)", res.status !== 200, `(got ${res.status})`);
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
  const { data, error } = await emp1.storage.from("receipts").createSignedUrl(receiptPath, 60);
  check("employee CANNOT mint a signed URL", !!error || !data?.signedUrl);
}

console.log("\nVoid (soft-delete) + receipt cleanup:");
{
  // replicate voidExpense: clear path, soft-delete, remove object
  await owner.from("expenses")
    .update({ deleted_at: new Date().toISOString(), receipt_image_path: null })
    .eq("id", gas.id);
  const { error } = await owner.storage.from("receipts").remove([receiptPath]);
  check("void removes the receipt object", !error, error?.message);
  const { data } = await owner.from("expenses").select("id").eq("id", gas.id).is("deleted_at", null);
  check("voided expense gone from active lists", (data ?? []).length === 0);
}

console.log("\nCleanup:");
{
  const now = new Date().toISOString();
  await owner.rpc("fn_return_stock", {
    p_shop_id: SHOP1, p_reason: `EXP-TEST clean ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 2 }], p_engine_ids: [],
  });
  await owner.from("stock_levels").delete().eq("part_id", part.id);
  const rs = await Promise.all([
    owner.from("expenses").update({ deleted_at: now }).like("description", "EXP-TEST%"),
    owner.from("deliveries").update({ deleted_at: now }).like("note", "EXP-TEST%"),
    owner.from("returns").update({ deleted_at: now }).like("reason", "EXP-TEST%"),
    owner.from("receivings").update({ deleted_at: now }).like("note", "EXP-TEST%"),
    owner.from("parts").update({ deleted_at: now }).eq("id", part.id),
  ]);
  const err = rs.find((r) => r.error)?.error;
  check("fixtures cleaned", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
