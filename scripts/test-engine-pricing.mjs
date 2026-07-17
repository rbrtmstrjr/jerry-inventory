/**
 * Engine tiered-pricing verification â€” 3-margin computed prices, hard floor
 * (server-enforced from hidden cost), negotiated agreed price, discount,
 * partial payment, receipt, and the unchanged approval pipeline.
 *
 * Self-contained: creates an isolated throwaway shop + employee via the
 * service role (real shop logins are unknown in production), runs the flow
 * through normal RLS, then hard-cleans everything it made.
 *
 * Run: node scripts/test-engine-pricing.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const SB_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const RUN = Date.now().toString(36).toUpperCase();

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`  ${ok ? "âœ“" : "âœ—"} ${name} ${ok ? "" : detail}`);
  ok ? pass++ : fail++;
};

const admin = createClient(SB_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function signIn(email, password) {
  const c = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`${email}: ${error.message}`);
  return c;
}

const owner = await signIn("robertmaestro09@gmail.com", "rajonrondo09");

/** Deliveries no longer auto-land (0028/0029) â€” the shop must confirm arrival. */
async function confirmAll(shopClient, deliveryId) {
  const { data: lines } = await shopClient
    .from("shop_incoming_delivery_lines")
    .select("id, qty_sent")
    .eq("delivery_id", deliveryId);
  const { error } = await shopClient.rpc("fn_confirm_delivery", {
    p_delivery_id: deliveryId,
    p_lines: (lines ?? []).map((l) => ({
      line_id: l.id,
      qty_received: l.qty_sent,
      shop_note: null,
    })),
  });
  if (error) throw new Error(`confirm delivery: ${error.message}`);
}

// â”€â”€ Setup: isolated temp shop + employee â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("Setup: temp shop + employee, engine cost â‚±20,000 @ 50/75/100%");
const { data: shop } = await admin
  .from("shops")
  .insert({ name: `PRICE-TEST Shop ${RUN}` })
  .select()
  .single();
const empEmail = `price-test-${RUN.toLowerCase()}@test.local`;
const empPass = `PriceTest!${RUN}`;
const { data: authUser, error: authErr } = await admin.auth.admin.createUser({
  email: empEmail,
  password: empPass,
  email_confirm: true,
});
if (authErr) throw new Error(authErr.message);
await admin.from("profiles").insert({
  id: authUser.user.id,
  full_name: `PRICE-TEST Cashier ${RUN}`,
  role: "employee",
  shop_id: shop.id,
});
const emp = await signIn(empEmail, empPass);

// Self-provisioned model — the DB can start empty (the seeded catalog is gone
// since the fresh-start wipe) and 0049 leaves creation to the service role.
const { data: model } = await admin
  .from("engine_models")
  .insert({ brand: "ZZ-TEST", model: `15MH-${RUN}`, horsepower: 15, default_warranty_months: 12 })
  .select("id")
  .single();

// Owner receives an engine WITH 3 margins â†’ prices auto-compute
const SERIAL = `PRICE-TEST-${RUN}`;
const { error: rcvErr } = await owner.rpc("fn_receive_stock", {
  p_supplier_id: null,
  p_note: `PRICE-TEST setup ${RUN}`,
  p_parts: [],
  p_engines: [
    {
      serial_number: SERIAL,
      engine_model_id: model.id,
      condition: "brand_new",
      cost_centavos: 2000000,
      price_centavos: 0,
      warranty_months: null,
      margin_floor_pct: 50,
      margin_mid_pct: 75,
      margin_asking_pct: 100,
    },
  ],
});
check("engine received", !rcvErr, rcvErr?.message);

const { data: eng } = await owner
  .from("engines")
  .select(
    "id, cost_centavos, price_centavos, price_floor_centavos, price_mid_centavos, price_asking_centavos"
  )
  .eq("serial_number", SERIAL)
  .single();

console.log("\nComputed tier prices (from cost + margins):");
check("floor  = â‚±30,000", eng.price_floor_centavos === 3000000, `(got ${eng.price_floor_centavos})`);
check("mid    = â‚±35,000", eng.price_mid_centavos === 3500000, `(got ${eng.price_mid_centavos})`);
check("asking = â‚±40,000", eng.price_asking_centavos === 4000000, `(got ${eng.price_asking_centavos})`);
check("headline price follows asking", eng.price_centavos === 4000000, `(got ${eng.price_centavos})`);

// Deliver to the temp shop, then the shop confirms it arrived
const { data: dlvId, error: dlvErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: shop.id,
  p_note: `PRICE-TEST dlv ${RUN}`,
  p_parts: [],
  p_engine_ids: [eng.id],
});
check("engine delivered to temp shop", !dlvErr, dlvErr?.message);
await confirmAll(emp, dlvId);

// â”€â”€ Employees see prices, never cost/margins â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nEmployee visibility (shop_engines, no cost/margins):");
{
  const { data: se } = await emp
    .from("shop_engines")
    .select("*")
    .eq("engine_id", eng.id)
    .single();
  check("employee sees the three selling prices",
    se?.price_floor_centavos === 3000000 &&
    se?.price_mid_centavos === 3500000 &&
    se?.price_asking_centavos === 4000000);
  const keys = Object.keys(se ?? {});
  check("cost NOT exposed in the view", !keys.includes("cost_centavos"));
  check("margins NOT exposed in the view",
    !keys.some((k) => k.startsWith("margin_")));
}
{
  // base table is owner-only â€” employee gets no rows
  const { data } = await emp.from("engines").select("id, cost_centavos").eq("id", eng.id);
  check("employee cannot read the engines base table (cost hidden)", (data ?? []).length === 0);
}

// â”€â”€ Hard floor is enforced server-side â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nHard floor (server-enforced from hidden cost):");
{
  const { error } = await emp.rpc("fn_record_sale", {
    p_customer_id: null,
    p_customer: { name: `PRICE-TEST Buyer ${RUN}` },
    p_part_lines: [],
    p_engine_lines: [{ engine_id: eng.id, agreed_price_centavos: 2900000 }], // below â‚±30k floor
  });
  check("sale below floor is REJECTED", !!error && /floor/i.test(error.message), error?.message);
}

// â”€â”€ Negotiated sale with discount + partial payment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nNegotiated sale (agreed â‚±37,000, partial â‚±10,000 down):");
const { data: saleId, error: saleErr } = await emp.rpc("fn_record_sale", {
  p_customer_id: null,
  p_customer: { name: `PRICE-TEST Buyer ${RUN}`, phone: "0917-000-0000" },
  p_part_lines: [],
  p_engine_lines: [{ engine_id: eng.id, agreed_price_centavos: 3700000 }],
  p_payment_type: "partial",
  p_amount_paid_centavos: 1000000,
});
check("sale recorded", !saleErr, saleErr?.message);
{
  const { data: line } = await emp
    .from("sale_lines")
    .select("agreed_price_centavos, list_reference_centavos, discount_centavos, line_total_centavos")
    .eq("sale_id", saleId)
    .single();
  check("agreed price = â‚±37,000", line?.agreed_price_centavos === 3700000);
  check("list reference = asking â‚±40,000", line?.list_reference_centavos === 4000000);
  check("discount = â‚±3,000 (asking âˆ’ agreed)", line?.discount_centavos === 300000, `(got ${line?.discount_centavos})`);
  check("line total = agreed price", line?.line_total_centavos === 3700000);
}
let sale;
{
  const { data } = await emp
    .from("sales")
    .select("status, total_centavos, payment_type, amount_paid_centavos, balance_due_centavos, receipt_no")
    .eq("id", saleId)
    .single();
  sale = data;
  check("status = recorded (invisible to owner until submitted)", sale?.status === "recorded");
  check("payment type = partial", sale?.payment_type === "partial");
  check("amount paid = â‚±10,000", sale?.amount_paid_centavos === 1000000);
  check("balance due = â‚±27,000 (total âˆ’ down)", sale?.balance_due_centavos === 2700000, `(got ${sale?.balance_due_centavos})`);
  check("receipt number generated", !!sale?.receipt_no && sale.receipt_no.startsWith("OR-"), sale?.receipt_no);
}

// Anti-loophole: receipt total == recorded agreed == number the owner approves
console.log("\nReceipt == recorded == approved amount (no divergence):");
check("recorded total equals the agreed price", sale?.total_centavos === 3700000);

// â”€â”€ Approval pipeline unchanged â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nApproval pipeline (submit â†’ approve â†’ sold + warranty):");
{
  const { error } = await emp.rpc("fn_submit_shop_batch");
  check("employee submitted the batch", !error, error?.message);
  const { data: s } = await owner.from("sales").select("status, batch_id").eq("id", saleId).single();
  check("sale now pending with a batch", s?.status === "pending" && !!s?.batch_id);

  const { error: apErr } = await owner.rpc("fn_approve_batch", { p_batch_id: s.batch_id, p_note: null });
  check("owner approved the batch", !apErr, apErr?.message);
}
{
  const { data: s } = await owner
    .from("sales")
    .select("status, total_centavos")
    .eq("id", saleId)
    .single();
  check("sale approved", s?.status === "approved");
  check("approved total is exactly the agreed price (unchanged)", s?.total_centavos === 3700000);
  const { data: e } = await owner.from("engines").select("status").eq("id", eng.id).single();
  check("engine marked sold on approval", e?.status === "sold");
  const { data: w } = await owner.from("warranties").select("id").eq("engine_id", eng.id).maybeSingle();
  check("warranty auto-created", !!w);
}

// â”€â”€ Cleanup (service role, FK-safe order) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nCleanup:");
{
  await admin.from("warranties").delete().eq("engine_id", eng.id);
  await admin.from("stock_movements").delete().eq("engine_id", eng.id);
  await admin.from("stock_movements").delete().eq("shop_id", shop.id);
  await admin.from("sales").delete().eq("shop_id", shop.id);          // cascades sale_lines
  await admin.from("submission_batches").delete().eq("shop_id", shop.id);
  await admin.from("deliveries").delete().eq("shop_id", shop.id);     // cascades delivery_lines
  await admin.from("receivings").delete().like("note", `%${RUN}%`); // cascades receiving_lines
  await admin.from("stock_levels").delete().eq("shop_id", shop.id);
  await admin.from("engines").delete().eq("id", eng.id);
  await admin.from("customers").delete().like("name", `%${RUN}%`);
  await admin.from("engine_models").delete().eq("id", model.id);
  await admin.auth.admin.deleteUser(authUser.user.id);               // cascades profile
  const { error } = await admin.from("shops").delete().eq("id", shop.id);
  check("temp fixtures removed", !error, error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
