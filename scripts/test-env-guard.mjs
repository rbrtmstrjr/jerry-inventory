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
  const { readFileSync, existsSync } = await import("node:fs");
  const mustGuard = [
    "db-fresh-start.mjs", "seed-load-test.mjs", "seed-states.mjs", "seed-append.mjs",
    "seed-sample-data.mjs", "seed-more-stock.mjs", "seed-notifications.mjs",
    "seed-shop-engines.mjs", "demo-provision.mjs", "demo-cleanup.mjs",
    "_harness.mjs", // covers every test-*.mjs suite in one place
  ];
  for (const f of mustGuard) {
    const p = `scripts/${f}`;
    if (!existsSync(p)) { check(`${f} present`, false, "file missing"); continue; }
    const src = readFileSync(p, "utf8");
    check(`${f} calls assertWritableEnv()`, /assertWritableEnv\s*\(/.test(src));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
