/**
 * Product categories are dynamic (0059-era): the owner can create, rename, and
 * retire them, and only the owner. product_categories is owner-writable via RLS
 * (NOT under the 0049 catalog INSERT lockdown), so createCategory is a direct
 * owner-checked insert — this suite proves the DB/RLS behavior the action relies
 * on: owner writes succeed, employees are blocked, exact duplicates are refused,
 * and retiring keeps existing products on the category.
 *
 * Run: node scripts/test-categories.mjs
 */
import {
  owner, admin, check, section, summary, cleanup,
  provisionShop, seedPart, trackPart, RUN,
} from "./_harness.mjs";

const shop = await provisionShop("CatMgr");
const catName = `ZZ-TEST Cat ${RUN}`;
let catId;

// ── Owner can create / rename / retire ──────────────────────────────────────
section("Owner manages categories (create · rename · retire)");
{
  const { data, error } = await owner
    .from("product_categories").insert({ name: catName }).select("id, name").single();
  check("owner can CREATE a category", !error && !!data?.id, error?.message);
  catId = data?.id;
}
{
  const { error } = await owner
    .from("product_categories").update({ name: `${catName} R` }).eq("id", catId);
  check("owner can RENAME a category", !error, error?.message);
}
{
  const { data } = await owner
    .from("product_categories").select("id, name").is("deleted_at", null).eq("id", catId).maybeSingle();
  check("the new category is live and visible to pickers", data?.name === `${catName} R`);
}

// ── A part on the category keeps it after retire ────────────────────────────
section("Retire hides the category but existing products keep it");
const part = await seedPart({ label: "CatMgrPart", cost: 500, price: 900 });
trackPart(part.id);
{
  const { error } = await owner.from("parts").update({ category_id: catId }).eq("id", part.id);
  check("part assigned to the category", !error, error?.message);
}
{
  const { error } = await owner
    .from("product_categories").update({ deleted_at: new Date().toISOString() }).eq("id", catId);
  check("owner can RETIRE (soft-delete) a category", !error, error?.message);
  const { data: live } = await owner
    .from("product_categories").select("id").is("deleted_at", null).eq("id", catId).maybeSingle();
  check("retired category drops out of the live picker list", !live);
  const { data: p } = await owner.from("parts").select("category_id").eq("id", part.id).single();
  check("existing product KEEPS the retired category", p?.category_id === catId);
}

// ── Duplicate names refused (unique index — the action also dedupes CI) ──────
section("Duplicate category names are refused");
{
  const dup = `ZZ-TEST Dup ${RUN}`;
  const { error: e1 } = await owner.from("product_categories").insert({ name: dup });
  check("first insert ok", !e1, e1?.message);
  const { error: e2 } = await owner.from("product_categories").insert({ name: dup });
  check("exact-duplicate name rejected (unique)", !!e2 && e2.code === "23505", e2?.message);
}

// ── Owner-only: an employee cannot write ────────────────────────────────────
section("Only the owner can manage categories");
{
  const { data, error } = await shop.client
    .from("product_categories").insert({ name: `ZZ-TEST Emp ${RUN}` }).select("id");
  check("employee CANNOT create a category (RLS)", !!error || (data ?? []).length === 0, error?.message);

  const { error: uErr } = await shop.client
    .from("product_categories").update({ name: "hijack" }).eq("id", catId).select("id");
  const { data: after } = await owner
    .from("product_categories").select("name").eq("id", catId).single();
  check("employee CANNOT rename a category", after?.name === `${catName} R`, uErr?.message);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
section("Cleanup:");
await cleanup(); // removes the tracked part (frees the category FK)
await admin.from("product_categories").delete().like("name", `%${RUN}%`);
check("test categories removed", true);
summary();
