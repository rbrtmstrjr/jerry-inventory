/**
 * Remove the client-demo fixture set created by demo-provision.mjs, plus
 * EVERYTHING the demo session hung off it in the UI (receivings, deliveries,
 * sales, warranties, utang, movements, notifications, engines born from the
 * demo model, customers created inline on demo-shop sales).
 *
 * Deletion order mirrors scripts/_harness.mjs cleanup() — children first,
 * movements by BOTH shop_id AND part/engine id (the master-side row has
 * shop_id IS NULL and would otherwise FK-block everything after it).
 *
 * Dry run by default; pass --yes to actually delete.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync, unlinkSync } from "node:fs";

const MANIFEST = new URL("./.demo-fixtures.json", import.meta.url);
if (!existsSync(MANIFEST)) {
  console.error("No scripts/.demo-fixtures.json — nothing to clean.");
  process.exit(1);
}
const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
const YES = process.argv.includes("--yes");

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const ids = async (table, col, val, sel = "id") => {
  const q = admin.from(table).select(sel);
  const { data } = Array.isArray(val) ? await q.in(col, val) : await q.eq(col, val);
  return (data ?? []).map((r) => r[sel]);
};

// ── discover everything hanging off the demo set ─────────────────────────────
const engineIds = await ids("engines", "engine_model_id", m.engine_model_id);
const saleIds = await ids("sales", "shop_id", m.shop_id);
const warrantyIds = saleIds.length ? await ids("warranties", "sale_id", saleIds) : [];
const deliveryIds = await ids("deliveries", "shop_id", m.shop_id);
const returnIds = await ids("returns", "shop_id", m.shop_id);
const requestIds = await ids("delivery_requests", "shop_id", m.shop_id);
const snapshotIds = await ids("count_snapshots", "shop_id", m.shop_id);

// receivings that touched demo parts or demo engines
const rcvFromParts = m.part_ids.length
  ? await ids("receiving_lines", "part_id", m.part_ids, "receiving_id")
  : [];
const rcvFromEngines = engineIds.length
  ? await ids("receiving_lines", "engine_id", engineIds, "receiving_id")
  : [];
const receivingIds = [...new Set([...rcvFromParts, ...rcvFromEngines])];

// customers created inline on demo-shop sales (only if they have no other sales)
const custCandidates = [
  ...new Set(
    saleIds.length ? (await admin.from("sales").select("customer_id").in("id", saleIds)).data
          ?.map((r) => r.customer_id)
          .filter(Boolean) ?? []
      : []
  ),
];
const demoOnlyCustomers = [];
for (const c of custCandidates) {
  const { count } = await admin
    .from("sales")
    .select("id", { count: "exact", head: true })
    .eq("customer_id", c)
    .not("shop_id", "eq", m.shop_id);
  if (!count) demoOnlyCustomers.push(c);
}

console.log(`${YES ? "DELETING" : "DRY RUN (pass --yes to delete)"} — demo fixture set:`);
console.log(
  `  shop 1 · parts ${m.part_ids.length} · engine model 1 · engines ${engineIds.length} · ` +
    `sales ${saleIds.length} · warranties ${warrantyIds.length} · deliveries ${deliveryIds.length} · ` +
    `returns ${returnIds.length} · requests ${requestIds.length} · counts ${snapshotIds.length} · ` +
    `receivings ${receivingIds.length} · customers ${demoOnlyCustomers.length} · supplier 1 · login 1`
);
if (!YES) process.exit(0);

const del = (t) => admin.from(t).delete();

// sales subtree
if (saleIds.length) {
  await del("utang_payments").in("sale_id", saleIds);
  if (warrantyIds.length) await del("warranty_claims").in("warranty_id", warrantyIds);
  await del("warranties").in("sale_id", saleIds);
  await del("sale_line_costs").in("sale_id", saleIds);
  await del("sale_lines").in("sale_id", saleIds);
}

// movements before everything they point at — by shop AND by item
await del("stock_movements").eq("shop_id", m.shop_id);
if (m.part_ids.length) await del("stock_movements").in("part_id", m.part_ids);
if (engineIds.length) await del("stock_movements").in("engine_id", engineIds);

if (saleIds.length) await del("sales").in("id", saleIds);

// counts before losses (shortage_loss_id FK)
if (snapshotIds.length) await del("count_snapshot_lines").in("snapshot_id", snapshotIds);
await del("count_snapshots").eq("shop_id", m.shop_id);
await del("losses").eq("shop_id", m.shop_id);
await del("submission_batches").eq("shop_id", m.shop_id);

// deliveries / returns / requests
if (deliveryIds.length) {
  await del("delivery_discrepancies").in("delivery_id", deliveryIds);
  await del("delivery_lines").in("delivery_id", deliveryIds);
}
await del("expenses").eq("shop_id", m.shop_id);
if (deliveryIds.length) await del("deliveries").in("id", deliveryIds);
if (returnIds.length) {
  await del("return_lines").in("return_id", returnIds);
  await del("returns").in("id", returnIds);
}
if (requestIds.length) {
  await del("delivery_request_lines").in("delivery_request_id", requestIds);
  await del("delivery_requests").in("id", requestIds);
}

// receivings + supplier debt
if (receivingIds.length) {
  await del("supplier_payments").in("receiving_id", receivingIds);
  await del("receiving_lines").in("receiving_id", receivingIds);
  await del("receivings").in("id", receivingIds);
}
await del("supplier_payments").eq("supplier_id", m.supplier_id);
await del("supplier_quotes").eq("supplier_id", m.supplier_id);

// alerts + levels
await del("notifications").eq("shop_id", m.shop_id);
if (m.part_ids.length) await del("notifications").in("ref_id", m.part_ids);
if (engineIds.length) await del("notifications").in("ref_id", engineIds);
await del("shop_reorder_levels").eq("shop_id", m.shop_id);
if (m.part_ids.length) await del("stock_levels").in("part_id", m.part_ids);
await del("stock_levels").eq("shop_id", m.shop_id);

// catalog
if (engineIds.length) await del("engines").in("id", engineIds);
if (m.part_ids.length) await del("parts").in("id", m.part_ids);
await del("engine_models").eq("id", m.engine_model_id);
await del("suppliers").eq("id", m.supplier_id);
if (demoOnlyCustomers.length) await del("customers").in("id", demoOnlyCustomers);

// login + shop last
await del("profiles").eq("id", m.user_id);
await admin.auth.admin.deleteUser(m.user_id).catch(() => {});
await del("shops").eq("id", m.shop_id);

// verify nothing stranded
const leaks = [];
const still = async (table, col, val, label) => {
  const q = admin.from(table).select("id");
  const { data } = Array.isArray(val) ? await q.in(col, val) : await q.eq(col, val);
  if (data?.length) leaks.push(`${data.length} ${label}`);
};
await still("shops", "id", m.shop_id, "shop");
await still("parts", "id", m.part_ids, "part(s)");
await still("engines", "id", engineIds.length ? engineIds : ["00000000-0000-4000-8000-000000000000"], "engine(s)");
await still("suppliers", "id", m.supplier_id, "supplier");
await still("engine_models", "id", m.engine_model_id, "engine model");

if (leaks.length) {
  console.error(`LEAKED: ${leaks.join(", ")} — manifest kept for a retry.`);
  process.exit(1);
}
unlinkSync(MANIFEST);
console.log("Demo fixtures fully removed; manifest deleted.");
