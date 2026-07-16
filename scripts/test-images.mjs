/**
 * Product images — storage RLS over the real API surface, with the PUBLIC key.
 *
 * Proves:
 *   • the owner owns the write path: upload, versioned replace, delete
 *   • product-images is PUBLIC-READ — the CDN serves the object to anyone
 *   • employees + anon can VIEW but never write an object outside their shop
 *   • image_path moves ONLY through fn_set_product_image, and the path is
 *     locked to the product's own id (no pointing at someone else's object)
 *   • the private `receipts` bucket stays shut to employees + anon
 *
 * (The canvas resize→WebP pipeline is browser-only; verified manually in UI.)
 *
 * Provisions its own shop — it must never write into a real branch. Every
 * object it uploads is removed by path before cleanup.
 *
 * Run: node scripts/test-images.mjs
 */
import {
  owner, admin, anonClient, RUN, check, section, summary,
  provisionShop, seedPart, cleanup, SB_URL,
} from "./_harness.mjs";

const BUCKET = "product-images";
const publicUrl = (p) => `${SB_URL}/storage/v1/object/public/${BUCKET}/${p}`;

// Objects THIS run uploaded. The harness does not clean Storage, so we remove
// exactly these paths — never a bucket-wide list-and-delete.
const uploaded = [];
const track = (p) => (uploaded.push(p), p);

const A = await provisionShop("IMG A");
const emp = A.client;
const anon = anonClient();

// A tiny valid WebP (1x1) — stands in for the browser-produced blob.
const WEBP_1PX = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=",
  "base64"
);

section("Setup (as owner):");
// Master-only: never delivered anywhere, so NO shop may touch its photo.
const part = await seedPart({ label: "IMG Part", cost: 100, price: 200 });
check("owner can create a part", !!part.id);

section("Owner upload (the app's exact flow):");
const v1 = track(`${part.id}-${Date.now()}.webp`);
{
  const { error } = await owner.storage
    .from(BUCKET).upload(v1, WEBP_1PX, { contentType: "image/webp" });
  check("owner can upload to product-images", !error, error?.message);
}
{
  const { data, error } = await owner.rpc("fn_set_product_image", {
    p_kind: "part", p_id: part.id, p_path: v1, p_clear: false,
  });
  check("image_path persisted via fn_set_product_image", !error && data === v1, error?.message);
  const { data: row } = await owner.from("parts").select("image_path").eq("id", part.id).single();
  check("parts.image_path holds the versioned path", row?.image_path === v1);
}

section("Read access (view for everyone):");
{
  const res = await fetch(publicUrl(v1));
  const type = res.headers.get("content-type") ?? "";
  check("public CDN URL serves the object", res.status === 200, `got ${res.status}`);
  check("stored object is WebP", type.includes("webp"), `got ${type}`);
}
{
  const res = await fetch(publicUrl(v1), { headers: {} });
  check("anon (no session) can read the object", res.status === 200, `got ${res.status}`);
}
{
  const { data, error } = await emp.from("shop_stock").select("image_path").limit(1);
  check("employee view exposes image_path (no error)", data !== null, error?.message);
}

section("Versioned replace (0019 — cache-proof):");
{
  // Pre-0019 a replace reused a FIXED {id}.webp, so the URL never changed and
  // the CDN kept serving the stale file. Every replace must mint a NEW path.
  const v2 = track(`${part.id}-${Date.now() + 1}.webp`);
  const { error: upErr } = await owner.storage
    .from(BUCKET).upload(v2, WEBP_1PX, { contentType: "image/webp" });
  check("replace uploads to a NEW versioned path", !upErr, upErr?.message);
  check("replacement URL differs from the original", v2 !== v1);

  const { data, error } = await owner.rpc("fn_set_product_image", {
    p_kind: "part", p_id: part.id, p_path: v2, p_clear: false,
  });
  check("fn_set_product_image accepts the new version", !error && data === v2, error?.message);

  // The app deletes the superseded object after the swap.
  const { error: rmErr } = await owner.storage.from(BUCKET).remove([v1]);
  check("superseded object deletable after the swap", !rmErr, rmErr?.message);
  const { data: listing } = await owner.storage.from(BUCKET).list("", { limit: 100, search: v1 });
  check("superseded object gone from bucket", !(listing ?? []).some((o) => o.name === v1));
  uploaded.splice(uploaded.indexOf(v1), 1); // already removed
}
{
  // p_path omitted → the legacy fixed name is still a valid path for the product.
  const { data, error } = await owner.rpc("fn_set_product_image", {
    p_kind: "part", p_id: part.id, p_clear: false,
  });
  check("omitted path defaults to {id}.webp", !error && data === `${part.id}.webp`, error?.message);
}

section("Path is locked to the product's own id:");
{
  const other = await seedPart({ label: "IMG Other", cost: 100, price: 200 });
  const { error } = await owner.rpc("fn_set_product_image", {
    p_kind: "part", p_id: part.id, p_path: `${other.id}-123.webp`, p_clear: false,
  });
  check(
    "owner cannot point a product at another product's object",
    !!error && /invalid image path/i.test(error.message),
    error?.message
  );
}
{
  const { error } = await owner.rpc("fn_set_product_image", {
    p_kind: "part", p_id: part.id, p_path: `../../etc/passwd`, p_clear: false,
  });
  check("traversal-style path rejected", !!error && /invalid image path/i.test(error.message));
}

section("Write lockout (employees + anon can VIEW, never MANAGE):");
{
  // NOT "employees cannot upload" — since 0015 they CAN, for their OWN shop's
  // items. This part is master-only, so it is out of every shop's scope.
  const { error } = await emp.storage
    .from(BUCKET).upload(`${part.id}-9.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("employee cannot upload for a master-only item", !!error, "upload succeeded!");
}
{
  const { error } = await emp.storage
    .from(BUCKET).upload(`sneaky-${RUN}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("employee cannot upload an arbitrary object name", !!error, "upload succeeded!");
}
{
  const v2 = uploaded[uploaded.length - 1];
  const { data, error } = await emp.storage.from(BUCKET).remove([v2]);
  // storage remove returns an empty list (no error) when RLS filters the object out
  check("employee cannot delete", !!error || (data ?? []).length === 0, "delete succeeded!");
  const still = await fetch(publicUrl(v2));
  check("object survived employee delete attempt", still.status === 200);
}
{
  const { error } = await anon.storage
    .from(BUCKET).upload(`anon-${RUN}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("anon cannot upload", !!error);
}
{
  const { data, error } = await emp
    .from("parts").update({ image_path: "hacked.webp" }).eq("id", part.id).select();
  check("employee cannot change image_path in DB", !!error || (data ?? []).length === 0);
}
{
  const { error } = await emp.rpc("fn_set_product_image", {
    p_kind: "part", p_id: part.id, p_clear: false,
  });
  check(
    "fn_set_product_image rejects an item outside the employee's shop",
    !!error && /own shop/i.test(error.message),
    error?.message
  );
}

section("Private receipts bucket stays shut:");
{
  const { error } = await emp.storage
    .from("receipts").upload(`r-${RUN}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("employee cannot upload to receipts", !!error);
}
{
  const { error } = await anon.storage
    .from("receipts").upload(`r-anon-${RUN}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("anon cannot upload to receipts", !!error);
}
{
  const { data: buckets } = await admin.storage.listBuckets();
  const receipts = (buckets ?? []).find((b) => b.name === "receipts");
  const products = (buckets ?? []).find((b) => b.name === BUCKET);
  check("receipts bucket is private", receipts?.public === false, `public=${receipts?.public}`);
  check("product-images bucket is public-read", products?.public === true);
}

section("Cleanup on delete (app flow: clear path, then remove object):");
{
  const v2 = uploaded[uploaded.length - 1];
  const { error } = await owner.rpc("fn_set_product_image", {
    p_kind: "part", p_id: part.id, p_clear: true,
  });
  check("owner can clear image_path", !error, error?.message);
  const { error: rmErr } = await owner.storage.from(BUCKET).remove([v2]);
  check("owner delete removes storage object", !rmErr, rmErr?.message);
  // The public URL may serve from CDN cache briefly — the bucket listing is
  // the source of truth for deletion.
  const { data: listing } = await owner.storage.from(BUCKET).list("", { limit: 100, search: v2 });
  check("object gone from bucket", !(listing ?? []).some((o) => o.name === v2));
  uploaded.splice(uploaded.indexOf(v2), 1);
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
