/**
 * Deliverable 3 verification — receiving flow, ledger, internal barcodes.
 * Run: node scripts/test-receiving.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
}

async function signIn(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return c;
}

const owner = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");
const emp = await signIn("branch1@jerrysmarine.test", "Branch1!Dev2026");

// unique per run — the movements ledger is append-only, so serials can't be reused
const RUN = Date.now().toString(36).toUpperCase();
const SERIAL = `RCV-TEST-${RUN}`;

console.log("Setup:");
const { data: cat } = await owner
  .from("product_categories").select("id").eq("name", "Consumables").single();
const { data: part } = await owner
  .from("parts")
  .insert({ name: "RCV-TEST Fuel Hose", category_id: cat.id, cost_centavos: 5000, price_centavos: 9000 })
  .select().single();
check("test part created", !!part);

const { data: model } = await owner
  .from("engine_models").select("id, default_warranty_months").eq("model", "DT15AS").single();

console.log("\nSupplier + receiving:");
const { data: supplier, error: supErr } = await owner
  .from("suppliers")
  .insert({ name: "RCV-TEST Marine Supply Co", contact: "0917-000-0000" })
  .select().single();
check("supplier created", !!supplier, supErr?.message);

const { data: rcvId, error: rcvErr } = await owner.rpc("fn_receive_stock", {
  p_supplier_id: supplier.id,
  p_note: "RCV-TEST delivery",
  p_parts: [{ part_id: part.id, qty: 24, unit_cost_centavos: 4800 }],
  p_engines: [{
    serial_number: SERIAL,
    engine_model_id: model.id,
    condition: "brand_new",
    cost_centavos: 4_500_000,
    price_centavos: 5_600_000,
    warranty_months: null,
  }],
});
check("fn_receive_stock succeeded", !rcvErr, rcvErr?.message);

{
  const { data } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).single();
  check("master stock = 24", data?.qty === 24, `(got ${data?.qty})`);
}
{
  const { data: eng } = await owner
    .from("engines").select("id, status, cost_centavos").eq("serial_number", SERIAL).single();
  check("engine created in_master", eng?.status === "in_master");

  const { data: moves } = await owner
    .from("stock_movements").select("movement_type, part_id, engine_id, qty_change, shop_id, receiving_id")
    .eq("receiving_id", rcvId);
  check("ledger: 2 movement rows", moves?.length === 2, `(got ${moves?.length})`);
  const pm = moves?.find((m) => m.part_id === part.id);
  const em2 = moves?.find((m) => m.engine_id === eng?.id);
  check("ledger: part +24 into master", pm?.qty_change === 24 && pm?.shop_id === null && pm?.movement_type === "received");
  check("ledger: engine +1 into master", em2?.qty_change === 1 && em2?.shop_id === null);
}
{
  const { data: lines } = await owner
    .from("receiving_lines").select("*").eq("receiving_id", rcvId);
  check("receiving has 2 lines", lines?.length === 2);
}

console.log("\nSecond receiving accumulates:");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: "RCV-TEST top-up",
    p_parts: [{ part_id: part.id, qty: 6, unit_cost_centavos: 5000 }],
    p_engines: [],
  });
  check("second receiving ok", !error, error?.message);
  const { data } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).single();
  check("master stock = 30", data?.qty === 30, `(got ${data?.qty})`);
}

console.log("\nValidation & security:");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: "bad", p_parts: [{ part_id: part.id, qty: -5, unit_cost_centavos: 0 }], p_engines: [],
  });
  check("negative qty rejected", !!error);
}
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: "empty", p_parts: [], p_engines: [],
  });
  check("empty receiving rejected", !!error);
}
{
  const { error } = await emp.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: "sneaky", p_parts: [{ part_id: part.id, qty: 5, unit_cost_centavos: 0 }], p_engines: [],
  });
  check("EMPLOYEE cannot receive stock", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { error } = await emp.rpc("fn_generate_internal_barcode", { p_part_id: part.id });
  check("EMPLOYEE cannot generate barcodes", !!error && /owner/i.test(error.message));
}

console.log("\nInternal barcode:");
{
  const { data: code, error } = await owner.rpc("fn_generate_internal_barcode", { p_part_id: part.id });
  check("barcode generated (JM########)", !error && /^JM\d{8}$/.test(code), error?.message ?? `(got ${code})`);
  const { data: again } = await owner.rpc("fn_generate_internal_barcode", { p_part_id: part.id });
  check("idempotent: same code returned", again === code, `(${again} vs ${code})`);
}

console.log("\nCleanup:");
{
  // The movements ledger is append-only (by design), so hard deletes are
  // impossible through the app — soft-delete fixtures exactly like the app does.
  const now = new Date().toISOString();
  const { data: eng } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();
  await owner.from("stock_levels").delete().eq("part_id", part.id);
  const r1 = await owner.from("receivings").update({ deleted_at: now }).like("note", "RCV-TEST%");
  const r2 = await owner.from("engines").update({ deleted_at: now }).eq("id", eng.id);
  const r3 = await owner.from("parts").update({ deleted_at: now }).eq("id", part.id);
  const r4 = await owner.from("suppliers").update({ deleted_at: now }).eq("id", supplier.id);
  const err = r1.error ?? r2.error ?? r3.error ?? r4.error;
  check("fixtures soft-deleted", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
