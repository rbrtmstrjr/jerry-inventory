import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

function section(title) {
  console.log(`\n${title}`);
}

function check(name, ok, detail) {
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function summary() {
  // Emit the exact "N passed, N failed" line the test-all runner greps for.
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

section("RLS InitPlan: 0108 restores wrapped auth-helper calls");

// Check 0108 exists
let sql = "";
try {
  sql = readFileSync("supabase/migrations/0108_restore_rls_initplan.sql", "utf8");
  check("0108 exists", true);
} catch (e) {
  check("0108 exists", false, "file not found");
}

// Check 0108 has ZERO bare auth-helper calls (all must be wrapped with select)
// Remove SQL comments first to avoid false positives in comment text
const sqlNoComments = sql.replace(/--.*$/gm, "");
const bare = [...sqlNoComments.matchAll(/(?<!select\s)public\.(is_owner|auth_shop_id)\s*\(\s*\)/g)];
check("0108: 0 bare auth-helper calls", bare.length === 0, bare.length > 0 ? `${bare.length} bare found` : "");

// Check all SIX policies are re-created in 0108
const policies = [
  "sales_update",
  "sale_lines_insert",
  "sale_lines_update",
  "sale_lines_delete",
  "losses_update",
  "customers_select"
];

for (const policy of policies) {
  const found = sql.includes(`create policy ${policy} on`);
  check(`0108: policy '${policy}' re-created`, found, !found ? "not found" : "");
}

section("getProfile is request-cached");
const auth = readFileSync("lib/auth.ts", "utf8");
check("lib/auth.ts imports react cache", /import\s*\{[^}]*\bcache\b[^}]*\}\s*from\s*"react"/.test(auth));
check("getProfile is wrapped in cache(", /getProfile\s*=\s*cache\(/.test(auth));

// ---------------------------------------------------------------------------
// Nav badges must use PER-INSTANCE realtime topics.
//
// supabase.channel(topic) returns the EXISTING channel when that topic is
// already taken, and adding a postgres_changes callback to an already
// subscribed channel throws. The nav renders TWICE on mobile — the desktop
// aside is `hidden md:flex` (hidden by CSS, still mounted) and the burger
// sheet mounts a second copy — so a hard-coded topic crashed the whole page
// to the error boundary the moment the sheet opened. Caught in mobile QA.
// ---------------------------------------------------------------------------
section("Nav badges use per-instance realtime topics (mobile sheet renders a 2nd copy)");
for (const file of [
  "components/shell/nav-badges.tsx",
  "components/shell/approvals-badge.tsx",
]) {
  const src = readFileSync(file, "utf8");
  const bare = [...src.matchAll(/\.channel\(\s*["'`]([^"'`$]*)["'`]\s*\)/g)].map((m) => m[1]);
  check(
    `${file}: no hard-coded channel topic`,
    bare.length === 0,
    bare.length ? `bare topic(s): ${bare.join(", ")}` : ""
  );
  check(
    `${file}: topic includes a per-instance id`,
    /\.channel\(`[^`]*\$\{instanceId\}[^`]*`\)/.test(src)
  );
}

summary();
