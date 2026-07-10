/**
 * Shop-scoped product photo verification — employees can add/replace photos
 * ONLY for items in their own shop; everything else stays owner-only.
 * Run: node scripts/test-shop-images.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const SHOP2 = "a0000000-0000-4000-8000-000000000002";
const RUN = Date.now().toString(36).toUpperCase();
const BUCKET = "product-images";

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
const emp2 = await signIn("branch2@jerrysmarine.test", "Branch2!Dev2026");

const WEBP_1PX = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=",
  "base64"
);

console.log("Setup: one part delivered to Branch 2, one part master-only");
const { data: cat } = await owner.from("product_categories").select("id").limit(1).single();
const { data: inShop } = await owner.from("parts")
  .insert({ name: `IMG2-TEST InShop ${RUN}`, category_id: cat.id, cost_centavos: 100, price_centavos: 200 })
  .select().single();
const { data: notInShop } = await owner.from("parts")
  .insert({ name: `IMG2-TEST MasterOnly ${RUN}`, category_id: cat.id, cost_centavos: 100, price_centavos: 200 })
  .select().single();
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `IMG2-TEST ${RUN}`,
  p_parts: [
    { part_id: inShop.id, qty: 3, unit_cost_centavos: 100 },
    { part_id: notInShop.id, qty: 3, unit_cost_centavos: 100 },
  ],
  p_engines: [],
});
const { error: dlvErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: SHOP2, p_note: `IMG2-TEST dlv ${RUN}`,
  p_parts: [{ part_id: inShop.id, qty: 3 }], p_engine_ids: [],
});
check("fixtures ready", !dlvErr, dlvErr?.message);

console.log("\nEmployee CAN manage photos for their own shop's items:");
{
  const { error } = await emp2.storage
    .from(BUCKET)
    .upload(`${inShop.id}.webp`, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("upload for own-shop item allowed", !error, error?.message);
}
{
  const { data, error } = await emp2.rpc("fn_set_product_image", {
    p_kind: "part", p_id: inShop.id, p_clear: false,
  });
  check("image_path set via scoped function", !error && data === `${inShop.id}.webp`, error?.message);
  const { data: v } = await emp2.from("shop_stock").select("image_path").eq("part_id", inShop.id).single();
  check("shop_stock view shows the new photo", v?.image_path === `${inShop.id}.webp`);
}
{
  const { error } = await emp2.storage
    .from(BUCKET)
    .upload(`${inShop.id}.webp`, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("replace (upsert) allowed for own-shop item", !error, error?.message);
}

console.log("\nEmployee CANNOT touch anything outside their shop:");
{
  const { error } = await emp2.storage
    .from(BUCKET)
    .upload(`${notInShop.id}.webp`, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("upload for master-only item denied", !!error);
}
{
  const { error } = await emp2.rpc("fn_set_product_image", {
    p_kind: "part", p_id: notInShop.id, p_clear: false,
  });
  check("scoped function rejects foreign item", !!error && /own shop/i.test(error.message));
}
{
  const { error } = await emp2.storage
    .from(BUCKET)
    .upload(`random-name-${RUN}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("arbitrary object names denied", !!error);
}
{
  const { data, error } = await emp2.from("parts").update({ image_path: "hack.webp" }).eq("id", inShop.id).select();
  check("direct parts-table write still blocked", !!error || (data ?? []).length === 0);
}

console.log("\nEmployee can also clear a photo on their own item:");
{
  const { error } = await emp2.rpc("fn_set_product_image", {
    p_kind: "part", p_id: inShop.id, p_clear: true,
  });
  const { error: rmErr } = await emp2.storage.from(BUCKET).remove([`${inShop.id}.webp`]);
  check("clear + object delete allowed for own-shop item", !error && !rmErr, error?.message ?? rmErr?.message);
}

console.log("\nOwner unaffected:");
{
  const { error } = await owner.storage
    .from(BUCKET)
    .upload(`${notInShop.id}.webp`, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("owner uploads anywhere in the bucket", !error, error?.message);
  await owner.storage.from(BUCKET).remove([`${notInShop.id}.webp`]);
}

console.log("\nCleanup:");
{
  const now = new Date().toISOString();
  await owner.rpc("fn_return_stock", {
    p_shop_id: SHOP2, p_reason: `IMG2-TEST clean ${RUN}`,
    p_parts: [{ part_id: inShop.id, qty: 3 }], p_engine_ids: [],
  });
  await owner.from("stock_levels").delete().in("part_id", [inShop.id, notInShop.id]);
  const rs = await Promise.all([
    owner.from("receivings").update({ deleted_at: now }).like("note", "IMG2-TEST%"),
    owner.from("deliveries").update({ deleted_at: now }).like("note", "IMG2-TEST%"),
    owner.from("returns").update({ deleted_at: now }).like("reason", "IMG2-TEST%"),
    owner.from("parts").update({ deleted_at: now }).in("id", [inShop.id, notInShop.id]),
  ]);
  const err = rs.find((r) => r.error)?.error;
  check("fixtures cleaned", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
