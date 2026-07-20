/**
 * Close-shop guard verification â€” mirrors the closeShop action's checks.
 * Run: node scripts/test-close-shop.mjs
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
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "âœ“" : "âœ—"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

const owner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
{
  const { error } = await owner.auth.signInWithPassword({
    email: "robertmaestro09@gmail.com",
    password: "rajonrondo09",
  });
  if (error) throw new Error(error.message);
}

// replicate the action's guard queries for a given shop
async function guards(shopId) {
  const [stock, engines, staff, sales, losses] = await Promise.all([
    owner.from("stock_levels").select("qty").eq("shop_id", shopId).gt("qty", 0),
    owner.from("engines").select("id", { count: "exact", head: true })
      .eq("shop_id", shopId).eq("status", "delivered").is("deleted_at", null),
    owner.from("profiles").select("id", { count: "exact", head: true })
      .eq("shop_id", shopId).eq("active", true).is("deleted_at", null),
    owner.from("sales").select("id", { count: "exact", head: true })
      .eq("shop_id", shopId).in("status", ["pending", "questioned"]).is("deleted_at", null),
    owner.from("losses").select("id", { count: "exact", head: true })
      .eq("shop_id", shopId).in("status", ["pending", "questioned"]).is("deleted_at", null),
  ]);
  return {
    units: (stock.data ?? []).reduce((s, r) => s + r.qty, 0),
    engines: engines.count ?? 0,
    staff: staff.count ?? 0,
    pending: (sales.count ?? 0) + (losses.count ?? 0),
  };
}

// Self-provisioned blocked case — never a hardcoded seed UUID (those are gone
// since the fresh-start wipe, and were real branches before it).
console.log("Guard on a shop that still has stock:");
{
  const { data: shopB } = await owner
    .from("shops")
    .insert({ name: `CLOSE-TEST Blocked ${RUN}`, active: true })
    .select()
    .single();
  const { data: partB } = await admin
    .from("parts")
    .insert({ name: `CLOSE-TEST Part ${RUN}`, cost_centavos: 100, price_centavos: 200 })
    .select()
    .single();
  await admin.from("stock_levels").insert({ part_id: partB.id, shop_id: shopB.id, qty: 3 });

  const g = await guards(shopB.id);
  const blocked = g.units > 0 || g.engines > 0 || g.staff > 0 || g.pending > 0;
  check(`a shop still holding stock would be BLOCKED (units=${g.units})`, blocked);

  await admin.from("stock_levels").delete().eq("part_id", partB.id);
  await admin.from("parts").delete().eq("id", partB.id);
  await admin.from("shops").delete().eq("id", shopB.id);
}

console.log("\nFull lifecycle on a throwaway shop:");
const { data: shop } = await owner
  .from("shops")
  .insert({ name: `CLOSE-TEST Branch ${RUN}`, location: "Test", active: true })
  .select()
  .single();
check("shop created", !!shop);

{
  const g = await guards(shop.id);
  check("empty shop passes all guards", g.units === 0 && g.engines === 0 && g.staff === 0 && g.pending === 0);
}
{
  const { error } = await owner
    .from("shops")
    .update({ active: false, deleted_at: new Date().toISOString() })
    .eq("id", shop.id);
  check("close (soft-delete) succeeds", !error, error?.message);
}
{
  const { data } = await owner.from("shops").select("id").eq("id", shop.id).is("deleted_at", null);
  check("closed shop gone from active lists", (data ?? []).length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
