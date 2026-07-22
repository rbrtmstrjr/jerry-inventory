/**
 * Point-of-sale warranty certificate (0055) — the shop can print an engine's
 * warranty at the counter the MOMENT the sale is recorded, before Admin
 * approves. `fn_shop_warranty_preview` is a read-only, guarded definer function
 * that renders the certificate data from the sale itself.
 *
 * Proves: (1) the seller shop gets the cert BEFORE approval; (2) terms follow
 * engine-override → model-default fallback; (3) sold_on = the sale date;
 * (4) a non-selling shop is refused (in-body guard); (5) the owner sees it;
 * (6) it VOIDS with the sale — a cancelled sale returns zero rows, exactly like
 * its receipt 404s.
 *
 * Self-contained: two temp shops + employees via the service role, hard-cleaned.
 *
 * Run: node scripts/test-warranty-preview.mjs
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
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
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
    .insert({ name: `WPV-TEST ${label} ${RUN}`, location: `WPV-TEST Loc ${label} ${RUN}` })
    .select()
    .single();
  const email = `wpv-${label.toLowerCase()}-${RUN.toLowerCase()}@test.local`;
  const password = `Wpv!${RUN}`;
  const { data: u, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  });
  if (error) throw new Error(error.message);
  await admin.from("profiles").insert({
    id: u.user.id, full_name: `WPV-TEST ${label}`, role: "employee", shop_id: shop.id,
  });
  return { shop, userId: u.user.id, client: await signIn(email, password) };
}

const owner = await signIn("robertmaestro09@gmail.com", "rajonrondo09");

async function confirmAll(shopClient, deliveryId) {
  const { data: lines } = await shopClient
    .from("shop_incoming_delivery_lines").select("id, qty_sent").eq("delivery_id", deliveryId);
  const { error } = await shopClient.rpc("fn_confirm_delivery", {
    p_delivery_id: deliveryId,
    p_lines: (lines ?? []).map((l) => ({ line_id: l.id, qty_received: l.qty_sent, shop_note: null })),
  });
  if (error) throw new Error(`confirm: ${error.message}`);
}

/** Receive an engine into master and land it at `S` (delivered, unsold). */
async function landEngine(S, serial, warrantyMonths) {
  await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `WPV-TEST setup ${RUN}`,
    p_parts: [],
    p_engines: [{
      serial_number: serial, engine_model_id: model.id, condition: "brand_new",
      cost_centavos: 2_000_000, price_centavos: 0, warranty_months: warrantyMonths,
    }],
  });
  const { data: eng } = await owner
    .from("engines").select("id").eq("serial_number", serial).single();
  const { data: dlv } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: S.shop.id, p_note: `WPV-TEST dlv ${RUN}`,
    p_parts: [], p_engine_ids: [eng.id],
  });
  await confirmAll(S.client, dlv);
  return eng.id;
}

console.log("Setup: two temp shops, model default warranty = 18 months");
const A = await makeShop("ShopA");
const B = await makeShop("ShopB");
// Give shop A a logo path (0057) — the object need not exist; we assert the
// PATH threads through onto the certificate. Anchor-fallback is the null case.
const A_LOGO = `shop-logos/ZZ-TEST-${RUN}.webp`;
await admin.from("shops").update({ logo_path: A_LOGO }).eq("id", A.shop.id);
const { data: model } = await admin
  .from("engine_models")
  .insert({ brand: "ZZ-TEST", model: `WPV-${RUN}`, horsepower: 40, default_warranty_months: 18 })
  .select("id")
  .single();

// Shop A records a two-engine sale: engine 1 rides the MODEL default (18mo),
// engine 2 carries its OWN override (36mo). The sale is only RECORDED — never
// submitted, never approved. There is no warranty row yet.
const SERIAL_1 = `WPV-TEST-1-${RUN}`;
const SERIAL_2 = `WPV-TEST-2-${RUN}`;
const eng1 = await landEngine(A, SERIAL_1, null); // null → model default
const eng2 = await landEngine(A, SERIAL_2, 36);   // engine override
const { data: saleId } = await A.client.rpc("fn_record_sale", {
  p_customer_id: null,
  p_customer: { name: `WPV-TEST Buyer ${RUN}`, phone: "0917-222-3333" },
  p_part_lines: [],
  p_engine_lines: [
    { engine_id: eng1, agreed_price_centavos: 4_000_000 },
    { engine_id: eng2, agreed_price_centavos: 5_000_000 },
  ],
});
check("engine sale recorded (not approved)", !!saleId);
{
  const { data: s } = await owner.from("sales").select("status").eq("id", saleId).single();
  check("sale is still `recorded` — no Admin approval", s?.status === "recorded", `got ${s?.status}`);
  const { count } = await owner
    .from("warranties").select("id", { count: "exact", head: true }).in("engine_id", [eng1, eng2]);
  check("NO official warranty row exists yet (that waits for approval)", count === 0, `got ${count}`);
}

// ── Seller prints at the counter, before approval ──────────────────────────
console.log("\nSeller shop prints the certificate BEFORE approval:");
let saleDate;
{
  const { data, error } = await A.client.rpc("fn_shop_warranty_preview", { p_sale_id: saleId });
  check("preview returns rows for the seller pre-approval", !error && (data ?? []).length === 2,
    error?.message ?? `got ${(data ?? []).length}`);
  const rows = data ?? [];
  const r1 = rows.find((r) => r.serial_number === SERIAL_1);
  const r2 = rows.find((r) => r.serial_number === SERIAL_2);
  check("engine on model default → 18 months", r1?.months === 18, `got ${r1?.months}`);
  check("engine with override → 36 months (override beats default)", r2?.months === 36, `got ${r2?.months}`);
  check("customer name carried onto the cert", r1?.customer_name === `WPV-TEST Buyer ${RUN}`);
  check("brand/model carried", r1?.brand === "ZZ-TEST" && r1?.model === `WPV-${RUN}`);
  // branch identity: the selling shop's name AND location, so the customer's
  // copy names WHICH branch issued it (0056).
  check("selling branch name carried", r1?.shop_name === A.shop.name, r1?.shop_name);
  check("selling branch LOCATION carried", r1?.shop_location === A.shop.location, r1?.shop_location);
  check("selling branch LOGO path carried", r1?.shop_logo_path === A_LOGO, r1?.shop_logo_path);
  saleDate = r1?.sold_on;
  const { data: s } = await owner.from("sales").select("business_date").eq("id", saleId).single();
  check("sold_on = the sale's business_date (customer copy, not approval date)",
    r1?.sold_on === s?.business_date, `${r1?.sold_on} vs ${s?.business_date}`);
  check("expires_on is after sold_on", new Date(r1?.expires_on) > new Date(r1?.sold_on),
    `${r1?.sold_on} → ${r1?.expires_on}`);
}

// ── Guard: only the selling shop (or owner) ────────────────────────────────
console.log("\nAuthority — a definer function must guard its caller (0042 lesson):");
{
  const { error } = await B.client.rpc("fn_shop_warranty_preview", { p_sale_id: saleId });
  check("a NON-selling shop is refused", !!error && /authoriz/i.test(error.message), error?.message);
}
{
  const { data, error } = await owner.rpc("fn_shop_warranty_preview", { p_sale_id: saleId });
  check("owner may print any shop's cert", !error && (data ?? []).length === 2, error?.message);
}
{
  const anon = createClient(SB_URL, ANON, { auth: { persistSession: false } });
  const { error } = await anon.rpc("fn_shop_warranty_preview", { p_sale_id: saleId });
  check("anonymous cannot call it at all", !!error, error?.message);
}

// ── Voids with the sale ────────────────────────────────────────────────────
console.log("\nThe certificate voids with the sale (delete = void, like the receipt):");
{
  // this is exactly what cancelSale() does — a shop deletes its own recorded sale
  const { error: delErr } = await A.client.from("sales").delete().eq("id", saleId);
  check("seller can cancel its own recorded sale", !delErr, delErr?.message);
  const { data, error } = await A.client.rpc("fn_shop_warranty_preview", { p_sale_id: saleId });
  check("cancelled sale → zero cert rows (voided)", !error && (data ?? []).length === 0,
    error?.message ?? `got ${(data ?? []).length}`);
}

// ── Cleanup ────────────────────────────────────────────────────────────────
console.log("\nCleanup:");
{
  const shops = [A.shop.id, B.shop.id];
  const engines = [eng1, eng2];
  await admin.from("stock_movements").delete().in("engine_id", engines);
  await admin.from("stock_movements").delete().in("shop_id", shops);
  await admin.from("sales").delete().in("shop_id", shops);
  await admin.from("deliveries").delete().in("shop_id", shops);
  await admin.from("receivings").delete().like("note", `%${RUN}%`);
  await admin.from("engines").delete().in("id", engines);
  await admin.from("engine_models").delete().eq("id", model.id);
  await admin.from("customers").delete().like("name", `%${RUN}%`);
  await admin.auth.admin.deleteUser(A.userId);
  await admin.auth.admin.deleteUser(B.userId);
  const { error } = await admin.from("shops").delete().in("id", shops);
  check("temp fixtures removed", !error, error?.message);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
