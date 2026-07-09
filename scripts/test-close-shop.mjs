/**
 * Close-shop guard verification — mirrors the closeShop action's checks.
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
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

const owner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
{
  const { error } = await owner.auth.signInWithPassword({
    email: "owner@jerrysmarine.test",
    password: "Owner!Dev2026",
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

console.log("Guard on a shop that still has stock/staff (Branch 1):");
{
  const SHOP1 = "a0000000-0000-4000-8000-000000000001";
  const g = await guards(SHOP1);
  const blocked = g.units > 0 || g.engines > 0 || g.staff > 0 || g.pending > 0;
  check(
    `Branch 1 close would be BLOCKED (units=${g.units}, engines=${g.engines}, staff=${g.staff}, pending=${g.pending})`,
    blocked
  );
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
