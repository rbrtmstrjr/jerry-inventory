/**
 * Product images verification — storage RLS (owner write / employee+public
 * read-only), upload round-trip, path persistence, cleanup on delete.
 * (The canvas resize→WebP pipeline is browser-only; verified manually in UI.)
 * Run: node scripts/test-images.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

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
const emp1 = await signIn("branch1@jerrysmarine.test", "Branch1!Dev2026");
const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});

// A tiny valid WebP file (1×1) — stands in for the browser-produced blob.
const WEBP_1PX = Buffer.from(
  "UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAQAcJaQAA3AA/v3AgAA=",
  "base64"
);

console.log("Setup: test part");
const { data: part } = await owner
  .from("parts")
  .insert({ name: `IMG-TEST Part ${RUN}`, cost_centavos: 100, price_centavos: 200 })
  .select()
  .single();
const objectPath = `${part.id}.webp`;

console.log("\nOwner upload (the app's exact flow):");
{
  const { error } = await owner.storage
    .from(BUCKET)
    .upload(objectPath, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("owner can upload to product-images", !error, error?.message);
}
{
  const { error } = await owner.storage
    .from(BUCKET)
    .upload(objectPath, WEBP_1PX, { upsert: true, contentType: "image/webp" });
  check("re-upload to same path (replace, no duplicates)", !error, error?.message);
}
{
  const { error } = await owner.from("parts").update({ image_path: objectPath }).eq("id", part.id);
  check("image_path persisted on part", !error, error?.message);
}

console.log("\nRead access (view for everyone):");
{
  const url = `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;
  const res = await fetch(url);
  const type = res.headers.get("content-type") ?? "";
  check("public CDN URL serves the object", res.status === 200, `(got ${res.status})`);
  check("stored object is WebP", type.includes("webp"), `(got ${type})`);
}
{
  const { data } = await emp1.from("shop_stock").select("image_path").limit(1);
  check("employee view exposes image_path (no error)", data !== null);
}

console.log("\nWrite lockout (employees + anon can VIEW, never MANAGE):");
{
  const { error } = await emp1.storage
    .from(BUCKET)
    .upload(`sneaky-${RUN}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("employee cannot upload", !!error, "(upload succeeded!)");
}
{
  const { data, error } = await emp1.storage.from(BUCKET).remove([objectPath]);
  // storage remove returns empty list (no error) when RLS filters the object out
  check("employee cannot delete", !!error || (data ?? []).length === 0, "(delete succeeded!)");
  const still = await fetch(
    `${env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`
  );
  check("object survived employee delete attempt", still.status === 200);
}
{
  const { error } = await anon.storage
    .from(BUCKET)
    .upload(`anon-${RUN}.webp`, WEBP_1PX, { contentType: "image/webp" });
  check("anon cannot upload", !!error);
}
{
  const { data, error } = await emp1
    .from("parts")
    .update({ image_path: "hacked.webp" })
    .eq("id", part.id)
    .select();
  check("employee cannot change image_path in DB", !!error || (data ?? []).length === 0);
}

console.log("\nCleanup on delete (app flow: soft-delete part removes object):");
{
  // replicate softDeletePart: clear path, soft-delete, remove object
  await owner.from("parts").update({ deleted_at: new Date().toISOString(), image_path: null }).eq("id", part.id);
  const { error } = await owner.storage.from(BUCKET).remove([objectPath]);
  check("owner delete removes storage object", !error, error?.message);
  // the public URL may serve from CDN cache briefly — the bucket listing is
  // the source of truth for deletion
  const { data: listing } = await owner.storage.from(BUCKET).list();
  const stillThere = (listing ?? []).some((o) => o.name === objectPath);
  check("object gone from bucket", !stillThere);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
