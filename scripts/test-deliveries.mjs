/**
 * Deliverable 4 verification — deliveries auto-land, returns, guards, ledger.
 * Run: node scripts/test-deliveries.mjs
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
const SHOP2 = "a0000000-0000-4000-8000-000000000002";
const RUN = Date.now().toString(36).toUpperCase();
const SERIAL = `DLV-TEST-${RUN}`;

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

const masterQty = async (partId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId).is("shop_id", null).maybeSingle()).data?.qty ?? 0;
const shopQty = async (partId, shopId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId).eq("shop_id", shopId).maybeSingle()).data?.qty ?? 0;

console.log("Setup: part with 20 in master + engine in master");
const { data: cat } = await owner.from("product_categories").select("id").eq("name", "Engine Parts").single();
const { data: part } = await owner.from("parts")
  .insert({ name: `DLV-TEST Propeller ${RUN}`, category_id: cat.id, cost_centavos: 80000, price_centavos: 120000 })
  .select().single();
const { data: model } = await owner.from("engine_models").select("id").eq("model", "M18E2").single();
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `DLV-TEST setup ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 20, unit_cost_centavos: 80000 }],
  p_engines: [{ serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new", cost_centavos: 3_000_000, price_centavos: 3_800_000, warranty_months: null }],
});
const { data: engine } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();
check("fixtures ready (master=20, engine in_master)", (await masterQty(part.id)) === 20 && !!engine);

console.log("\nDelivery (auto-land):");
const { data: dlvId, error: dlvErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: SHOP1,
  p_note: `DLV-TEST weekly restock ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 8 }],
  p_engine_ids: [engine.id],
});
check("fn_deliver_stock succeeded", !dlvErr, dlvErr?.message);
check("master 20 → 12", (await masterQty(part.id)) === 12);
check("shop1 stock = 8 (auto-landed)", (await shopQty(part.id, SHOP1)) === 8);
{
  const { data: e } = await owner.from("engines").select("status, shop_id").eq("id", engine.id).single();
  check("engine delivered @ shop1", e?.status === "delivered" && e?.shop_id === SHOP1);
}
{
  const { data: moves } = await owner.from("stock_movements").select("*").eq("delivery_id", dlvId);
  check("ledger: 4 rows (− master / + shop, part + engine)", moves?.length === 4, `(got ${moves?.length})`);
  const partOut = moves?.find((m) => m.part_id === part.id && m.qty_change === -8 && m.shop_id === null);
  const partIn = moves?.find((m) => m.part_id === part.id && m.qty_change === 8 && m.shop_id === SHOP1);
  check("ledger: part −8 master, +8 shop1", !!partOut && !!partIn);
}

console.log("\nEmployee visibility after delivery:");
{
  const { data } = await emp1.from("shop_stock").select("*").eq("part_id", part.id);
  check("branch1 employee sees delivered part (qty 8, no cost)", data?.length === 1 && data[0].qty === 8 && !("cost_centavos" in data[0]));
  const { data: se } = await emp1.from("shop_engines").select("*").eq("engine_id", engine.id);
  check("branch1 employee sees delivered engine", se?.length === 1);
}

console.log("\nGuards:");
{
  const { error } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: SHOP1, p_note: "too much", p_parts: [{ part_id: part.id, qty: 999 }], p_engine_ids: [],
  });
  check("insufficient master stock rejected", !!error && /not enough/i.test(error.message));
}
{
  const { error } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: SHOP2, p_note: "already gone", p_parts: [], p_engine_ids: [engine.id],
  });
  check("engine already delivered can't deliver again", !!error);
}
{
  const { error } = await emp1.rpc("fn_deliver_stock", {
    p_shop_id: SHOP1, p_note: "sneaky", p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("EMPLOYEE cannot deliver", !!error && /owner/i.test(error.message));
}
{
  const { error } = await emp1.rpc("fn_return_stock", {
    p_shop_id: SHOP1, p_reason: "sneaky", p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("EMPLOYEE cannot return", !!error && /owner/i.test(error.message));
}
{
  const { error } = await owner.rpc("fn_return_stock", {
    p_shop_id: SHOP2, p_reason: "wrong shop", p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("return from shop without stock rejected", !!error);
}

console.log("\nReturn (shop → master):");
const { data: retId, error: retErr } = await owner.rpc("fn_return_stock", {
  p_shop_id: SHOP1,
  p_reason: `DLV-TEST slow mover ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 3 }],
  p_engine_ids: [engine.id],
});
check("fn_return_stock succeeded", !retErr, retErr?.message);
check("shop1 8 → 5", (await shopQty(part.id, SHOP1)) === 5);
check("master 12 → 15", (await masterQty(part.id)) === 15);
{
  const { data: e } = await owner.from("engines").select("status, shop_id").eq("id", engine.id).single();
  check("engine back in_master", e?.status === "in_master" && e?.shop_id === null);
}
{
  const { data: moves } = await owner.from("stock_movements").select("*").eq("return_id", retId);
  check("ledger: 4 return rows", moves?.length === 4, `(got ${moves?.length})`);
}

console.log("\nDelivery note data:");
{
  const { data: d } = await owner
    .from("deliveries")
    .select("id, shops(name), delivery_lines(qty, parts(name), engines(serial_number))")
    .eq("id", dlvId)
    .single();
  check("delivery joins for note render", d?.shops?.name?.includes("Branch 1") && d?.delivery_lines?.length === 2);
}

console.log("\nCleanup (soft delete; ledger stays):");
{
  const now = new Date().toISOString();
  await owner.from("stock_levels").delete().eq("part_id", part.id);
  const r1 = await owner.from("deliveries").update({ deleted_at: now }).eq("id", dlvId);
  const r2 = await owner.from("returns").update({ deleted_at: now }).eq("id", retId);
  const r3 = await owner.from("receivings").update({ deleted_at: now }).like("note", `DLV-TEST%`);
  const r4 = await owner.from("engines").update({ deleted_at: now }).eq("id", engine.id);
  const r5 = await owner.from("parts").update({ deleted_at: now }).eq("id", part.id);
  const err = r1.error ?? r2.error ?? r3.error ?? r4.error ?? r5.error;
  check("fixtures soft-deleted", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
