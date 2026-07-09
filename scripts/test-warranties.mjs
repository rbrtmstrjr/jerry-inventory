/**
 * Deliverable 7 verification — warranty data joins, claim log, fitment,
 * serial journey, and employee lockout on warranty tables.
 * Run: node scripts/test-warranties.mjs
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
const SERIAL = `WTY-TEST-${RUN}`;

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

console.log("Setup: sell an engine end-to-end so a warranty exists");
const { data: model } = await owner.from("engine_models")
  .select("id, brand, model, default_warranty_months").eq("model", "DF20AS").single();
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `WTY-TEST setup ${RUN}`, p_parts: [],
  p_engines: [{ serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new", cost_centavos: 5_000_000, price_centavos: 6_200_000, warranty_months: 6 }],
});
const { data: engine } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();
await owner.rpc("fn_deliver_stock", {
  p_shop_id: SHOP1, p_note: `WTY-TEST delivery ${RUN}`, p_parts: [], p_engine_ids: [engine.id],
});
const { data: saleId } = await emp1.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: { name: `WTY-TEST Ka Pedro ${RUN}`, phone: "0918-555-1234" },
  p_part_lines: [], p_engine_ids: [engine.id],
});
const { error: aprErr } = await owner.rpc("fn_approve_sale", { p_sale_id: saleId, p_note: null });
check("engine sold + approved", !aprErr, aprErr?.message);

console.log("\nWarranty page joins:");
const { data: w, error: wErr } = await owner
  .from("warranties")
  .select(
    `id, engine_id, sold_on, months, expires_on,
     engines(serial_number, engine_models(brand, model, horsepower)),
     customers(name, phone),
     sales(shops(name)),
     warranty_claims(id)`
  )
  .eq("engine_id", engine.id)
  .single();
check("warranty row with all joins", !!w && !wErr, wErr?.message);
check("engine override honored (6 months, not model 12)", w?.months === 6, `(got ${w?.months})`);
check("serial + customer + shop joined",
  w?.engines?.serial_number === SERIAL &&
  /Ka Pedro/.test(w?.customers?.name ?? "") &&
  /Branch 1/.test(w?.sales?.shops?.name ?? ""));

console.log("\nClaim log:");
{
  const { error } = await owner.from("warranty_claims").insert({
    warranty_id: w.id, claim_date: w.sold_on, issue: `WTY-TEST hindi umaandar ${RUN}`, action_taken: "checked carburetor",
  });
  check("owner can log a claim", !error, error?.message);
  const { data: claims } = await owner.from("warranty_claims").select("*").eq("warranty_id", w.id);
  check("claim readable with action", claims?.length === 1 && claims[0].action_taken === "checked carburetor");
}
{
  const { data } = await emp1.from("warranties").select("*");
  check("employee cannot read warranties", (data ?? []).length === 0);
  const { error } = await emp1.from("warranty_claims").insert({
    warranty_id: w.id, claim_date: w.sold_on, issue: "sneaky claim",
  });
  check("employee cannot log claims", !!error);
}

console.log("\nSerial journey (ledger for one engine):");
{
  const { data: moves } = await owner
    .from("stock_movements")
    .select("movement_type, qty_change, shop_id")
    .eq("engine_id", engine.id)
    .order("created_at");
  const kinds = (moves ?? []).map((m) => m.movement_type);
  check("journey: received → delivery ×2 → sale",
    kinds.join(",") === "received,delivery,delivery,sale", `(got ${kinds.join(",")})`);
}

console.log("\nFitment:");
const { data: cat } = await owner.from("product_categories").select("id").eq("name", "Engine Parts").single();
const { data: part } = await owner.from("parts")
  .insert({ name: `WTY-TEST Impeller ${RUN}`, category_id: cat.id, cost_centavos: 10000, price_centavos: 20000 })
  .select().single();
const { data: model2 } = await owner.from("engine_models").select("id").eq("model", "DT15AS").single();
{
  const { error } = await owner.from("part_fitments").insert([
    { part_id: part.id, engine_model_id: model.id },
    { part_id: part.id, engine_model_id: model2.id },
  ]);
  check("owner sets fitment (2 models)", !error, error?.message);
}
{
  const { data } = await emp1.from("part_fitments").select("engine_model_id").eq("part_id", part.id);
  check("employee can read fitment (sale-time hint)", data?.length === 2);
  const { data: em } = await emp1.from("engine_models").select("brand, model").eq("id", model.id).single();
  check("employee can read model names for hint", !!em?.brand);
  const { error } = await emp1.from("part_fitments").insert({ part_id: part.id, engine_model_id: model2.id });
  check("employee cannot edit fitment", !!error);
}
{
  // replace-all pattern used by the action
  await owner.from("part_fitments").delete().eq("part_id", part.id);
  const { error } = await owner.from("part_fitments").insert([{ part_id: part.id, engine_model_id: model2.id }]);
  const { data } = await owner.from("part_fitments").select("*").eq("part_id", part.id);
  check("fitment replace works (now 1 model)", !error && data?.length === 1);
}

console.log("\nCertificate data joins:");
{
  const { data: c, error } = await owner
    .from("warranties")
    .select(
      `id, sold_on, months, expires_on,
       engines(serial_number, condition, engine_models(brand, model, horsepower, stroke)),
       customers(name, phone, address),
       sales(shops(name, location))`
    )
    .eq("id", w.id)
    .single();
  check("certificate query renders complete", !error && !!c?.engines?.serial_number && !!c?.customers?.name);
}

console.log("\nCleanup:");
{
  const now = new Date().toISOString();
  await owner.from("part_fitments").delete().eq("part_id", part.id);
  await owner.from("warranty_claims").delete().like("issue", "WTY-TEST%");
  const r1 = await owner.from("warranties").update({ deleted_at: now }).eq("id", w.id);
  const r2 = await owner.from("sales").update({ deleted_at: now }).eq("id", saleId);
  const r3 = await owner.from("engines").update({ deleted_at: now }).eq("id", engine.id);
  const r4 = await owner.from("receivings").update({ deleted_at: now }).like("note", "WTY-TEST%");
  const r5 = await owner.from("deliveries").update({ deleted_at: now }).like("note", "WTY-TEST%");
  const r6 = await owner.from("parts").update({ deleted_at: now }).eq("id", part.id);
  const r7 = await owner.from("customers").update({ deleted_at: now }).like("name", "WTY-TEST%");
  const err = r1.error ?? r2.error ?? r3.error ?? r4.error ?? r5.error ?? r6.error ?? r7.error;
  check("fixtures cleaned", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
