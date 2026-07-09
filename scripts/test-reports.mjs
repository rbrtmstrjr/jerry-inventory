/**
 * Deliverable 8 verification — report aggregates render server-side with real
 * approved data; dashboard shows live numbers. Needs `npm run dev` running.
 * Run: node scripts/test-reports.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0];

const SHOP1 = "a0000000-0000-4000-8000-000000000001";
const SHOP2 = "a0000000-0000-4000-8000-000000000002";
const RUN = Date.now().toString(36).toUpperCase();
const SERIAL = `RPT-TEST-${RUN}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

async function signIn(email, password) {
  const c = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { data, error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  return { client: c, session: data.session };
}

const { client: owner, session: ownerSession } = await signIn("owner@jerrysmarine.test", "Owner!Dev2026");
const { client: emp1 } = await signIn("branch1@jerrysmarine.test", "Branch1!Dev2026");
const { client: emp2 } = await signIn("branch2@jerrysmarine.test", "Branch2!Dev2026");

const ownerCookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(ownerSession)).toString("base64url")}`;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

console.log("Setup: stock at both branches, sales + loss approved");
const { data: cat } = await owner.from("product_categories").select("id").eq("name", "Fisherman Gear").single();
const { data: part } = await owner.from("parts")
  .insert({ name: `RPT-TEST Nylon Net ${RUN}`, category_id: cat.id, cost_centavos: 40000, price_centavos: 65000, reorder_level: 10 })
  .select().single();
const { data: model } = await owner.from("engine_models").select("id").eq("model", "M40D2").single();
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null, p_note: `RPT-TEST setup ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 20, unit_cost_centavos: 40000 }],
  p_engines: [{ serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new", cost_centavos: 8_000_000, price_centavos: 9_900_000, warranty_months: null }],
});
const { data: engine } = await owner.from("engines").select("id").eq("serial_number", SERIAL).single();
await owner.rpc("fn_deliver_stock", { p_shop_id: SHOP1, p_note: `RPT-TEST d1 ${RUN}`, p_parts: [{ part_id: part.id, qty: 8 }], p_engine_ids: [engine.id] });
await owner.rpc("fn_deliver_stock", { p_shop_id: SHOP2, p_note: `RPT-TEST d2 ${RUN}`, p_parts: [{ part_id: part.id, qty: 8 }], p_engine_ids: [] });

// Branch1: 3 nets + the engine; Branch2: 2 nets; Branch1 loss: 1 net nasira
const { data: sale1 } = await emp1.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: { name: `RPT-TEST Buyer ${RUN}` },
  p_part_lines: [{ part_id: part.id, qty: 3 }], p_engine_ids: [engine.id],
});
const { data: sale2 } = await emp2.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: null,
  p_part_lines: [{ part_id: part.id, qty: 2 }], p_engine_ids: [],
});
const { data: loss1 } = await emp1.rpc("fn_record_loss", {
  p_part_id: part.id, p_engine_id: null, p_qty: 1, p_reason: "nasira", p_note: `RPT-TEST punit ${RUN}`,
});
const a1 = await owner.rpc("fn_approve_sale", { p_sale_id: sale1, p_note: null });
const a2 = await owner.rpc("fn_approve_sale", { p_sale_id: sale2, p_note: null });
const a3 = await owner.rpc("fn_approve_loss", { p_loss_id: loss1, p_note: null });
check("all approvals succeeded", !a1.error && !a2.error && !a3.error,
  a1.error?.message ?? a2.error?.message ?? a3.error?.message);

// Expected: revenue = 3×650 + 99,000 + 2×650 = ₱102,250.00 ; shrinkage = ₱400.00
console.log("\nReport page (server-rendered aggregates):");
{
  const res = await fetch(`http://localhost:3000/reports?from=${today}&to=${today}&shop=all`, {
    headers: { cookie: ownerCookie }, redirect: "manual",
  });
  check("GET /reports (today) → 200", res.status === 200, `got ${res.status}`);
  const html = await res.text();
  check("revenue ₱102,250.00 in stat tile", html.includes("102,250.00"));
  check("engines sold = serial's line present", html.includes(SERIAL));
  check("shrinkage ₱400.00 present", html.includes("400.00"));
  check("top part name in payload", html.includes("RPT-TEST Nylon Net"));
}
{
  const res = await fetch(`http://localhost:3000/reports?from=2020-01-01&to=2020-01-02&shop=all`, {
    headers: { cookie: ownerCookie }, redirect: "manual",
  });
  const html = await res.text();
  check("arbitrary old range → 200 and empty revenue", res.status === 200 && !html.includes("102,250.00"));
}
{
  const res = await fetch(`http://localhost:3000/reports?from=${today}&to=${today}&shop=${SHOP2}`, {
    headers: { cookie: ownerCookie }, redirect: "manual",
  });
  const html = await res.text();
  check("shop filter: Branch 2 only shows ₱1,300.00", res.status === 200 && html.includes("1,300.00") && !html.includes("102,250.00"));
}

console.log("\nDashboard live numbers:");
{
  const res = await fetch("http://localhost:3000/dashboard", {
    headers: { cookie: ownerCookie }, redirect: "manual",
  });
  const html = await res.text();
  check("GET /dashboard → 200", res.status === 200);
  check("today's revenue on dashboard", html.includes("102,250.00"));
}

console.log("\nCleanup:");
{
  const now = new Date().toISOString();
  // return remaining stock so branches end clean, then soft-delete
  await owner.rpc("fn_return_stock", { p_shop_id: SHOP1, p_reason: `RPT-TEST clean ${RUN}`, p_parts: [{ part_id: part.id, qty: 4 }], p_engine_ids: [] });
  await owner.rpc("fn_return_stock", { p_shop_id: SHOP2, p_reason: `RPT-TEST clean ${RUN}`, p_parts: [{ part_id: part.id, qty: 6 }], p_engine_ids: [] });
  await owner.from("stock_levels").delete().eq("part_id", part.id);
  const rs = await Promise.all([
    owner.from("sales").update({ deleted_at: now }).in("id", [sale1, sale2]),
    owner.from("losses").update({ deleted_at: now }).eq("id", loss1),
    owner.from("warranties").update({ deleted_at: now }).eq("engine_id", engine.id),
    owner.from("engines").update({ deleted_at: now }).eq("id", engine.id),
    owner.from("receivings").update({ deleted_at: now }).like("note", "RPT-TEST%"),
    owner.from("deliveries").update({ deleted_at: now }).like("note", "RPT-TEST%"),
    owner.from("returns").update({ deleted_at: now }).like("reason", "RPT-TEST%"),
    owner.from("parts").update({ deleted_at: now }).eq("id", part.id),
    owner.from("customers").update({ deleted_at: now }).like("name", "RPT-TEST%"),
  ]);
  const err = rs.find((r) => r.error)?.error;
  check("fixtures cleaned", !err, err?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
