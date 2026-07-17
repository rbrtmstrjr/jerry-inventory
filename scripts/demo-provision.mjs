/**
 * Provision a client-demo fixture set: one "Demo Branch" shop with its own
 * employee login, a demo supplier, realistic catalog entries (parts + one
 * engine model). NO stock is received here — receiving is part of the live
 * demo in the UI, so serials/margins/supplier debt get created on stage.
 *
 * Every created id is written to scripts/.demo-fixtures.json so
 * demo-cleanup.mjs can remove everything (and anything hanging off it)
 * after the meeting. Names are realistic on purpose (client-facing demo);
 * notes/terms carry the DEMO-FIXTURE marker as a human-visible breadcrumb.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const MANIFEST = new URL("./.demo-fixtures.json", import.meta.url);
if (existsSync(MANIFEST)) {
  console.error("scripts/.demo-fixtures.json already exists — a demo set is already provisioned.");
  console.error("Run scripts/demo-cleanup.mjs --yes first, or delete the manifest if it's stale.");
  process.exit(1);
}

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const die = (step, error) => {
  console.error(`${step}: ${error.message}`);
  process.exit(1);
};

// ── shop + employee login ────────────────────────────────────────────────────
const { data: shop, error: shopErr } = await admin
  .from("shops")
  .insert({ name: "Demo Branch" })
  .select()
  .single();
if (shopErr) die("create shop", shopErr);

const EMAIL = "demo@jerrysmarine.test";
const PASSWORD = "Demo!2026";
const { data: u, error: uErr } = await admin.auth.admin.createUser({
  email: EMAIL,
  password: PASSWORD,
  email_confirm: true,
});
if (uErr) die("create demo user", uErr);

const { error: pErr } = await admin.from("profiles").insert({
  id: u.user.id,
  full_name: "Demo Branch Staff",
  role: "employee",
  shop_id: shop.id,
});
if (pErr) die("create profile", pErr);

// ── supplier ─────────────────────────────────────────────────────────────────
const { data: supplier, error: sErr } = await admin
  .from("suppliers")
  .insert({
    name: "Yamaha Marine Philippines",
    credit_limit: 50000000, // ₱500,000
    payment_terms_days: 30,
    terms_note: "DEMO-FIXTURE — net 30",
  })
  .select()
  .single();
if (sErr) die("create supplier", sErr);

// ── catalog: parts (no stock — receiving happens live in the demo) ───────────
const { data: cats } = await admin
  .from("product_categories")
  .select("id, name")
  .is("deleted_at", null)
  .order("name");
const catFor = (want) =>
  (cats ?? []).find((c) => c.name.toLowerCase().includes(want))?.id ?? cats?.[0]?.id;

const PART_SPECS = [
  { name: "NGK B8HS-10 Spark Plug", cat: "part", cost: 18000, price: 28000, reorder: 5 },
  { name: "Propeller 11 1/4 x 14-G (40HP)", cat: "part", cost: 280000, price: 420000, reorder: 2 },
  { name: "Yamalube 2T Marine Oil 1L", cat: "oil", cost: 21000, price: 35000, reorder: 10 },
  { name: "Marine Grease 500g", cat: "oil", cost: 25000, price: 42000, reorder: 6 },
];
const partIds = [];
for (const p of PART_SPECS) {
  const { data, error } = await admin
    .from("parts")
    .insert({
      name: p.name,
      category_id: catFor(p.cat),
      cost_centavos: p.cost,
      price_centavos: p.price,
      reorder_level: p.reorder,
      preferred_supplier_id: supplier.id,
      notes: "DEMO-FIXTURE",
    })
    .select()
    .single();
  if (error) die(`create part ${p.name}`, error);
  partIds.push(data.id);
}

// ── catalog: engine model ────────────────────────────────────────────────────
const { data: model, error: mErr } = await admin
  .from("engine_models")
  .insert({
    brand: "Yamaha",
    // "(Demo)" suffix: the REAL catalog already has Enduro E40GMHL and
    // (brand, model) is unique — colliding with live data is not an option.
    model: "Enduro E40GMHL (Demo)",
    horsepower: 40,
    default_warranty_months: 12,
    preferred_supplier_id: supplier.id,
  })
  .select()
  .single();
if (mErr) die("create engine model", mErr);

// ── manifest + login smoke test ──────────────────────────────────────────────
writeFileSync(
  MANIFEST,
  JSON.stringify(
    {
      created_at: new Date().toISOString(),
      shop_id: shop.id,
      user_id: u.user.id,
      email: EMAIL,
      supplier_id: supplier.id,
      part_ids: partIds,
      engine_model_id: model.id,
    },
    null,
    2
  )
);

const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { error: signInErr } = await anon.auth.signInWithPassword({
  email: EMAIL,
  password: PASSWORD,
});
if (signInErr) die("demo login smoke test", signInErr);

console.log("Demo fixtures provisioned:");
console.log(`  Shop:      Demo Branch (${shop.id})`);
console.log(`  Login:     ${EMAIL} / ${PASSWORD}  (sign-in verified)`);
console.log(`  Supplier:  Yamaha Marine Philippines (net 30, limit ₱500,000)`);
console.log(`  Parts:     ${PART_SPECS.map((p) => p.name).join(" · ")}`);
console.log(`  Engine:    Yamaha Enduro E40GMHL 40HP (12-mo warranty)`);
console.log("Manifest: scripts/.demo-fixtures.json — run demo-cleanup.mjs --yes after the meeting.");
