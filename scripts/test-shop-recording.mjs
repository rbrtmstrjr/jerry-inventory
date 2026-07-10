/**
 * Deliverable 5 verification — employees record sales/losses (saved as
 * RECORDED until the shop batch-submits); prices are catalog-authoritative;
 * stock does NOT move on record.
 * Run: node scripts/test-shop-recording.mjs
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
const SERIAL = `SALE-TEST-${RUN}`;

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
const emp2 = await signIn("branch2@jerrysmarine.test", "Branch2!Dev2026");

console.log("Setup: part (₱250) + engine (₱38,000) delivered to Branch 1");
const { data: cat } = await owner.from("product_categories").select("id").eq("name", "Engine Parts").single();
const { data: part } = await owner.from("parts")
  .insert({ name: `SALE-TEST Spark Plug ${RUN}`, category_id: cat.id, cost_centavos: 12000, price_centavos: 25000 })
  .select().single();
const { data: part2 } = await owner.from("parts")
  .insert({ name: `SALE-TEST Undelivered ${RUN}`, category_id: cat.id, cost_centavos: 100, price_centavos: 200 })
  .select().single();
const { data: model } = await owner.from("engine_models").select("id").eq("model", "15MH").single();
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `SALE-TEST setup ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: 12000 }],
  p_engines: [{ serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new", cost_centavos: 3_000_000, price_centavos: 3_800_000, warranty_months: null }],
});
const { data: engine } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();
const { error: dlvErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: SHOP1, p_note: `SALE-TEST delivery ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 6 }], p_engine_ids: [engine.id],
});
check("fixtures delivered to Branch 1", !dlvErr, dlvErr?.message);

console.log("\nRecord sale (employee, Branch 1):");
const { data: saleId, error: saleErr } = await emp1.rpc("fn_record_sale", {
  p_customer_id: null,
  p_customer: { name: `SALE-TEST Mang Kanor ${RUN}`, phone: "0917-111-2222" },
  p_part_lines: [{ part_id: part.id, qty: 2 }],
  p_engine_ids: [engine.id],
});
check("fn_record_sale succeeded", !saleErr, saleErr?.message);
{
  const { data: s } = await emp1
    .from("sales")
    .select("status, total_centavos, customer_id, sale_lines(description, qty, unit_price_centavos, line_total_centavos)")
    .eq("id", saleId).single();
  check("sale is RECORDED (not yet with owner)", s?.status === "recorded");
  check("total = 2×₱250 + ₱38,000 (catalog prices)", s?.total_centavos === 2 * 25000 + 3_800_000, `(got ${s?.total_centavos})`);
  check("customer captured", !!s?.customer_id);
  const partLine = s?.sale_lines.find((l) => l.qty === 2);
  const engLine = s?.sale_lines.find((l) => l.qty === 1);
  check("line descriptions snapshotted", !!partLine?.description && /SN/.test(engLine?.description ?? ""));
}
{
  const { data } = await emp1.from("shop_stock").select("qty").eq("part_id", part.id).single();
  check("stock NOT deducted (still 6 on hand)", data?.qty === 6, `(got ${data?.qty})`);
}
{
  const { data: e } = await owner.from("engines").select("status").eq("id", engine.id).single();
  check("engine still 'delivered' (not sold)", e?.status === "delivered");
}

console.log("\nValidation:");
{
  const { error } = await emp1.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [], p_engine_ids: [engine.id],
  });
  check("engine sale without customer rejected", !!error && /customer/i.test(error.message));
}
{
  const { error } = await emp1.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: { name: "X" },
    p_part_lines: [], p_engine_ids: [engine.id],
  });
  check("engine already in an open sale rejected", !!error && /open sale/i.test(error.message));
}
{
  const { error } = await emp1.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: part2.id, qty: 1 }], p_engine_ids: [],
  });
  check("undelivered item rejected", !!error && /not been delivered/i.test(error.message));
}
{
  const { error } = await emp2.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("Branch 2 can't sell Branch 1's stock", !!error && /not been delivered/i.test(error.message));
}
{
  const { error } = await owner.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  check("owner is not a recording role", !!error && /employee/i.test(error.message));
}

console.log("\nRecord loss:");
const { data: lossId, error: lossErr } = await emp1.rpc("fn_record_loss", {
  p_part_id: part.id, p_engine_id: null, p_qty: 1,
  p_reason: "nasira", p_note: `SALE-TEST nabasag ${RUN}`,
});
check("fn_record_loss succeeded", !lossErr, lossErr?.message);
{
  const { data: l } = await emp1.from("losses")
    .select("status, reason, description").eq("id", lossId).single();
  check("loss RECORDED, reason nasira, described", l?.status === "recorded" && l?.reason === "nasira" && !!l?.description);
}
{
  const { error } = await emp2.rpc("fn_record_loss", {
    p_part_id: part.id, p_engine_id: null, p_qty: 1, p_reason: "nawala", p_note: "x",
  });
  check("Branch 2 can't report Branch 1's item", !!error);
}

console.log("\nCancel before submitting:");
{
  const { data, error } = await emp1.from("losses").delete().eq("id", lossId).select("id");
  check("employee can cancel own recorded loss", !error && data?.length === 1);
}
{
  const { data, error } = await emp2.from("sales").delete().eq("id", saleId).select("id");
  check("other shop cannot cancel the sale", (data ?? []).length === 0 || !!error);
}
{
  const { data, error } = await emp1.from("sales").delete().eq("id", saleId).select("id");
  check("employee can cancel own recorded sale", !error && data?.length === 1);
}

console.log("\nCleanup:");
{
  const now = new Date().toISOString();
  // return remaining stock/engine to master, then soft-delete catalog fixtures
  const { error: retErr } = await owner.rpc("fn_return_stock", {
    p_shop_id: SHOP1, p_reason: `SALE-TEST cleanup ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 6 }], p_engine_ids: [engine.id],
  });
  await owner.from("stock_levels").delete().eq("part_id", part.id);
  const r1 = await owner.from("receivings").update({ deleted_at: now }).like("note", "SALE-TEST%");
  const r2 = await owner.from("deliveries").update({ deleted_at: now }).like("note", "SALE-TEST%");
  const r3 = await owner.from("returns").update({ deleted_at: now }).like("reason", "SALE-TEST%");
  const r4 = await owner.from("engines").update({ deleted_at: now }).eq("id", engine.id);
  const r5 = await owner.from("parts").update({ deleted_at: now }).in("id", [part.id, part2.id]);
  const r6 = await owner.from("customers").update({ deleted_at: now }).like("name", "SALE-TEST%");
  const err = retErr ?? r1.error ?? r2.error ?? r3.error ?? r4.error ?? r5.error ?? r6.error;
  check("fixtures cleaned", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
