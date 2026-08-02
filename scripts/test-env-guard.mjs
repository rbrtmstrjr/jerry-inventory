/**
 * The production guard (scripts/_env-guard.mjs).
 *
 * This suite exists because the guard is the ONLY thing standing between a
 * mis-pointed .env.local and the client's live books: every seed/wipe script
 * and the whole test harness authenticate with the service-role key, which
 * bypasses RLS and every owner-tier lock. db-fresh-start's own "is there an
 * owner?" check does NOT protect production — production HAS an owner, so it
 * passes and the wipe proceeds.
 *
 * The rule under test: ALLOWLIST, fail closed. Only staging/local may be
 * written. Anything else — production, a typo, a missing marker — is refused.
 *
 * Pure + offline: evaluateEnv() takes a parsed env object, so this runs
 * without touching any database.
 */
import { evaluateEnv } from "./_env-guard.mjs";

let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  ok ? pass++ : fail++;
}
function section(t) { console.log(`\n${t}`); }

const URL_OK = { NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklm.supabase.co" };

section("Disposable environments are allowed");
for (const name of ["staging", "local", "STAGING", " Staging "]) {
  const v = evaluateEnv({ ...URL_OK, SUPABASE_ENV: name });
  check(`SUPABASE_ENV=${JSON.stringify(name)} allowed (case/space tolerant)`, v.ok, v.reason);
}

section("Production is refused");
{
  const v = evaluateEnv({ ...URL_OK, SUPABASE_ENV: "production" }, "db-fresh-start");
  check("SUPABASE_ENV=production refused", !v.ok);
  check("refusal names the action", v.reason.includes("db-fresh-start"), v.reason);
  check("refusal shows the project ref", v.reason.includes("abcdefghijklm"), v.reason);
}
for (const name of ["prod", "live", "PRODUCTION"]) {
  const v = evaluateEnv({ ...URL_OK, SUPABASE_ENV: name });
  check(`SUPABASE_ENV=${name} refused (not on the allowlist)`, !v.ok);
}

section("Fails CLOSED on anything unrecognised");
{
  // The real-world case: someone pastes prod credentials into a fresh
  // .env.local and never adds the marker. A blocklist would let this through.
  const v = evaluateEnv({ ...URL_OK });
  check("missing SUPABASE_ENV refused", !v.ok);
  check("message tells you how to fix it", v.reason.includes("SUPABASE_ENV=staging"), v.reason);

  check("empty string refused", !evaluateEnv({ ...URL_OK, SUPABASE_ENV: "" }).ok);
  check("typo ('stagng') refused", !evaluateEnv({ ...URL_OK, SUPABASE_ENV: "stagng" }).ok);
  check("empty env object refused", !evaluateEnv({}).ok);
  check("undefined env refused", !evaluateEnv(undefined).ok);
}

section("Every write script actually calls the guard");
{
  // DISCOVERED, never listed. The previous version checked a hardcoded array
  // and assumed "_harness.mjs covers every test-*.mjs suite" — but 12 scripts
  // read .env.local and build their own service-role client without importing
  // the harness, so they were unguarded while this test reported green. A
  // hardcoded list fails OPEN the day someone adds a script, which is exactly
  // the failure mode the guard itself exists to avoid.
  const { readFileSync, readdirSync } = await import("node:fs");

  // Read-only scripts. backup-db MUST be able to read production — it is the
  // nightly off-site backup, and the free tier has no automated backups.
  const READ_ONLY = new Set(["backup-db.mjs", "_pnl_capture.mjs", "_env-guard.mjs"]);
  const WRITES = /\.(insert|update|upsert|delete)\s*\(|\.rpc\s*\(/;

  const files = readdirSync("scripts").filter((f) => f.endsWith(".mjs"));
  let audited = 0;
  for (const f of files) {
    if (READ_ONLY.has(f) || f === "test-env-guard.mjs") continue;
    const src = readFileSync(`scripts/${f}`, "utf8");
    if (!/SERVICE_ROLE/.test(src) || !WRITES.test(src)) continue; // not a write script
    audited++;
    // guarded directly, or transitively by importing the harness (which guards)
    const guarded =
      /assertWritableEnv\s*\(/.test(src) || /from\s+["']\.\/_harness\.mjs["']/.test(src);
    check(`${f} is guarded`, guarded, "writes with the service role but never calls assertWritableEnv()");
  }
  check("write scripts were actually discovered", audited >= 20, `only ${audited} found`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
