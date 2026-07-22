/**
 * Seed realistic master-inventory data for Jerry's Marine (PH outboard +
 * fishing supply dealer). MASTER STOCK ONLY â€” nothing is delivered to shops.
 * Goes through the real receiving flow so the movements ledger stays truthful.
 * Skips any part name / engine serial / supplier that already exists.
 *
 * Run: node scripts/seed-sample-data.mjs
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

// 0049 revoked catalog INSERT from app roles — seeding writes go through the
// service role (this is a sample-data utility, not a receiving).
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});
const owner = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
{
  const { error } = await owner.auth.signInWithPassword({
    email: "robertmaestro09@gmail.com",
    password: "rajonrondo09",
  });
  if (error) throw new Error(error.message);
}

const P = (pesos) => Math.round(pesos * 100); // pesos â†’ centavos

// ---------------------------------------------------------------------------
// Catalog: [name, category, unit, costâ‚±, priceâ‚±, reorder, qty, barcode|null, supplierKey]
// supplierKey: yamaha = genuine parts dist Â· hardware = oils/consumables Â· fishing = gear
// ---------------------------------------------------------------------------
const PARTS = [
  // ---- Engine Parts (genuine / branded) ----
  ["Impeller â€” Yamaha 40HP (E40G)",              "Engine Parts", "pc",   380,  580,  5,  10, "4997323117402", "yamaha"],
  ["Impeller â€” Yamaha 15HP (E15D)",              "Engine Parts", "pc",   320,  500,  5,  10, "4997323115156", "yamaha"],
  ["Spark Plug NGK B7HS",                        "Engine Parts", "pc",    95,  160, 24,  60, "0872951101197", "hardware"],
  ["Spark Plug NGK B8HS",                        "Engine Parts", "pc",    95,  160, 24,  60, "0872951101289", "hardware"],
  ["Spark Plug NGK BR7HS",                       "Engine Parts", "pc",   120,  190, 12,  30, "0872951106637", "hardware"],
  ["CDI Unit â€” Yamaha E40G",                     "Engine Parts", "pc",  2600, 3900,  2,   3, null,            "yamaha"],
  ["Carburetor Repair Kit â€” Yamaha 40HP",        "Engine Parts", "set",  450,  720,  4,   8, null,            "yamaha"],
  ["Fuel Pump Assy â€” Yamaha E40",                "Engine Parts", "pc",   850, 1350,  3,   5, null,            "yamaha"],
  ["Propeller 3-Blade â€” Yamaha 40HP 11-1/8Ã—13G", "Engine Parts", "pc",  2900, 4300,  3,   4, null,            "yamaha"],
  ["Propeller 3-Blade â€” Yamaha 15HP 9-1/4Ã—9J",   "Engine Parts", "pc",  2200, 3300,  3,   4, null,            "yamaha"],
  ["Zinc Anode â€” Yamaha 40HP",                   "Engine Parts", "pc",   180,  300,  8,  15, null,            "yamaha"],
  ["Starter Rope 5mm (per meter)",               "Engine Parts", "m",     18,   35, 50, 100, null,            "hardware"],
  ["Fuel Line w/ Primer Bulb Assy",              "Engine Parts", "set",  300,  480,  6,  10, null,            "hardware"],
  ["Head Gasket â€” Yamaha E40",                   "Engine Parts", "pc",   380,  600,  4,   8, null,            "yamaha"],
  ["Piston Ring Set STD â€” Yamaha E40",           "Engine Parts", "set",  520,  820,  4,   6, null,            "yamaha"],
  ["Recoil Starter Spring â€” E15/E40",            "Engine Parts", "pc",   240,  400,  4,   6, null,            "yamaha"],
  ["Water Pump Repair Kit â€” Tohatsu M18",        "Engine Parts", "set",  680, 1050,  3,   5, null,            "yamaha"],
  ["Throttle Cable â€” Universal 40HP",            "Engine Parts", "pc",   260,  420,  5,   8, null,            "hardware"],

  // ---- Oil & Lubricants ----
  ["Yamalube 2T Marine Oil 1L",                  "Oil & Lubricants", "bottle", 285, 390, 24, 48, "4997323300115", "yamaha"],
  ["Yamalube 2T Marine Oil 500ml",               "Oil & Lubricants", "bottle", 160, 230, 24, 36, "4997323300054", "yamaha"],
  ["2T Outboard Oil TCW-3 1L (Generic)",         "Oil & Lubricants", "bottle", 190, 280, 12, 24, null,            "hardware"],
  ["Gear Oil SAE 90 â€” 250ml",                    "Oil & Lubricants", "bottle", 140, 220, 12, 24, null,            "hardware"],
  ["Marine Grease 250g",                         "Oil & Lubricants", "tub",    160, 260,  8, 12, null,            "hardware"],
  ["4T Engine Oil 10W-30 1L",                    "Oil & Lubricants", "bottle", 260, 370, 12, 18, null,            "hardware"],
  ["Carb & Choke Cleaner Spray 330ml",           "Oil & Lubricants", "can",    210, 320,  8, 12, null,            "hardware"],

  // ---- Fisherman Gear ----
  ["Nylon Monofilament #80 (1kg spool)",         "Fisherman Gear", "spool", 460,  680,  6,  12, null, "fishing"],
  ["Nylon Monofilament #120 (1kg spool)",        "Fisherman Gear", "spool", 480,  700,  6,  10, null, "fishing"],
  ["Nylon Rope 8mm (220m roll)",                 "Fisherman Gear", "roll",  980, 1450,  4,   8, null, "fishing"],
  ["Nylon Rope 12mm (220m roll)",                "Fisherman Gear", "roll", 1750, 2500,  3,   6, null, "fishing"],
  ["Fish Hooks Mustad #7 (per 100)",             "Fisherman Gear", "pack",  190,  320, 10,  20, null, "fishing"],
  ["Fish Hooks Mustad #10 (per 100)",            "Fisherman Gear", "pack",  170,  290, 10,  20, null, "fishing"],
  ["Lead Sinkers Assorted (per kg)",             "Fisherman Gear", "kg",    220,  360, 10,  15, null, "fishing"],
  ["Styro Float 4\"",                            "Fisherman Gear", "pc",     22,   40, 100, 300, null, "fishing"],
  ["Kerosene Pressure Lamp â€” Butterfly #950",    "Fisherman Gear", "pc",   1850, 2650,  2,   4, null, "fishing"],
  ["Cooler Box 60L",                             "Fisherman Gear", "pc",   2300, 3400,  2,   4, null, "fishing"],
  ["Rubber Gloves Heavy Duty (pair)",            "Fisherman Gear", "pair",   85,  150, 12,  24, null, "fishing"],
  ["LED Flashlight Rechargeable",                "Fisherman Gear", "pc",    380,  620,  6,  10, null, "fishing"],

  // ---- Consumables ----
  ["Electrical Tape 19mm",                       "Consumables", "roll",  45,  80, 20,  40, null, "hardware"],
  ["Cable Ties 8\" (pack of 100)",               "Consumables", "pack",  95, 170, 10,  20, null, "hardware"],
  ["Waterproof Sandpaper #400",                  "Consumables", "sheet", 18,  35, 40, 100, null, "hardware"],
  ["Epoxy A+B 1/4L (Pioneer)",                   "Consumables", "set",  190, 290,  8,  15, "4806504110124", "hardware"],
  ["Marine Silicone Sealant 300ml",              "Consumables", "tube", 260, 400,  6,  10, null, "hardware"],
  ["WD-40 191ml",                                "Consumables", "can",  245, 360,  8,  16, "0079567110125", "hardware"],
  ["Hose Clamp SS 1/2\"â€“3/4\"",                  "Consumables", "pc",    25,  50, 30,  60, null, "hardware"],
  ["Cotton Rags (per kg)",                       "Consumables", "kg",    60, 110, 10,  20, null, "hardware"],
];

// Items repacked in-house — get internal GT barcodes
const REPACKED = [
  "Starter Rope 5mm (per meter)",
  "Fish Hooks Mustad #7 (per 100)",
  "Fish Hooks Mustad #10 (per 100)",
  "Lead Sinkers Assorted (per kg)",
  "Styro Float 4\"",
  "Waterproof Sandpaper #400",
  "Cotton Rags (per kg)",
];

// ---- Serialized engines (all land in master) ----
const ENGINES = [
  ["6F5-1053421",   "Yamaha",  "Enduro E40GMHL", "brand_new",  78000,  92000],
  ["6F5-1053422",   "Yamaha",  "Enduro E40GMHL", "brand_new",  78000,  92000],
  ["6F5-1058907",   "Yamaha",  "Enduro E40GMHL", "brand_new",  78000,  92000],
  ["684-2214563",   "Yamaha",  "Enduro E15DMHL", "brand_new",  58000,  68500],
  ["684-2214788",   "Yamaha",  "Enduro E15DMHL", "brand_new",  58000,  68500],
  ["677-8812345",   "Yamaha",  "Enduro E8DMHL",  "brand_new",  42000,  49500],
  ["01504F-140123", "Suzuki",  "DT15AS",         "brand_new",  52000,  61000],
  ["01504F-140256", "Suzuki",  "DT15AS",         "brand_new",  52000,  61000],
  ["02002F-310442", "Suzuki",  "DF20AS",         "brand_new",  95000, 112000],
  ["350-8891203",   "Tohatsu", "M18E2",          "brand_new",  54000,  63000],
  ["350-8891417",   "Tohatsu", "M18E2",          "brand_new",  54000,  63000],
  ["0R642318",      "Mercury", "15MH",           "second_hand", 38000,  47000],
];

const SUPPLIERS = {
  yamaha:   { name: "Cebu Marine Equipment Corp.",     contact: "Vito Ramos â€” 0917 555 2210",  notes: "Yamaha/Tohatsu distributor â€” engines & genuine parts" },
  hardware: { name: "Mandaue Oil & Hardware Trading",  contact: "(032) 345-6789",              notes: "Oils, lubricants, consumables" },
  fishing:  { name: "JLT Fishing Supply",              contact: "Jenny Tan â€” 0918 555 0834",   notes: "Nets, lines, ropes, fisherman goods" },
};

// ---------------------------------------------------------------------------
console.log("Cleaning up old RCV-TEST leftoversâ€¦");
{
  const now = new Date().toISOString();
  await owner.from("stock_levels").delete()
    .in("part_id", (await owner.from("parts").select("id").like("name", "RCV-TEST%")).data?.map((p) => p.id) ?? []);
  await owner.from("parts").update({ deleted_at: now }).like("name", "RCV-TEST%").is("deleted_at", null);
  await owner.from("engines").update({ deleted_at: now }).like("serial_number", "RCV-TEST%").is("deleted_at", null);
  await owner.from("suppliers").update({ deleted_at: now }).like("name", "RCV-TEST%").is("deleted_at", null);
}

console.log("Categoriesâ€¦");
const { data: cats } = await owner.from("product_categories").select("id, name").is("deleted_at", null);
const catId = Object.fromEntries((cats ?? []).map((c) => [c.name, c.id]));

console.log("Suppliersâ€¦");
const { data: existingSup } = await owner.from("suppliers").select("id, name").is("deleted_at", null);
const supId = {};
for (const [key, s] of Object.entries(SUPPLIERS)) {
  const found = existingSup?.find((x) => x.name === s.name);
  if (found) {
    supId[key] = found.id;
    continue;
  }
  const { data, error } = await owner.from("suppliers").insert(s).select("id").single();
  if (error) throw new Error(`supplier ${s.name}: ${error.message}`);
  supId[key] = data.id;
  console.log(`  + ${s.name}`);
}

console.log("Parts catalogâ€¦");
const { data: existingParts } = await owner.from("parts").select("id, name").is("deleted_at", null);
const existingNames = new Set((existingParts ?? []).map((p) => p.name));
const partIdByName = Object.fromEntries((existingParts ?? []).map((p) => [p.name, p.id]));
const newBySupplier = { yamaha: [], hardware: [], fishing: [] };

for (const [name, cat, unit, cost, price, reorder, qty, barcode, supplier] of PARTS) {
  if (existingNames.has(name)) {
    console.log(`  = ${name} (exists, skipped)`);
    continue;
  }
  const { data, error } = await admin
    .from("parts")
    .insert({
      name,
      category_id: catId[cat] ?? null,
      unit,
      cost_centavos: P(cost),
      price_centavos: P(price),
      reorder_level: reorder,
      barcode: barcode ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`part ${name}: ${error.message}`);
  partIdByName[name] = data.id;
  newBySupplier[supplier].push({ part_id: data.id, qty, unit_cost_centavos: P(cost) });
  console.log(`  + ${name}`);
}

console.log("Receivings into MASTERâ€¦");
const { data: existingEngines } = await owner.from("engines").select("serial_number");
const existingSerials = new Set((existingEngines ?? []).map((e) => e.serial_number));
const { data: models } = await owner.from("engine_models").select("id, brand, model").is("deleted_at", null);
const modelId = (brand, model) => models?.find((m) => m.brand === brand && m.model === model)?.id;

const newEngines = ENGINES.filter(([sn]) => !existingSerials.has(sn)).map(
  ([serial_number, brand, model, condition, cost, price]) => {
    const id = modelId(brand, model);
    if (!id) throw new Error(`engine model missing: ${brand} ${model}`);
    return {
      serial_number,
      engine_model_id: id,
      condition,
      cost_centavos: P(cost),
      price_centavos: P(price),
      warranty_months: null, // model default (12)
    };
  }
);

const receivings = [
  { key: "yamaha",   note: "Initial stocking â€” engines & genuine parts", engines: newEngines },
  { key: "hardware", note: "Initial stocking â€” oils & consumables",      engines: [] },
  { key: "fishing",  note: "Initial stocking â€” fisherman gear",          engines: [] },
];
for (const r of receivings) {
  const parts = newBySupplier[r.key];
  if (parts.length === 0 && r.engines.length === 0) {
    console.log(`  = ${SUPPLIERS[r.key].name}: nothing new, skipped`);
    continue;
  }
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supId[r.key],
    p_note: r.note,
    p_parts: parts,
    p_engines: r.engines,
  });
  if (error) throw new Error(`receiving (${r.key}): ${error.message}`);
  console.log(`  + ${SUPPLIERS[r.key].name}: ${parts.length} part lines, ${r.engines.length} engines`);
}

console.log("Internal barcodes for repacked itemsâ€¦");
for (const name of REPACKED) {
  const id = partIdByName[name];
  if (!id) continue;
  const { data, error } = await owner.rpc("fn_generate_internal_barcode", { p_part_id: id });
  if (error) console.log(`  ! ${name}: ${error.message}`);
  else console.log(`  ${data}  ${name}`);
}

// ---------------------------------------------------------------------------
console.log("\nSummary:");
const { data: partCount } = await owner.from("parts").select("id").is("deleted_at", null);
const { data: engineCount } = await owner.from("engines").select("id").eq("status", "in_master").is("deleted_at", null);
const { data: master } = await owner.from("stock_levels").select("qty").is("shop_id", null);
const totalUnits = (master ?? []).reduce((s, r) => s + r.qty, 0);
console.log(`  Parts in catalog:        ${partCount?.length}`);
console.log(`  Engines in master:       ${engineCount?.length}`);
console.log(`  Part units in master:    ${totalUnits}`);
console.log("\nDone â€” everything is in MASTER stock only. Deliver to branches from the Deliveries screen.");
