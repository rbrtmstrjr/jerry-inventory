/**
 * Data-level backup of every public table via the service role, for the audit.
 * Schema is NOT dumped here — it lives in supabase/migrations 0001–0046 (git).
 * Restore procedure: fresh Supabase project → run migrations in order → insert
 * each table's JSON in FK order → recreate auth users (hashes NOT exportable).
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
const env = Object.fromEntries(readFileSync(".env.local","utf8").split("\n")
  .filter(l=>l.includes("=")&&!l.startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {auth:{persistSession:false}});

const STAMP = new Date().toISOString().slice(0,19).replace(/[:T]/g,"-");
const DIR = `backups/audit-${STAMP}`;
mkdirSync(DIR, { recursive: true });

// Every table in supabase/migrations 0001–0046, FK-parents first.
const TABLES = [
  ["shops","id"],["profiles","id"],["suppliers","id"],["product_categories","id"],
  ["engine_models","id"],["parts","id"],["part_fitments","id"],["customers","id"],
  ["engines","id"],["stock_levels","id"],["receivings","id"],["receiving_lines","id"],
  ["deliveries","id"],["delivery_lines","id"],["delivery_discrepancies","id"],
  ["returns","id"],["return_lines","id"],["submission_batches","id"],
  ["sales","id"],["sale_lines","id"],["sale_line_costs","sale_line_id"],
  ["losses","id"],["utang_payments","id"],["supplier_payments","id"],["supplier_quotes","id"],
  ["stock_movements","id"],["warranties","id"],["warranty_claims","id"],
  ["count_snapshots","id"],["count_snapshot_lines","id"],
  ["positions","id"],["staff","id"],["pay_periods","id"],["payroll_entries","id"],
  ["contribution_brackets","id"],["payroll_entry_contributions","id"],
  ["expense_categories","id"],["expenses","id"],
  ["shop_reorder_levels","id"],["delivery_requests","id"],["delivery_request_lines","id"],
  ["notifications","id"],["notification_channels","code"],["notification_dispatches","id"],
  ["settings","id"],
];

const manifest = { stamp: STAMP, project: env.NEXT_PUBLIC_SUPABASE_URL, tables: {}, problems: [] };

for (const [table, pk] of TABLES) {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin.from(table).select("*").order(pk).range(from, from + PAGE - 1);
    if (error) { manifest.problems.push(`${table}: ${error.message}`); break; }
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  // Independent count to prove the dump is complete, not just non-empty.
  const { count } = await admin.from(table).select("*", { count: "exact", head: true });
  const ok = rows.length === (count ?? 0);
  if (!ok) manifest.problems.push(`${table}: dumped ${rows.length} but count says ${count}`);
  writeFileSync(`${DIR}/${table}.json`, JSON.stringify(rows));
  manifest.tables[table] = { rows: rows.length, count: count ?? 0, complete: ok };
  console.log(`${ok ? "✓" : "✗"} ${table.padEnd(30)} ${String(rows.length).padStart(6)} rows`);
}

// Auth users — ids/emails/metadata only; password hashes are NOT exportable.
const { data: users } = await admin.auth.admin.listUsers({ perPage: 1000 });
writeFileSync(`${DIR}/_auth_users.json`, JSON.stringify(users?.users?.map(u=>({id:u.id,email:u.email,created_at:u.created_at,last_sign_in_at:u.last_sign_in_at})) ?? []));
console.log(`✓ ${"auth users (no hashes)".padEnd(30)} ${String(users?.users?.length ?? 0).padStart(6)} rows`);

// Storage inventory (paths + sizes, not bytes).
for (const bucket of ["product-images","receipts"]) {
  const { data: files } = await admin.storage.from(bucket).list("", { limit: 1000 });
  writeFileSync(`${DIR}/_storage_${bucket}.json`, JSON.stringify(files ?? []));
  console.log(`✓ ${("storage:"+bucket).padEnd(30)} ${String(files?.length ?? 0).padStart(6)} objects (inventory only)`);
}

writeFileSync(`${DIR}/_manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`\n${manifest.problems.length === 0 ? "BACKUP COMPLETE" : "BACKUP HAS PROBLEMS:"} → ${DIR}`);
manifest.problems.forEach(p=>console.log("  !! " + p));
