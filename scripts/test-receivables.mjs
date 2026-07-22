/**
 * Receivables / utang verification â€” customer required on partial sales,
 * payments POST IMMEDIATELY (no approval queue) + alert the owner, void
 * restores the balance and keeps history, over-payment blocked server-side,
 * shop isolation, and balance reconciliation.
 *
 * Self-contained: creates two isolated throwaway shops + employees via the
 * service role (real shop logins are unknown in production), runs everything
 * through normal RLS, then hard-cleans what it made.
 *
 * Run: node scripts/test-receivables.mjs
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

async function makeShop(label) {
  const { data: shop } = await admin
    .from("shops")
    .insert({ name: `UTANG-TEST ${label} ${RUN}` })
    .select()
    .single();
  const email = `utang-${label.toLowerCase()}-${RUN.toLowerCase()}@test.local`;
  const password = `Utang!${RUN}`;
  const { data: u, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw new Error(error.message);
  await admin.from("profiles").insert({
    id: u.user.id,
    full_name: `UTANG-TEST ${label} ${RUN}`,
    role: "employee",
    shop_id: shop.id,
  });
  return { shop, userId: u.user.id, client: await signIn(email, password) };
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

console.log("Setup: two temp shops + employees, engine â‚±20,000 @ 50/75/100%");
const A = await makeShop("ShopA");
const B = await makeShop("ShopB");

// Self-provisioned model — the DB can start empty; service role seeds (0049).
const { data: model } = await admin
  .from("engine_models")
  .insert({ brand: "ZZ-TEST", model: `15MH-${RUN}`, horsepower: 15, default_warranty_months: 12 })
  .select("id")
  .single();

const SERIAL = `UTANG-TEST-${RUN}`;
await owner.rpc("fn_receive_stock", {
  p_supplier_id: null,
  p_note: `UTANG-TEST setup ${RUN}`,
  p_parts: [],
  p_engines: [{
    serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new",
    cost_centavos: 2000000, price_centavos: 0, warranty_months: null,
    margin_floor_pct: 50, margin_mid_pct: 75, margin_asking_pct: 100,
  }],
});
const { data: eng } = await owner
  .from("engines").select("id").eq("serial_number", SERIAL).single();
const { data: dlvId, error: dlvErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: A.shop.id, p_note: `UTANG-TEST dlv ${RUN}`,
  p_parts: [], p_engine_ids: [eng.id],
});
check("engine delivered to Shop A", !dlvErr, dlvErr?.message);
await confirmAll(A.client, dlvId);

// â”€â”€ Partial sale requires a customer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nEvery utang is traceable to a person:");
{
  const { error } = await A.client.rpc("fn_record_sale", {
    p_customer_id: null,
    p_customer: null,                       // no customer
    p_part_lines: [],
    p_engine_lines: [],
    p_payment_type: "partial",
    p_amount_paid_centavos: 100000,
  });
  check("partial sale WITHOUT a customer is rejected",
    !!error && /customer/i.test(error.message), error?.message);
}

// â”€â”€ The utang sale: â‚±37,000 agreed, â‚±10,000 down â†’ â‚±27,000 balance â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nPartial engine sale (agreed â‚±37,000, â‚±10,000 down):");
const { data: saleId, error: saleErr } = await A.client.rpc("fn_record_sale", {
  p_customer_id: null,
  p_customer: { name: `UTANG-TEST Ka Ambo ${RUN}`, phone: "0917-555-0000" },
  p_part_lines: [],
  p_engine_lines: [{ engine_id: eng.id, agreed_price_centavos: 3700000 }],
  p_payment_type: "partial",
  p_amount_paid_centavos: 1000000,
});
check("sale recorded with a customer", !saleErr, saleErr?.message);

// approve it so it's a real receivable
{
  const { data: sub } = await A.client.rpc("fn_submit_shop_batch");
  const { error } = await owner.rpc("fn_approve_batch", { p_batch_id: sub.batch_id, p_note: null });
  check("sale approved (utang now real)", !error, error?.message);
}

const balanceOf = async (client, sid) => {
  const { data } = await client
    .from("receivables").select("balance_centavos").eq("sale_id", sid).single();
  return data?.balance_centavos;
};

console.log("\nReceivables surface:");
{
  const { data: r } = await A.client
    .from("shop_receivables").select("*").eq("sale_id", saleId).single();
  check("shop sees the open balance â‚±27,000", r?.balance_centavos === 2700000, `(got ${r?.balance_centavos})`);
  check("customer is attached", (r?.customer_name ?? "").includes("Ka Ambo"));
  const keys = Object.keys(r ?? {});
  check("no cost columns exposed", !keys.some((k) => k.includes("cost")));
  check("owner sees it too", (await balanceOf(owner, saleId)) === 2700000);
}

// â”€â”€ Shop isolation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nShop isolation:");
{
  const { data } = await B.client.from("shop_receivables").select("sale_id").eq("sale_id", saleId);
  check("Shop B cannot see Shop A's receivable", (data ?? []).length === 0);
}
{
  const { error } = await B.client.rpc("fn_record_utang_payment", {
    p_sale_id: saleId, p_amount_centavos: 100000, p_payer_name: "ZZ-TEST Payer",
  });
  check("Shop B cannot record a payment on Shop A's sale",
    !!error && /another shop/i.test(error.message), error?.message);
}

// â”€â”€ Over-payment blocked â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nOver-payment guard (server-side):");
{
  const { error } = await A.client.rpc("fn_record_utang_payment", {
    p_sale_id: saleId, p_amount_centavos: 2700001, p_payer_name: "ZZ-TEST Payer", // â‚±0.01 over
  });
  check("payment above the balance is rejected",
    !!error && /exceeds/i.test(error.message), error?.message);
}

// â”€â”€ Payments post immediately (no approval queue) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nPayment posts immediately (utang = money already owed):");
const { data: payId, error: payErr } = await A.client.rpc("fn_record_utang_payment", {
  p_sale_id: saleId, p_amount_centavos: 1000000,
  p_method: "gcash", p_payer_name: "ZZ-TEST Juan Payer", p_payer_contact: "0917-000-0000",
});
check("payment recorded", !payErr, payErr?.message);
{
  const { data: p } = await owner
    .from("utang_payments")
    .select("method, payer_name, payer_contact")
    .eq("id", payId).single();
  check("payment stores method + payer name + contact (0068)",
    p?.method === "gcash" && p?.payer_name === "ZZ-TEST Juan Payer" && p?.payer_contact === "0917-000-0000",
    JSON.stringify(p));
}
{
  const { error } = await A.client.rpc("fn_record_utang_payment", {
    p_sale_id: saleId, p_amount_centavos: 100000,
  });
  check("a payment with NO payer name is rejected (0068)",
    !!error && /payer/i.test(error.message), error?.message);
}
{
  check("balance drops AT ONCE to â‚±17,000 (27,000 âˆ’ 10,000)",
    (await balanceOf(A.client, saleId)) === 1700000,
    `(got ${await balanceOf(A.client, saleId)})`);
}
{
  const { error } = await A.client.rpc("fn_submit_shop_batch");
  check("payment does NOT enter the submission batch",
    !!error && /nothing to submit/i.test(error.message), error?.message);
}
{
  const { data } = await owner
    .from("notifications").select("type, shop_id")
    .eq("type", "utang_payment").eq("ref_id", payId);
  check("owner was ALERTED about the collection", (data ?? []).length === 1);
  check("alert carries the shop context", data?.[0]?.shop_id === A.shop.id);
}

// â”€â”€ Void restores the balance and keeps the history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nVoid (mistake/typo) â€” balance restored, history kept:");
{
  const { error } = await B.client.rpc("fn_void_utang_payment", { p_id: payId, p_reason: "x" });
  check("another shop cannot void it", !!error && /your own shop/i.test(error.message), error?.message);
}
{
  const { error } = await A.client.rpc("fn_void_utang_payment", {
    p_id: payId, p_reason: "ALERT-TEST typo",
  });
  check("shop voided its own payment", !error, error?.message);
  check("balance restored to â‚±27,000", (await balanceOf(A.client, saleId)) === 2700000);
  const { data: p } = await A.client
    .from("utang_payments").select("deleted_at, owner_note").eq("id", payId).single();
  check("voided row STAYS in history (soft-deleted)", !!p?.deleted_at);
  check("void reason recorded", (p?.owner_note ?? "").includes("typo"));
  const { data: n } = await owner
    .from("notifications").select("id").eq("type", "utang_payment_voided").eq("ref_id", payId);
  check("owner alerted about the void", (n ?? []).length === 1);
}
// re-post it so the rest of the flow continues
{
  const { error } = await A.client.rpc("fn_record_utang_payment", {
    p_sale_id: saleId, p_amount_centavos: 1000000, p_payer_name: "ZZ-TEST Payer",
  });
  check("payment re-recorded after the void", !error, error?.message);
  check("balance back down to â‚±17,000", (await balanceOf(A.client, saleId)) === 1700000);
}

// â”€â”€ Reconciliation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nReconciliation (agreed âˆ’ down âˆ’ Î£ approved = balance):");
{
  const { data: r } = await owner
    .from("receivables")
    .select("total_centavos, amount_paid_centavos, paid_since_centavos, balance_centavos")
    .eq("sale_id", saleId).single();
  const expected = r.total_centavos - r.amount_paid_centavos - r.paid_since_centavos;
  check("view balance reconciles", r.balance_centavos === expected,
    `(${r.total_centavos} âˆ’ ${r.amount_paid_centavos} âˆ’ ${r.paid_since_centavos} â‰  ${r.balance_centavos})`);
  check("fn_sale_balance agrees with the view",
    (await owner.rpc("fn_sale_balance", { p_sale_id: saleId })).data === r.balance_centavos);
}

// â”€â”€ Paying the rest settles the utang â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nSettlement at zero:");
{
  const { error } = await A.client.rpc("fn_record_utang_payment", {
    p_sale_id: saleId, p_amount_centavos: 1700000, p_payer_name: "ZZ-TEST Payer",
  });
  check("final payment recorded", !error, error?.message);
  check("balance = 0", (await balanceOf(A.client, saleId)) === 0);
  const { data: s } = await owner.from("sales").select("settled_at").eq("id", saleId).single();
  check("sale marked settled", !!s?.settled_at);
}
{
  const { error } = await A.client.rpc("fn_record_utang_payment", {
    p_sale_id: saleId, p_amount_centavos: 100, p_payer_name: "ZZ-TEST Payer",
  });
  check("no further payment accepted once settled", !!error && /exceeds/i.test(error.message), error?.message);
}

// â”€â”€ Cleanup (service role, FK-safe order) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
console.log("\nCleanup:");
{
  const shops = [A.shop.id, B.shop.id];
  await admin.from("notifications").delete().in("shop_id", shops);
  // Movements first â€” including the master-side row (shop_id IS NULL), which
  // still points at the delivery/receiving and would block those deletes.
  await admin.from("warranties").delete().eq("engine_id", eng.id);
  await admin.from("stock_movements").delete().eq("engine_id", eng.id);
  await admin.from("stock_movements").delete().in("shop_id", shops);
  await admin.from("sales").delete().in("shop_id", shops); // cascades sale_lines + utang_payments
  await admin.from("submission_batches").delete().in("shop_id", shops);
  await admin.from("deliveries").delete().in("shop_id", shops); // cascades delivery_lines
  await admin.from("receivings").delete().like("note", `%${RUN}%`); // cascades receiving_lines
  await admin.from("stock_levels").delete().in("shop_id", shops);
  const engDel = await admin.from("engines").delete().eq("id", eng.id);
  await admin.from("engine_models").delete().eq("id", model.id);
  await admin.from("customers").delete().like("name", `%${RUN}%`);
  await admin.auth.admin.deleteUser(A.userId);
  await admin.auth.admin.deleteUser(B.userId);
  const { error } = await admin.from("shops").delete().in("id", shops);
  check("temp fixtures removed", !error && !engDel.error,
    error?.message ?? engDel.error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
