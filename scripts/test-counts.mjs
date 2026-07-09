/**
 * Deliverable 9 verification — snapshot freezes stock, count entry, variance,
 * shortage → normal loss queue → approval deducts.
 * Run: node scripts/test-counts.mjs
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

const shopQty = async (partId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId).eq("shop_id", SHOP1).maybeSingle()).data?.qty ?? 0;

console.log("Setup: two parts at Branch 1 (12 hooks, 5 floats)");
const { data: cat } = await owner.from("product_categories").select("id").eq("name", "Fisherman Gear").single();
const { data: hooks } = await owner.from("parts")
  .insert({ name: `CNT-TEST Hooks ${RUN}`, category_id: cat.id, cost_centavos: 500, price_centavos: 1000 })
  .select().single();
const { data: floats } = await owner.from("parts")
  .insert({ name: `CNT-TEST Floats ${RUN}`, category_id: cat.id, cost_centavos: 2000, price_centavos: 3500 })
  .select().single();
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `CNT-TEST setup ${RUN}`,
  p_parts: [
    { part_id: hooks.id, qty: 12, unit_cost_centavos: 500 },
    { part_id: floats.id, qty: 5, unit_cost_centavos: 2000 },
  ],
  p_engines: [],
});
await owner.rpc("fn_deliver_stock", {
  p_shop_id: SHOP1, p_note: `CNT-TEST delivery ${RUN}`,
  p_parts: [
    { part_id: hooks.id, qty: 12 },
    { part_id: floats.id, qty: 5 },
  ],
  p_engine_ids: [],
});
check("stock at Branch 1: hooks 12, floats 5", (await shopQty(hooks.id)) === 12 && (await shopQty(floats.id)) === 5);

console.log("\nSnapshot (freeze):");
const { data: snapId, error: snapErr } = await owner.rpc("fn_create_count_snapshot", {
  p_shop_id: SHOP1, p_note: `CNT-TEST month-end ${RUN}`,
});
check("snapshot created", !snapErr, snapErr?.message);
const { data: snapLines } = await owner
  .from("count_snapshot_lines")
  .select("id, part_id, expected_qty")
  .eq("snapshot_id", snapId);
const hookLine = snapLines?.find((l) => l.part_id === hooks.id);
const floatLine = snapLines?.find((l) => l.part_id === floats.id);
check("lines include both parts with expected qty", hookLine?.expected_qty === 12 && floatLine?.expected_qty === 5);

// stock moves AFTER snapshot must not change expected (frozen figure)
{
  const { data: saleX } = await emp1.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: hooks.id, qty: 2 }], p_engine_ids: [],
  });
  await owner.rpc("fn_approve_sale", { p_sale_id: saleX, p_note: null });
  const { data: after } = await owner
    .from("count_snapshot_lines").select("expected_qty").eq("id", hookLine.id).single();
  check("expected stays frozen after later sale (12)", after?.expected_qty === 12);
  // put stock back so the count math below is clean
  await owner.from("sales").update({ deleted_at: new Date().toISOString() }).eq("id", saleX);
  await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `CNT-TEST refill ${RUN}`,
    p_parts: [{ part_id: hooks.id, qty: 2, unit_cost_centavos: 500 }], p_engines: [],
  });
  await owner.rpc("fn_deliver_stock", {
    p_shop_id: SHOP1, p_note: `CNT-TEST refill dlv ${RUN}`,
    p_parts: [{ part_id: hooks.id, qty: 2 }], p_engine_ids: [],
  });
  check("stock restored to 12 for the count", (await shopQty(hooks.id)) === 12);
}

console.log("\nEnter counts (hooks: 9 → short 3; floats: 5 → match):");
{
  const { error } = await owner.rpc("fn_save_count", {
    p_snapshot_id: snapId,
    p_lines: [
      { line_id: hookLine.id, counted_qty: 9 },
      { line_id: floatLine.id, counted_qty: 5 },
    ],
  });
  check("counts saved", !error, error?.message);
}
{
  const { error } = await emp1.rpc("fn_save_count", {
    p_snapshot_id: snapId, p_lines: [{ line_id: hookLine.id, counted_qty: 12 }],
  });
  check("employee cannot enter counts", !!error && /owner/i.test(error.message));
}

console.log("\nShortage → loss queue:");
const { data: created, error: shortErr } = await owner.rpc("fn_record_count_shortages", {
  p_snapshot_id: snapId,
  p_lines: [
    { line_id: hookLine.id, reason: "nawala" },
    { line_id: floatLine.id, reason: "nawala" }, // no shortage — must be skipped
  ],
});
check("1 loss created (match line skipped)", !shortErr && created === 1, shortErr?.message ?? `(created ${created})`);

const { data: loss } = await owner
  .from("losses")
  .select("id, qty, reason, status, shop_id, note, description")
  .eq("part_id", hooks.id)
  .in("status", ["pending"])
  .like("note", "Month-end count%")
  .single();
check("loss: qty 3, nawala, PENDING, right shop", loss?.qty === 3 && loss?.reason === "nawala" && loss?.shop_id === SHOP1);
check("loss note carries expected/counted", /expected 12, counted 9/.test(loss?.note ?? ""));
{
  const { data: again } = await owner.rpc("fn_record_count_shortages", {
    p_snapshot_id: snapId, p_lines: [{ line_id: hookLine.id, reason: "nawala" }],
  });
  check("idempotent: re-send creates 0", again === 0);
}
{
  const { data: v } = await emp1.from("losses").select("id, status").eq("id", loss.id).single();
  check("employee sees the count loss in their submissions", !!v);
}

console.log("\nApprove through the NORMAL queue:");
{
  const { error } = await owner.rpc("fn_approve_loss", { p_loss_id: loss.id, p_note: null });
  check("approval succeeded", !error, error?.message);
  check("shop stock 12 → 9 (deducted)", (await shopQty(hooks.id)) === 9);
  const { data: l2 } = await owner.from("losses").select("value_centavos").eq("id", loss.id).single();
  check("write-off valued at cost 3×₱5", l2?.value_centavos === 1500, `(got ${l2?.value_centavos})`);
}

console.log("\nCleanup:");
{
  const now = new Date().toISOString();
  await owner.rpc("fn_return_stock", {
    p_shop_id: SHOP1, p_reason: `CNT-TEST clean ${RUN}`,
    p_parts: [
      { part_id: hooks.id, qty: 9 },
      { part_id: floats.id, qty: 5 },
    ],
    p_engine_ids: [],
  });
  await owner.from("stock_levels").delete().in("part_id", [hooks.id, floats.id]);
  const rs = await Promise.all([
    owner.from("count_snapshots").update({ deleted_at: now }).eq("id", snapId),
    owner.from("losses").update({ deleted_at: now }).eq("id", loss.id),
    owner.from("receivings").update({ deleted_at: now }).like("note", "CNT-TEST%"),
    owner.from("deliveries").update({ deleted_at: now }).like("note", "CNT-TEST%"),
    owner.from("returns").update({ deleted_at: now }).like("reason", "CNT-TEST%"),
    owner.from("parts").update({ deleted_at: now }).in("id", [hooks.id, floats.id]),
  ]);
  const err = rs.find((r) => r.error)?.error;
  check("fixtures cleaned", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
