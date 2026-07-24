/**
 * Nightly off-site DB backup — the piece that makes the Supabase FREE tier a
 * responsible place for a live business (free = no automated backups, no PITR).
 *
 * What it does:
 *   • Discovers every exposed relation DYNAMICALLY from PostgREST's OpenAPI
 *     root, so a new migration's tables are picked up with no edit here.
 *     (Views come along too; most are is_owner()-guarded and dump empty under
 *     the service role — harmless, and base tables are the real backup.)
 *   • Dumps each relation with the service role (bypasses RLS), paginated
 *     1,000 rows at a time (PostgREST's page cap), into ONE gzipped JSON file:
 *     backups/backup-YYYY-MM-DD.json.gz
 *   • Sanity-checks the tables the business cannot lose (settings, profiles,
 *     stock_movements, sales) and exits non-zero if any of them failed —
 *     a green run MEANS the backup is usable.
 *
 * Side benefit: the nightly API traffic keeps the free project from ever
 * hitting Supabase's 7-day inactivity pause.
 *
 * Runs anywhere Node 20+ exists — zero npm dependencies (plain fetch):
 *   • CI: .github/workflows/db-backup.yml (secrets SUPABASE_URL +
 *     SUPABASE_SERVICE_ROLE_KEY), artifact retention 90 days.
 *   • Local: node scripts/backup-db.mjs  (reads .env.local)
 *
 * Restore path: the file is { table: rows[] } — re-insert with the service
 * role in FK order (see scripts/db-fresh-start.mjs WIPE_ORDER, reversed).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

// ── env: CI secrets first, .env.local for local runs ────────────────────────
function env(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync(new URL("../.env.local", import.meta.url), "utf8")
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${name}=`));
    if (line) return line.slice(name.length + 1).trim();
  } catch {
    /* no .env.local (CI) */
  }
  return null;
}

const URL_ = env("SUPABASE_URL") ?? env("NEXT_PUBLIC_SUPABASE_URL");
const KEY = env("SUPABASE_SERVICE_ROLE_KEY");
if (!URL_ || !KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` };
const PAGE = 1000;

// The business cannot lose these — a run that fails any of them is a FAILED
// backup, loudly. (Views/aux tables failing is logged but non-fatal.)
const CRITICAL = [
  "settings", "profiles", "shops", "customers", "suppliers",
  "parts", "engines", "engine_models", "stock_levels", "stock_movements",
  "sales", "sale_lines", "sale_line_costs", "losses", "utang_payments",
  "receivings", "receiving_lines", "supplier_payments",
  "deliveries", "delivery_lines", "returns", "return_lines",
  "warranties", "warranty_claims", "expenses", "discount_cards",
  "staff", "positions",
];

async function listRelations() {
  const res = await fetch(`${URL_}/rest/v1/`, { headers: HEADERS });
  if (!res.ok) throw new Error(`OpenAPI root: HTTP ${res.status}`);
  const spec = await res.json();
  return Object.keys(spec.paths ?? {})
    .filter((p) => p.startsWith("/") && p !== "/")
    .map((p) => p.slice(1))
    .filter((n) => !n.includes("rpc"));
}

async function dumpTable(name) {
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await fetch(
      `${URL_}/rest/v1/${name}?select=*&limit=${PAGE}&offset=${offset}`,
      { headers: HEADERS }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const started = new Date();
const relations = await listRelations();
console.log(`Backing up ${relations.length} relations from ${URL_}\n`);

const backup = {};
const failed = [];
for (const name of relations.sort()) {
  try {
    const rows = await dumpTable(name);
    backup[name] = rows;
    if (rows.length) console.log(`  ${name}: ${rows.length}`);
  } catch (e) {
    failed.push(name);
    console.error(`  ${name}: FAILED — ${e.message}`);
  }
}

const criticalFailed = CRITICAL.filter(
  (t) => failed.includes(t) || !(t in backup)
);
// settings must exist and hold the one business row — an empty dump of a
// known-populated table means the backup is NOT usable.
if (!criticalFailed.length && (backup.settings ?? []).length === 0) {
  criticalFailed.push("settings (empty)");
}

const stamp = started.toISOString().slice(0, 10);
mkdirSync(new URL("../backups/", import.meta.url), { recursive: true });
const out = new URL(`../backups/backup-${stamp}.json.gz`, import.meta.url);
writeFileSync(
  out,
  gzipSync(
    JSON.stringify({ taken_at: started.toISOString(), tables: backup }),
    { level: 9 }
  )
);

const totalRows = Object.values(backup).reduce((s, r) => s + r.length, 0);
console.log(
  `\n${totalRows} rows across ${Object.keys(backup).length} relations → ${out.pathname.split("/").pop()}`
);

if (criticalFailed.length) {
  console.error(`\nBACKUP UNUSABLE — critical tables failed: ${criticalFailed.join(", ")}`);
  process.exit(1);
}
console.log("Backup OK");
