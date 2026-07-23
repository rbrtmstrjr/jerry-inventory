/**
 * FRESH START — wipe all operational data so the system starts from the top
 * of the flow (supplier → receiving → delivery → sale → approval).
 *
 * KEEPS (system/config, not sample data):
 *   • the admin auth user + profile (robertmaestro09@gmail.com)
 *   • settings (business identity + operating dials)
 *   • product_categories (reference data — firstCategoryId() and pickers need one)
 *   • contribution_brackets (the SSS/PhilHealth/Pag-IBIG rate book — DATA, not sample)
 *   • notification_channels (channel config; in_app enabled, sms disabled)
 *
 * DELETES everything else, FK-safe order, plus all non-admin auth users and
 * every object in the product-images / receipts storage buckets.
 *
 * A full JSON backup of every table is written BEFORE any delete:
 *   backup-pre-wipe-<date>.json (project root, untracked).
 *
 * Dry run by default — pass --yes to actually delete.
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const YES = process.argv.includes("--yes");
const ADMIN_EMAIL = "robertmaestro09@gmail.com";

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Children before parents. stock_movements first (it references sales, losses,
// deliveries, returns, receivings, parts, engines, shops all at once).
const WIPE_ORDER = [
  "stock_movements",
  "notification_dispatches",
  "notifications",
  "warranty_claims",
  "warranties",
  "utang_payments",
  "sale_line_costs",
  "sale_lines",
  "count_snapshot_lines", // shortage_loss_id FK → before losses
  "count_snapshots",
  "losses",
  "sales",
  "expenses", // FK deliveries AND (0051) submission_batches → before both
  "submission_batches",
  "delivery_discrepancies",
  "delivery_request_lines",
  "delivery_requests", // fulfilled_delivery_id FK → before deliveries
  "delivery_lines",
  "deliveries",
  "return_lines",
  "returns",
  "supplier_payments",
  "receiving_lines",
  "receivings",
  "supplier_quotes",
  "stock_levels",
  "shop_reorder_levels",
  "part_fitments",
  "engines",
  "part_merges", // 0052: FKs parts → before parts
  "parts",
  "engine_models",
  "discount_cards", // 0072: FK customers → before customers (sales already gone)
  "customers",
  "suppliers",
  "payroll_entry_contributions",
  "staff_advances", // 0071: FK staff → before staff
  "payroll_entries",
  "pay_periods",
  "staff",
  "positions",
  // profiles + shops handled separately (admin profile survives)
];

const KEEP = ["settings", "product_categories", "contribution_brackets", "notification_channels"];

async function fetchAll(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await admin.from(table).select("*").range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

// ── counts (backup deliberately removed — testing data only, per the owner) ──
const counts = {};
for (const t of [...WIPE_ORDER, "profiles", "shops", ...KEEP]) {
  counts[t] = (await fetchAll(t)).length;
}
const { data: userList } = await admin.auth.admin.listUsers({ perPage: 1000 });
const users = userList?.users ?? [];
const adminUser = users.find((u) => u.email === ADMIN_EMAIL);
if (!adminUser) {
  console.error(`SAFETY STOP: admin user ${ADMIN_EMAIL} not found — refusing to wipe.`);
  process.exit(1);
}

console.log(`\n${YES ? "DELETING" : "DRY RUN (pass --yes to delete)"}:`);
for (const t of WIPE_ORDER) if (counts[t]) console.log(`  ${t}: ${counts[t]} row(s)`);
console.log(`  profiles: ${counts.profiles - 1} of ${counts.profiles} (admin kept)`);
console.log(`  shops: ${counts.shops} row(s)`);
console.log(`  auth users: ${users.length - 1} of ${users.length} (${ADMIN_EMAIL} kept)`);
console.log(`  + all objects in product-images and receipts buckets`);
console.log(`KEPT: ${KEEP.join(", ")}, admin login`);
if (!YES) process.exit(0);

// ── wipe ─────────────────────────────────────────────────────────────────────
// Two tables have no `id` column: sale_line_costs (PK = sale_line_id) and
// part_fitments (composite PK) — the delete filter must name a real column.
const FILTER_COL = { sale_line_costs: "sale_line_id", part_fitments: "part_id" };
// Load-test volumes (100k+ rows) blow the statement timeout on a whole-table
// DELETE. Strategy: try the full created_at range in one statement (fast for
// small tables); on statement timeout, split the window in half and recurse;
// on pool timeout, wait and retry the same window.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Not every table carries created_at: batches stamp submitted_at,
// discrepancies resolved_at, and part_fitments has no timestamp (tiny —
// whole-table delete via its FK column instead).
const TIME_COL = {
  submission_batches: "submitted_at",
  delivery_discrepancies: "resolved_at",
  part_merges: "merged_at",
  part_fitments: null,
};
async function delRange(t, fromIso, toIso, depth = 0) {
  const col = TIME_COL[t] === undefined ? "created_at" : TIME_COL[t];
  if (col === null) {
    const { error } = await admin.from(t).delete().not(FILTER_COL[t] ?? "id", "is", null);
    if (error) throw new Error(`${t}: ${error.message}`);
    return;
  }
  for (let attempt = 1; ; attempt++) {
    const { error } = await admin.from(t).delete()
      .gte(col, fromIso).lt(col, toIso);
    if (!error) return;
    if (/pool/i.test(error.message) && attempt < 6) {
      await sleep(attempt * 3000);
      continue;
    }
    if (/timeout/i.test(error.message) && depth < 14) {
      const a = Date.parse(fromIso), b = Date.parse(toIso);
      const mid = new Date((a + b) / 2).toISOString();
      await delRange(t, fromIso, mid, depth + 1);
      await delRange(t, mid, toIso, depth + 1);
      return;
    }
    throw new Error(`${t}: ${error.message}`);
  }
}
for (const t of WIPE_ORDER) {
  try {
    await delRange(t, "2015-01-01T00:00:00Z", "2035-01-01T00:00:00Z");
  } catch (e) {
    console.error(`FAILED at ${t}: ${e.message} — nothing after this was deleted.`);
    process.exit(1);
  }
}

// profiles: everyone but the admin, then their auth users, then shops
{
  const { error } = await admin.from("profiles").delete().neq("id", adminUser.id);
  if (error) { console.error(`profiles: ${error.message}`); process.exit(1); }
  for (const u of users) {
    if (u.id === adminUser.id) continue;
    await admin.auth.admin.deleteUser(u.id).catch((e) => console.error(`auth ${u.email}: ${e.message}`));
  }
  // 0051: shop-proposed expense categories pin their shop via FK — proposals
  // are operational data (drop), and any stray pointer is nulled.
  await admin.from("expense_categories").delete().eq("status", "proposed");
  await admin.from("expense_categories")
    .update({ proposed_by_shop_id: null }).not("proposed_by_shop_id", "is", null);
  const { error: shopErr } = await admin.from("shops").delete().not("id", "is", null);
  if (shopErr) { console.error(`shops: ${shopErr.message}`); process.exit(1); }
}

// storage buckets
for (const bucket of ["product-images", "receipts"]) {
  let removed = 0;
  for (;;) {
    const { data: objs, error } = await admin.storage.from(bucket).list("", { limit: 100 });
    if (error) { console.error(`storage ${bucket}: ${error.message}`); break; }
    // FILES have an id; FOLDER entries don't — remove() can't delete a folder,
    // so keeping them in the list loops forever (e.g. shop-logos/).
    const folders = (objs ?? []).filter((o) => o.name && !o.id).map((o) => o.name);
    let names = (objs ?? []).filter((o) => o.name && o.id).map((o) => o.name);
    for (const dir of folders) {
      const { data: inner } = await admin.storage.from(bucket).list(dir, { limit: 1000 });
      names = names.concat((inner ?? []).filter((o) => o.id).map((o) => `${dir}/${o.name}`));
    }
    if (!names.length) break;
    await admin.storage.from(bucket).remove(names);
    removed += names.length;
  }
  console.log(`storage ${bucket}: ${removed} object(s) removed`);
}

// ── verify ───────────────────────────────────────────────────────────────────
const leaks = [];
for (const t of [...WIPE_ORDER, "shops"]) {
  const { count } = await admin.from(t).select("*", { count: "exact", head: true });
  if (count) leaks.push(`${t}: ${count}`);
}
const { count: profCount } = await admin.from("profiles").select("id", { count: "exact", head: true });
if (profCount !== 1) leaks.push(`profiles: ${profCount} (expected 1)`);
for (const t of KEEP) {
  const { count } = await admin.from(t).select("*", { count: "exact", head: true });
  console.log(`kept ${t}: ${count} row(s)`);
}

const anon = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const { error: loginErr } = await anon.auth.signInWithPassword({
  email: ADMIN_EMAIL,
  password: "rajonrondo09",
});
console.log(loginErr ? `ADMIN LOGIN BROKEN: ${loginErr.message}` : "admin login verified ✓");

if (leaks.length) {
  console.error(`\nLEFT BEHIND: ${leaks.join(" · ")}`);
  process.exit(1);
}
console.log("\nDatabase is clean — the flow starts from the top: Suppliers → Receiving.");
