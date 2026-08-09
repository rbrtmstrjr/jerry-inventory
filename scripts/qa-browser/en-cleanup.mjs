/**
 * Remove the ZZ-QA ENGINE fixtures the non-serialized-engine browser sweep left
 * on staging.
 *
 * `fq-cleanup.mjs` scopes by fixture PART and cannot see these: a bulk-received
 * engine has no part_id at all. Same discipline though — scope by the fixture
 * MODEL, never by shop, because this sweep drove the real branches through the
 * real UI.
 *
 * DRY RUN BY DEFAULT. Pass --yes to delete.
 *
 * Order is FK-safe: movements before the engines they point at, lines before
 * their headers. A receiving header is removed only when every line on it
 * belongs to a fixture engine — a real receiving that happened to include one
 * loses the line, never itself.
 */
import { createClient } from "@supabase/supabase-js";
import { assertWritableEnv, readEnvFile } from "../_env-guard.mjs";

assertWritableEnv("the engine QA cleanup (it deletes fixtures)");
const env = readEnvFile();

const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const GO = process.argv.includes("--yes");
const PREFIX = "ZZ-QA%";

console.log(`\n${GO ? "DELETING" : "DRY RUN"} — ZZ-QA engine fixtures`);
console.log(`project: ${env.NEXT_PUBLIC_SUPABASE_URL}\n`);

const { data: models } = await admin
  .from("engine_models").select("id, brand, model, is_serialized, sku").like("brand", PREFIX);
const modelIds = (models ?? []).map((m) => m.id);
console.log(`fixture engine models (${modelIds.length}):`);
for (const m of models ?? []) {
  console.log(`  · ${m.brand} ${m.model}  serialized=${m.is_serialized}  sku=${m.sku ?? "—"}`);
}
if (!modelIds.length) { console.log("\nnothing to do.\n"); process.exit(0); }

const { data: engines } = await admin
  .from("engines").select("id, serial_number, status").in("engine_model_id", modelIds);
const engineIds = (engines ?? []).map((e) => e.id);
console.log(`\nunits (${engineIds.length}): ${(engines ?? []).map((e) => e.serial_number).join(", ")}`);

const sold = (engines ?? []).filter((e) => e.status === "sold");
if (sold.length) {
  console.log(`\n⚠️  ${sold.length} unit(s) are SOLD — they carry warranties and sale lines.`);
  console.log("   Refusing to delete: a sold unit is business history, not a fixture.");
  process.exit(1);
}

const { data: movs } = await admin
  .from("stock_movements").select("id").in("engine_id", engineIds);
const { data: rlines } = await admin
  .from("receiving_lines").select("id, receiving_id").in("engine_id", engineIds);
const rcvIds = [...new Set((rlines ?? []).map((l) => l.receiving_id))];

// a receiving goes only if EVERY line on it is one we are deleting
const { data: allLines } = rcvIds.length
  ? await admin.from("receiving_lines").select("id, receiving_id").in("receiving_id", rcvIds)
  : { data: [] };
const doomedLines = new Set((rlines ?? []).map((l) => l.id));
const emptyAfter = rcvIds.filter((rid) =>
  (allLines ?? []).filter((l) => l.receiving_id === rid).every((l) => doomedLines.has(l.id))
);

console.log(`\n  stock_movements : ${(movs ?? []).length}`);
console.log(`  receiving_lines : ${(rlines ?? []).length}`);
console.log(`  receivings left empty : ${emptyAfter.length} of ${rcvIds.length}`);
console.log(`  engines : ${engineIds.length}`);
console.log(`  engine_models : ${modelIds.length}`);

if (!GO) { console.log(`\nRe-run with --yes to delete.\n`); process.exit(0); }

const del = async (t, col, vals) => {
  if (!vals.length) return;
  const { error } = await admin.from(t).delete().in(col, vals);
  if (error) throw new Error(`${t}: ${error.message}`);
};

console.log("\nexecuting…");
await del("stock_movements", "engine_id", engineIds);
await del("receiving_lines", "engine_id", engineIds);
await del("engines", "id", engineIds);
await del("receivings", "id", emptyAfter);
await del("engine_models", "id", modelIds);

const { data: left } = await admin
  .from("engine_models").select("id").like("brand", PREFIX);
const { data: mvLeft } = await admin
  .from("stock_movements").select("id").in("engine_id", engineIds);
console.log(`\nremaining fixture models: ${(left ?? []).length}`);
console.log(`remaining fixture movements: ${(mvLeft ?? []).length}`);
if ((left ?? []).length || (mvLeft ?? []).length) {
  console.log("\nSomething is still pinned — check the FK error above.");
  process.exit(1);
}
console.log("clean.\n");
