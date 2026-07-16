/**
 * Shop-scoped product photos (0015 + 0019) — employees may add/replace photos
 * ONLY for items in their OWN shop; everything else stays owner-only.
 *
 * Proves:
 *   • an employee can upload / set / replace / clear a photo for a part
 *     stocked at their shop, and for an engine DELIVERED to their shop
 *   • the scoped function refuses items outside the shop, and refuses a path
 *     belonging to another product
 *   • storage refuses arbitrary object names and foreign product ids
 *   • a second shop cannot touch the first shop's item
 *   • the direct parts-table write stays blocked; the owner is unaffected
 *
 * Provisions its own two shops — it must never write into a real branch. Every
 * object it uploads is removed by path before cleanup.
 *
 * Run: node scripts/test-shop-images.mjs
 */
import {
  owner, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const BUCKET = "product-images";

// Objects THIS run uploaded. The harness does not clean Storage, so we remove
// exactly these paths — never a bucket-wide list-and-delete.
const uploaded = [];
const track = (p) => (uploaded.push(p), p);

const A = await provisionShop("IMG2 A");
const B = await provisionShop("IMG2 B");
const empA = A.client;
const empB = B.client;

const WEBP_1PX = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=",
  "base64"
);

section("Setup: one part delivered to shop A, one part master-only:");
const inShop = await seedPart({ label: "InShop", cost: 100, price: 200 });
const notInShop = await seedPart({ label: "MasterOnly", cost: 100, price: 200 });
await receive({ parts: [
  { part_id: inShop.id, qty: 3, unit_cost_centavos: 100 },
  { part_id: notInShop.id, qty: 3, unit_cost_centavos: 100 },
] });

// Since 0028/0029 a delivery no longer auto-lands — it sits in transit until
// the shop confirms. fn_can_edit_product_image reads stock_levels, so without
// the confirm step the shop would have NO stock row and could not edit at all.
await deliverAndConfirm(A, { parts: [{ part_id: inShop.id, qty: 3 }] });
{
  const { data } = await empA.from("shop_stock").select("qty").eq("part_id", inShop.id).single();
  check("fixtures ready: part landed in shop A", data?.qty === 3, `qty=${data?.qty}`);
}

section("Employee CAN manage photos for their own shop's items:");
{
  const { error } = await empA.storage
    .from(BUCKET).upload(track(`${inShop.id}.webp`), WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("upload for own-shop item allowed", !error, error?.message);
}
{
  const { data, error } = await empA.rpc("fn_set_product_image", {
    p_kind: "part", p_id: inShop.id, p_clear: false,
  });
  check("image_path set via scoped function", !error && data === `${inShop.id}.webp`, error?.message);
  const { data: v } = await empA.from("shop_stock").select("image_path").eq("part_id", inShop.id).single();
  check("shop_stock view shows the new photo", v?.image_path === `${inShop.id}.webp`);
}
{
  const { error } = await empA.storage
    .from(BUCKET).upload(`${inShop.id}.webp`, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("replace (upsert) allowed for own-shop item", !error, error?.message);
}

section("Versioned paths (cache-proof replace):");
const vPath = track(`${inShop.id}-${Date.now()}.webp`);
{
  const up = await empA.storage
    .from(BUCKET).upload(vPath, WEBP_1PX, { contentType: "image/webp" });
  check("versioned upload allowed for own-shop item", !up.error, up.error?.message);
  const { data, error } = await empA.rpc("fn_set_product_image", {
    p_kind: "part", p_id: inShop.id, p_path: vPath, p_clear: false,
  });
  check("versioned path accepted by scoped function", !error && data === vPath, error?.message);
  const { data: v } = await empA.from("shop_stock").select("image_path").eq("part_id", inShop.id).single();
  check("shop_stock view shows the versioned photo", v?.image_path === vPath);
  const rm = await empA.storage.from(BUCKET).remove([`${inShop.id}.webp`]);
  check("old object deletable after the swap", !rm.error, rm.error?.message);
  uploaded.splice(uploaded.indexOf(`${inShop.id}.webp`), 1); // already removed
}
{
  const { error } = await empA.rpc("fn_set_product_image", {
    p_kind: "part", p_id: inShop.id, p_path: `${notInShop.id}-123.webp`, p_clear: false,
  });
  check(
    "path pointing at another product's id rejected",
    !!error && /invalid image path/i.test(error.message),
    error?.message
  );
}

section("Engines delivered to the shop are editable too:");
const model = await seedEngineModel({ brand: "IMG2", model: "Photo", hp: 15 });
const rcvId = await receive({ engines: [
  { serial_number: `IMG2-${RUN}-SN1`, engine_model_id: model.id, cost_centavos: 100, price_centavos: 200 },
  { serial_number: `IMG2-${RUN}-SN2`, engine_model_id: model.id, cost_centavos: 100, price_centavos: 200 },
] });
const { data: rcvLines } = await owner
  .from("receiving_lines").select("engine_id").eq("receiving_id", rcvId).not("engine_id", "is", null);
const [engDelivered, engMaster] = rcvLines.map((r) => r.engine_id);
await deliverAndConfirm(A, { engine_ids: [engDelivered] });
{
  const ePath = track(`${engDelivered}-${Date.now()}.webp`);
  const up = await empA.storage.from(BUCKET).upload(ePath, WEBP_1PX, { contentType: "image/webp" });
  check("upload for own-shop ENGINE allowed", !up.error, up.error?.message);
  const { data, error } = await empA.rpc("fn_set_product_image", {
    p_kind: "engine", p_id: engDelivered, p_path: ePath, p_clear: false,
  });
  check("engine image set via scoped function", !error && data === ePath, error?.message);
  const { data: v } = await empA.from("shop_engines").select("image_path").eq("engine_id", engDelivered).single();
  check("shop_engines view shows the engine photo", v?.image_path === ePath);
}
{
  // Still in master (status='in_master') — the engine branch of
  // fn_can_edit_product_image requires status='delivered' AND own shop.
  const { error } = await empA.rpc("fn_set_product_image", {
    p_kind: "engine", p_id: engMaster, p_clear: false,
  });
  check("engine still in master rejected", !!error && /own shop/i.test(error.message), error?.message);
}

section("Employee CANNOT touch anything outside their shop:");
{
  const { error } = await empA.storage
    .from(BUCKET).upload(`${notInShop.id}.webp`, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("upload for master-only item denied", !!error);
}
{
  const { error } = await empA.rpc("fn_set_product_image", {
    p_kind: "part", p_id: notInShop.id, p_clear: false,
  });
  check("scoped function rejects foreign item", !!error && /own shop/i.test(error.message));
}
{
  const { error } = await empA.storage
    .from(BUCKET).upload(`random-name-${RUN}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("arbitrary object names denied", !!error);
}
{
  const { data, error } = await empA
    .from("parts").update({ image_path: "hack.webp" }).eq("id", inShop.id).select();
  check("direct parts-table write still blocked", !!error || (data ?? []).length === 0);
}

section("A DIFFERENT shop cannot touch shop A's item:");
{
  const { error } = await empB.storage
    .from(BUCKET).upload(`${inShop.id}-${Date.now()}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("shop B cannot upload for shop A's part", !!error);
}
{
  const { error } = await empB.rpc("fn_set_product_image", {
    p_kind: "part", p_id: inShop.id, p_clear: false,
  });
  check("shop B rejected by the scoped function", !!error && /own shop/i.test(error.message));
}
{
  const { data, error } = await empB.storage.from(BUCKET).remove([vPath]);
  check("shop B cannot delete shop A's object", !!error || (data ?? []).length === 0);
}

section("Employee can also clear a photo on their own item:");
{
  const { error } = await empA.rpc("fn_set_product_image", {
    p_kind: "part", p_id: inShop.id, p_clear: true,
  });
  const { error: rmErr } = await empA.storage.from(BUCKET).remove([vPath]);
  check("clear + object delete allowed for own-shop item", !error && !rmErr, error?.message ?? rmErr?.message);
  uploaded.splice(uploaded.indexOf(vPath), 1); // already removed
  const { data: v } = await empA.from("shop_stock").select("image_path").eq("part_id", inShop.id).single();
  check("shop_stock view shows the photo cleared", v?.image_path === null);
}

section("Owner unaffected:");
{
  const p = `${notInShop.id}.webp`;
  const { error } = await owner.storage
    .from(BUCKET).upload(p, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("owner uploads anywhere in the bucket", !error, error?.message);
  await owner.storage.from(BUCKET).remove([p]);
}

section("Cleanup:");
// Remove exactly the paths this run uploaded, then prove none survive.
if (uploaded.length) await owner.storage.from(BUCKET).remove(uploaded);
{
  const left = [];
  for (const p of uploaded) {
    const { data } = await owner.storage.from(BUCKET).list("", { limit: 100, search: p });
    if ((data ?? []).some((o) => o.name === p)) left.push(p);
  }
  check("every uploaded object removed from storage", left.length === 0, left.join(", "));
}
await cleanup();
summary();
