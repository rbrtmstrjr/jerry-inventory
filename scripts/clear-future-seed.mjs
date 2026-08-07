/**
 * Remove seeded submissions dated in the FUTURE.
 *
 * WHY THIS EXISTS: seed-states.mjs and seed-load-test.mjs stamp every batch
 * `at(day, 18)` — 6 PM on the business day — regardless of the real clock. Seed
 * in the morning and the whole dataset lands hours ahead of you, so a batch a
 * shop submits RIGHT NOW sorts below yesterday's fixtures on the Approval
 * Queue and looks like a broken sort. It is not: the data is in the future.
 *
 * Scope is deliberately narrow: only submissions whose batch was "submitted"
 * after this moment, and only while still pending/questioned. Anything already
 * approved is history and is left alone — deleting it would move stock and
 * rewrite the P&L.
 *
 * DRY RUN BY DEFAULT. Pass --yes to delete.
 */
import { createClient } from "@supabase/supabase-js";
import { assertWritableEnv, readEnvFile } from "./_env-guard.mjs";

assertWritableEnv("clear-future-seed (it deletes pending seeded submissions)");
const env = readEnvFile();

const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const GO = process.argv.includes("--yes");
const NOW = new Date().toISOString();

console.log(`\n${GO ? "DELETING" : "DRY RUN"} — seeded submissions dated after ${NOW}`);
console.log(`project: ${env.NEXT_PUBLIC_SUPABASE_URL}\n`);

// ── batches stamped in the future ───────────────────────────────────────────
const { data: futureBatches, error: bErr } = await admin
  .from("submission_batches").select("id, submitted_at").gt("submitted_at", NOW);
if (bErr) throw new Error(bErr.message);
const batchIds = (futureBatches ?? []).map((b) => b.id);
console.log(`future-dated batches: ${batchIds.length}`);
if (!batchIds.length) { console.log("nothing to do.\n"); process.exit(0); }

/** Pending rows of one type that belong to a future batch. */
async function pendingIn(table) {
  const { data } = await admin
    .from(table).select("id")
    .in("status", ["pending", "questioned"])
    .in("batch_id", batchIds);
  return (data ?? []).map((r) => r.id);
}
const saleIds = await pendingIn("sales");
const lossIds = await pendingIn("losses");
const expenseIds = await pendingIn("expenses");

console.log(`  pending sales    : ${saleIds.length}`);
console.log(`  pending losses   : ${lossIds.length}`);
console.log(`  pending expenses : ${expenseIds.length}`);

// A batch is only removable once nothing pending points at it AND nothing
// approved does either — an approved sale keeps its batch_id forever.
const { data: stillRef } = await admin
  .from("sales").select("batch_id").in("batch_id", batchIds);
const { data: stillRefL } = await admin
  .from("losses").select("batch_id").in("batch_id", batchIds);
const { data: stillRefE } = await admin
  .from("expenses").select("batch_id").in("batch_id", batchIds);
const keep = new Set([
  ...(stillRef ?? []).map((r) => r.batch_id),
  ...(stillRefL ?? []).map((r) => r.batch_id),
  ...(stillRefE ?? []).map((r) => r.batch_id),
]);
const doomedRows = new Set([...saleIds, ...lossIds, ...expenseIds]);
// after the deletes above, a batch is empty only if EVERY row pointing at it
// is one we are deleting
const { data: allRefs } = await admin
  .from("sales").select("id, batch_id").in("batch_id", batchIds);
const emptyAfter = batchIds.filter((bid) => {
  const refs = [
    ...(allRefs ?? []).filter((r) => r.batch_id === bid).map((r) => r.id),
  ];
  return refs.every((id) => doomedRows.has(id));
});
console.log(`  batches left empty: ${emptyAfter.length}`);

if (!GO) {
  console.log(`\nRe-run with --yes to delete.\n`);
  process.exit(0);
}

// ── delete, children first ──────────────────────────────────────────────────
const del = async (t, col, vals) => {
  if (!vals.length) return;
  const { error } = await admin.from(t).delete().in(col, vals);
  if (error) throw new Error(`${t}: ${error.message}`);
};

console.log("\nexecuting…");
if (saleIds.length) {
  await del("sale_line_costs", "sale_id", saleIds);
  await del("sale_lines", "sale_id", saleIds);
  await del("utang_payments", "sale_id", saleIds);
}
// pending rows never moved stock, but sweep any ledger row defensively
await del("stock_movements", "sale_id", saleIds);
await del("stock_movements", "loss_id", lossIds);

await del("sales", "id", saleIds);
await del("losses", "id", lossIds);
await del("expenses", "id", expenseIds);
await del("submission_batches", "id", emptyAfter);

// ── prove it ────────────────────────────────────────────────────────────────
const after = async (t) => {
  const { data } = await admin
    .from(t).select("id").in("status", ["pending", "questioned"]).in("batch_id", batchIds);
  return (data ?? []).length;
};
console.log(`\nremaining future-dated pending: sales ${await after("sales")}, ` +
  `losses ${await after("losses")}, expenses ${await after("expenses")}`);
console.log("done.\n");
