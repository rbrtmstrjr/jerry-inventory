/**
 * STATIC guard: every SECURITY DEFINER function granted to `authenticated`
 * must re-check its caller in-body.
 *
 * This is the 0042 lesson made permanent. A definer function bypasses RLS, so a
 * function that is callable by `authenticated` but does not check the caller is
 * exactly the hole RLS exists to close. Migration 0042 fixed two such holes;
 * the audit (Phase 1) found three more that shipped AFTER 0042
 * (fn_supplier_outstanding, fn_receiving_balance, fn_sale_balance, fixed in
 * 0047). This test would have caught all five — and fails the build the moment
 * a new migration reopens the hole.
 *
 * Pure static analysis over the migration SQL — no database, no fixtures. It
 * reads the LATEST definition of each function (functions get redefined across
 * migrations) and looks for a guard token in the body.
 *
 * Run: node scripts/test-definer-guards.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const MIG_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");
const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++;
  else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};

// Concatenate all migrations in order; later defs override earlier ones.
const all = files.map((f) => readFileSync(join(MIG_DIR, f), "utf8")).join("\n");

// A guard = any of these appearing in the function body. `fn_can_edit_product_image`
// is a known guard HELPER (it checks auth_shop_id internally), so calling it counts.
const GUARD = /\bis_owner\(\)|auth_shop_id\(\)|auth\.uid\(\)|\brole\s*=\s*'(employee|owner)'|\brole\s+in\b|service_role|fn_can_edit_product_image/;

/**
 * Documented exceptions — functions that are authenticated-callable, have no
 * literal guard token, and are provably safe. Each MUST carry a reason; an
 * undocumented unguarded function is a failure.
 */
const ALLOWED = {
  fn_warranty_alert_days:
    "returns only settings.warranty_expiry_alert_days (an int); no cost, no cross-shop data; the shop warranty view needs it",
  fn_apply_entry_contributions:
    "transitively guarded — reached only via fn_create_pay_period / fn_save_payroll_days (owner-only) and calls fn_contribution_basis, which raises for a non-owner (0042). Verified: a shop call returns 'Only the owner can read payroll settings'",
};

// Every fn granted to authenticated.
const granted = new Set(
  [...all.matchAll(/grant execute on function public\.(fn_[a-z_]+)\([^)]*\)\s+to\s+authenticated/g)]
    .map((m) => m[1])
);

// Extract the LATEST body of each function: last `create or replace function
// public.<fn>(...) ... $$;` block wins.
function latestBody(fn) {
  const re = new RegExp(
    `create or replace function public\\.${fn}\\([\\s\\S]*?\\$\\$;`, "g"
  );
  const blocks = [...all.matchAll(re)].map((m) => m[0]);
  return blocks.length ? blocks[blocks.length - 1] : null;
}

console.log("Definer functions granted to `authenticated` must guard their caller:\n");

let unguardedUndocumented = 0;
for (const fn of [...granted].sort()) {
  const body = latestBody(fn);
  if (!body) { check(`${fn} — definition found`, false, "no create-or-replace block matched"); continue; }
  const hasGuard = GUARD.test(body);
  if (hasGuard) { pass++; continue; } // guarded — silent pass to keep output focused
  // No guard token — must be a documented, justified exception.
  if (ALLOWED[fn]) {
    check(`${fn}: no literal guard, but ALLOWED (${ALLOWED[fn].slice(0, 48)}…)`, true);
  } else {
    check(`${fn}: UNGUARDED and not documented — a definer function callable by ` +
      `authenticated with no caller check is the 0042 hole`, false, "add a guard or document why it's safe");
    unguardedUndocumented++;
  }
}

console.log(`\n  ${granted.size} authenticated-granted definer functions checked; ` +
  `${Object.keys(ALLOWED).length} documented exceptions; ${unguardedUndocumented} undocumented holes.`);

// Also assert the three audit-fixed functions now carry the guard (0047).
console.log("\nAudit fixes (0047) — the three cost/balance functions now guard:");
for (const fn of ["fn_supplier_outstanding", "fn_receiving_balance", "fn_sale_balance"]) {
  const body = latestBody(fn) ?? "";
  check(`${fn} guards owner-or-cron`, /is_owner\(\)\s+or\s+auth\.uid\(\)\s+is\s+null/.test(body),
    "0047 not present in migrations");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
