/**
 * Remove orphaned ZZ-TEST fixtures left by a crashed run.
 *
 * Every harness fixture is named `ZZ-TEST … <RUN>`, and a suite that throws
 * before `cleanup()` leaves its shop/parts/customers behind. This sweeps them.
 *
 * SAFETY
 *  - Only ever touches rows whose NAME starts with `ZZ-TEST` (or that hang off
 *    such a shop). Real data has no such name.
 *  - Prints what it would remove and requires --yes to actually delete.
 *  - Do NOT run while suites are running: another process's in-flight fixtures
 *    match the same prefix and would be deleted out from under it.
 *
 * Run: node scripts/sweep-test-fixtures.mjs          # dry run
 *      node scripts/sweep-test-fixtures.mjs --yes    # delete
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);

const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const GO = process.argv.includes("--yes");
const PREFIX = "ZZ-TEST%";

const { data: shops } = await admin.from("shops").select("id, name").like("name", PREFIX);
const { data: parts } = await admin.from("parts").select("id, name").like("name", PREFIX).is("deleted_at", null);
const { data: customers } = await admin.from("customers").select("id, name").like("name", PREFIX).is("deleted_at", null);
const { data: suppliers } = await admin.from("suppliers").select("id, name").like("name", PREFIX).is("deleted_at", null);

const shopIds = (shops ?? []).map((s) => s.id);
const partIds = (parts ?? []).map((p) => p.id);

// Engines by serial prefix is NOT enough: scripts name serials freely (E2E uses
// `E2E-<RUN>`), so also take every engine sitting at a test shop. An engine
// missed here holds an FK that blocks the whole shop delete.
//
// Soft-deleted rows are skipped: the pre-2026-07-10 scripts retired their
// fixtures with `deleted_at` instead of removing them. They're invisible to the
// app and some are FK-pinned by real ledger rows, so they are not "orphans to
// sweep" — flagging them would just make this output permanently noisy.
const { data: engBySerial } = await admin
  .from("engines").select("id")
  .is("deleted_at", null)
  .or("serial_number.like.ZZ-%,serial_number.like.RLS-%,serial_number.like.E2E-%,serial_number.like.RPT-%");
const { data: engByShop } = shopIds.length
  ? await admin.from("engines").select("id").in("shop_id", shopIds)
  : { data: [] };
const engineIds = [...new Set([...(engBySerial ?? []), ...(engByShop ?? [])].map((e) => e.id))];

console.log("Orphaned test fixtures:");
console.log(`  shops     ${shops?.length ?? 0}`);
console.log(`  parts     ${parts?.length ?? 0}`);
console.log(`  engines   ${engineIds.length}`);
console.log(`  customers ${customers?.length ?? 0}`);
console.log(`  suppliers ${suppliers?.length ?? 0}`);

if (!shopIds.length && !partIds.length && !customers?.length && !engineIds.length && !suppliers?.length) {
  console.log("\nNothing to sweep.");
  process.exit(0);
}
if (!GO) {
  console.log("\nDry run. Re-run with --yes to delete. Do not run while suites are running.");
  process.exit(0);
}

const del = (t) => admin.from(t).delete();
const inShops = async (t, col = "shop_id") => {
  if (shopIds.length) await del(t).in(col, shopIds);
};

// Children first — same order as the harness cleanup.
if (shopIds.length) {
  const { data: sales } = await admin.from("sales").select("id").in("shop_id", shopIds);
  const saleIds = (sales ?? []).map((s) => s.id);
  if (saleIds.length) {
    await del("utang_payments").in("sale_id", saleIds);
    const { data: ws } = await admin.from("warranties").select("id").in("sale_id", saleIds);
    if (ws?.length) await del("warranty_claims").in("warranty_id", ws.map((w) => w.id));
    await del("warranties").in("sale_id", saleIds);
    await del("sale_line_costs").in("sale_id", saleIds);
    await del("sale_lines").in("sale_id", saleIds);
  }
}
// By shop AND by item: the master-side movement has shop_id IS NULL, so a
// shop-only sweep strands it and every later delete fails on the FK.
await inShops("stock_movements");
if (partIds.length) await del("stock_movements").in("part_id", partIds);
if (engineIds.length) await del("stock_movements").in("engine_id", engineIds);
await inShops("sales");

if (shopIds.length) {
  const { data: snaps } = await admin.from("count_snapshots").select("id").in("shop_id", shopIds);
  if (snaps?.length) await del("count_snapshot_lines").in("snapshot_id", snaps.map((s) => s.id));
}
await inShops("count_snapshots");
await inShops("losses");
await inShops("submission_batches");

if (shopIds.length) {
  const { data: ds } = await admin.from("deliveries").select("id").in("shop_id", shopIds);
  if (ds?.length) {
    await del("delivery_discrepancies").in("delivery_id", ds.map((d) => d.id));
    await del("delivery_lines").in("delivery_id", ds.map((d) => d.id));
  }
  const { data: rs } = await admin.from("returns").select("id").in("shop_id", shopIds);
  if (rs?.length) await del("return_lines").in("return_id", rs.map((r) => r.id));
  const { data: reqs } = await admin.from("delivery_requests").select("id").in("shop_id", shopIds);
  if (reqs?.length) await del("delivery_request_lines").in("delivery_request_id", reqs.map((r) => r.id));
}
await inShops("expenses");
await inShops("deliveries");
await inShops("returns");
await inShops("delivery_requests");
await inShops("notifications");
await inShops("staff");
await inShops("shop_reorder_levels");
await inShops("stock_levels");
if (partIds.length) {
  await del("shop_reorder_levels").in("part_id", partIds);
  await del("stock_levels").in("part_id", partIds);
  await del("receiving_lines").in("part_id", partIds);
}
if (engineIds.length) {
  await del("receiving_lines").in("engine_id", engineIds);
  await del("delivery_lines").in("engine_id", engineIds);
}

await del("expense_categories").like("name", PREFIX);
await del("positions").like("title", PREFIX);

// receivings whose lines are all gone
const { data: rcv } = await admin.from("receivings").select("id").like("note", "%ZZ-TEST%");
if (rcv?.length) {
  await del("supplier_payments").in("receiving_id", rcv.map((r) => r.id));
  await del("receiving_lines").in("receiving_id", rcv.map((r) => r.id));
  await del("receivings").in("id", rcv.map((r) => r.id));
}

if (engineIds.length) await del("engines").in("id", engineIds);
await inShops("engines");
if (partIds.length) await del("parts").in("id", partIds);
if (customers?.length) await del("customers").in("id", customers.map((c) => c.id));
if (suppliers?.length) {
  await del("supplier_payments").in("supplier_id", suppliers.map((s) => s.id));
  await del("suppliers").in("id", suppliers.map((s) => s.id));
}

// logins attached to the temp shops
if (shopIds.length) {
  const { data: profs } = await admin.from("profiles").select("id").in("shop_id", shopIds);
  for (const p of profs ?? []) {
    await del("profiles").eq("id", p.id);
    await admin.auth.admin.deleteUser(p.id).catch(() => {});
  }
  await del("shops").in("id", shopIds);
}

const { data: leftShops } = await admin.from("shops").select("id, name").like("name", PREFIX);
const { data: leftParts } = await admin.from("parts").select("id").like("name", PREFIX);
const { data: leftCust } = await admin.from("customers").select("id").like("name", PREFIX);
console.log(`\nSwept. Remaining: ${leftShops?.length ?? 0} shops, ${leftParts?.length ?? 0} parts, ${leftCust?.length ?? 0} customers`);
if (leftShops?.length) {
  console.log("Still blocked (likely FK'd by something real — inspect before forcing):");
  leftShops.forEach((s) => console.log(`  ${s.name}`));
}
