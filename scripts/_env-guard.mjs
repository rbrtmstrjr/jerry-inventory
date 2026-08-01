/**
 * PRODUCTION GUARD for every script that writes to the database.
 *
 * These scripts authenticate with the SERVICE ROLE key, which bypasses RLS and
 * every owner-tier lock in the schema. Pointed at production they would seed
 * fake data into the client's books, or — in db-fresh-start's case — delete
 * every operational row. db-fresh-start's own "is there an owner?" check does
 * NOT save you: production HAS an owner, so that check passes and the wipe
 * proceeds.
 *
 * The gate is an ALLOWLIST, not a blocklist. `.env.local` must positively
 * declare a disposable environment:
 *
 *     SUPABASE_ENV=staging     # or: local
 *
 * A blocklist ("refuse if the URL is the prod ref") fails OPEN the day someone
 * forgets to add a new project to it. An allowlist fails CLOSED: unknown or
 * missing marker → refuse. The failure mode you want around irreversible work
 * is "stopped for no reason", never "wiped for no reason".
 *
 * Production credentials carry SUPABASE_ENV=production, so these scripts abort
 * with an explanation instead of running.
 */
import { readFileSync } from "node:fs";

/** Parse .env.local into a plain object (same shape every script already uses). */
export function readEnvFile(url = new URL("../.env.local", import.meta.url)) {
  return Object.fromEntries(
    readFileSync(url, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
  );
}

/** Environments whose data is disposable. Everything else is refused. */
const DISPOSABLE = new Set(["staging", "local"]);

/** Project ref out of https://<ref>.supabase.co — shown so you can eyeball it. */
function projectRef(env) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  return url.match(/https?:\/\/([a-z0-9-]+)\.supabase\./i)?.[1] ?? (url || "(no URL set)");
}

/**
 * The decision, as a PURE function — no I/O, no process.exit — so the guard
 * itself can be unit-tested. A safety mechanism nobody tests is not a safety
 * mechanism: this is exactly the code that must still be correct on the day
 * someone pastes production credentials into .env.local by accident.
 *
 * Returns { ok, name, ref, reason }.
 */
export function evaluateEnv(env, action = "This script") {
  const name = (env?.SUPABASE_ENV ?? "").trim().toLowerCase();
  const ref = projectRef(env ?? {});

  if (!name) {
    return {
      ok: false,
      name,
      ref,
      reason:
        `REFUSED: ${action} writes with the service-role key, and .env.local does not say\n` +
        `which environment this is (project: ${ref}).\n\n` +
        `Add ONE of these to .env.local:\n` +
        `  SUPABASE_ENV=staging      # disposable test project\n` +
        `  SUPABASE_ENV=local        # local supabase\n` +
        `  SUPABASE_ENV=production   # real client data — write scripts stay blocked`,
    };
  }

  if (!DISPOSABLE.has(name)) {
    return {
      ok: false,
      name,
      ref,
      reason:
        `REFUSED: ${action} must never run against SUPABASE_ENV=${name} (project: ${ref}).\n` +
        `Only ${[...DISPOSABLE].join(" / ")} may be seeded, wiped, or used for tests.\n` +
        `If you meant to work on staging, point .env.local at the staging project.`,
    };
  }

  return { ok: true, name, ref, reason: "" };
}

/**
 * Refuse to continue unless .env.local declares a disposable environment.
 * Exits 2 (the codebase's "refused to run" code) rather than throwing, so a
 * blocked script reads as a clean stop instead of a crash.
 */
export function assertWritableEnv(action = "This script", url) {
  let env;
  try {
    env = url ? readEnvFile(url) : readEnvFile();
  } catch {
    console.error(`REFUSED: ${action} could not read .env.local — cannot prove which database this is.`);
    process.exit(2);
  }

  const verdict = evaluateEnv(env, action);
  if (!verdict.ok) {
    console.error(verdict.reason);
    process.exit(2);
  }
  return verdict;
}
