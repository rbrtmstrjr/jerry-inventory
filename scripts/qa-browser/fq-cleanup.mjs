/**
 * Remove the ZZ-QA fixtures the fractional-quantity UI sweep left on staging.
 *
 * These are NOT the harness's fixtures. The harness provisions a throwaway shop
 * and deletes by shop_id; this sweep drove the REAL shops (Gerwin-Ternate,
 * Gerwin-Bacoor) through the real UI, so everything must be scoped by the
 * fixture PART instead — deleting by shop here would delete the client's data.
 *
 * DRY RUN BY DEFAULT. Pass --yes to actually delete.
 *
 * Order matters and is the same lesson _harness.mjs encodes: movements before
 * the rows they point at, lines before headers. stock_movements are deleted by
 * part_id ALONE and not by shop — the master-side rows carry shop_id IS NULL,
 * so a shop-scoped delete strands them and every later delete fails on the FK.
 *
 * A parent (sale / delivery / receiving) is deleted ONLY when every one of its
 * lines belongs to a fixture part. A real sale that happened to include a
 * fixture line is left alone, minus that line — never removed wholesale.
 */
import { createClient } from "@supabase/supabase-js";
import { assertWritableEnv, readEnvFile } from "../_env-guard.mjs";

assertWritableEnv("The fractional-quantity QA cleanup (it deletes fixtures)");
const env = readEnvFile();

const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const GO = process.argv.includes("--yes");
const PREFIX = "ZZ-QA %";

let planned = 0;
function plan(what, n) {
  if (!n) return;
  planned += n;
  console.log(`  ${GO ? "delete" : "would delete"} ${n} × ${what}`);
}
async function del(table, col, vals) {
  if (!vals.length) return;
  if (!GO) return;
  const { error } = await admin.from(table).delete().in(col, vals);
  if (error) throw new Error(`${table}: ${error.message}`);
}

console.log(`\n${GO ? "DELETING" : "DRY RUN"} — ZZ-QA fractional-quantity fixtures`);
console.log(`project: ${env.NEXT_PUBLIC_SUPABASE_URL}\n`);

// ── the fixture parts ────────────────────────────────────────────────────────
const { data: parts } = await admin
  .from("parts").select("id,name,unit").like("name", PREFIX);
const partIds = (parts ?? []).map((p) => p.id);
console.log(`fixture parts (${partIds.length}):`);
for (const p of parts ?? []) console.log(`  · ${p.name} [${p.unit}]`);
if (!partIds.length) {
  console.log("\nnothing to do.");
  process.exit(0);
}

/** ids of parents whose lines are ENTIRELY ours — safe to remove wholesale. */
async function exclusiveParents(lineTable, fkCol) {
  const { data: mine } = await admin
    .from(lineTable).select(`${fkCol}`).in("part_id", partIds);
  const ids = [...new Set((mine ?? []).map((r) => r[fkCol]))];
  if (!ids.length) return { ids: [], shared: [] };
  const { data: all } = await admin
    .from(lineTable).select(`${fkCol},part_id,engine_id`).in(fkCol, ids);
  const exclusive = ids.filter((id) =>
    (all ?? [])
      .filter((r) => r[fkCol] === id)
      .every((r) => r.part_id && partIds.includes(r.part_id))
  );
  return { ids: exclusive, shared: ids.filter((i) => !exclusive.includes(i)) };
}

console.log("\nsales");
const sales = await exclusiveParents("sale_lines", "sale_id");
if (sales.shared.length) console.log(`  ! ${sales.shared.length} sale(s) also hold non-fixture lines — leaving the sale, dropping only our line`);
const { data: saleLines } = await admin
  .from("sale_lines").select("id").in("part_id", partIds);
plan("sale_line_costs", (saleLines ?? []).length);
plan("sale_lines", (saleLines ?? []).length);
plan("sales (fixture-only)", sales.ids.length);

console.log("\ndeliveries");
const dels = await exclusiveParents("delivery_lines", "delivery_id");
const { data: delLines } = await admin
  .from("delivery_lines").select("id").in("part_id", partIds);
const delLineIds = (delLines ?? []).map((l) => l.id);
const { data: discreps } = delLineIds.length
  ? await admin.from("delivery_discrepancies").select("id").in("delivery_line_id", delLineIds)
  : { data: [] };
plan("delivery_discrepancies", (discreps ?? []).length);
plan("delivery_lines", delLineIds.length);
plan("deliveries (fixture-only)", dels.ids.length);

console.log("\nreceivings");
const recs = await exclusiveParents("receiving_lines", "receiving_id");
const { data: recLines } = await admin
  .from("receiving_lines").select("id").in("part_id", partIds);
plan("receiving_lines", (recLines ?? []).length);
plan("receivings (fixture-only)", recs.ids.length);

console.log("\nreturns");
const rets = await exclusiveParents("return_lines", "return_id");
const { data: retLines } = await admin
  .from("return_lines").select("id").in("part_id", partIds);
plan("return_lines", (retLines ?? []).length);
plan("returns (fixture-only)", rets.ids.length);

console.log("\nlosses");
const { data: losses } = await admin.from("losses").select("id").in("part_id", partIds);
plan("losses", (losses ?? []).length);

console.log("\ndelivery requests");
// a request is ours if it carries a ZZ-QA custom line; the whole request was
// created by this sweep, so it goes as a unit
const { data: customLines } = await admin
  .from("delivery_request_lines").select("delivery_request_id").like("custom_name", PREFIX);
const reqIds = [...new Set((customLines ?? []).map((r) => r.delivery_request_id))];
const { data: allReqLines } = reqIds.length
  ? await admin.from("delivery_request_lines").select("id").in("delivery_request_id", reqIds)
  : { data: [] };
plan("delivery_request_lines", (allReqLines ?? []).length);
plan("delivery_requests", reqIds.length);

console.log("\nledger + shelf");
const { data: movements } = await admin
  .from("stock_movements").select("id").in("part_id", partIds);
plan("stock_movements (master + every shop)", (movements ?? []).length);
const { data: levels } = await admin
  .from("stock_levels").select("id,qty,shop_id").in("part_id", partIds);
plan("stock_levels", (levels ?? []).length);
plan("parts", partIds.length);

if (!GO) {
  console.log(`\n${planned} rows would be deleted. Re-run with --yes to do it.`);
  process.exit(0);
}

// ── execute, parents last ───────────────────────────────────────────────────
console.log("\nexecuting…");
await del("sale_line_costs", "sale_line_id", (saleLines ?? []).map((l) => l.id));
await del("sale_lines", "part_id", partIds);
await del("delivery_discrepancies", "id", (discreps ?? []).map((d) => d.id));
await del("delivery_lines", "part_id", partIds);
await del("receiving_lines", "part_id", partIds);
await del("return_lines", "part_id", partIds);
await del("losses", "part_id", partIds);
await del("delivery_request_lines", "delivery_request_id", reqIds);
await del("delivery_requests", "id", reqIds);

// movements by part_id only: the master row is shop_id IS NULL, and a
// shop-scoped delete would strand it and break every FK delete after it
await del("stock_movements", "part_id", partIds);

await del("sales", "id", sales.ids);
await del("deliveries", "id", dels.ids);
await del("receivings", "id", recs.ids);
await del("returns", "id", rets.ids);
await del("stock_levels", "part_id", partIds);
await del("parts", "id", partIds);

// ── prove it ────────────────────────────────────────────────────────────────
const { data: left } = await admin.from("parts").select("id").like("name", PREFIX);
const { data: mvLeft } = await admin
  .from("stock_movements").select("id").in("part_id", partIds);
console.log(`\nremaining fixture parts: ${(left ?? []).length}`);
console.log(`remaining fixture movements: ${(mvLeft ?? []).length}`);
if ((left ?? []).length || (mvLeft ?? []).length) {
  console.log("\nSomething is still pinned — check the FK error above.");
  process.exit(1);
}
console.log("clean.\n");
