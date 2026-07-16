/**
 * Runs every verification suite and prints one table.
 *
 * Suites run SEQUENTIALLY: each provisions its own shop, but they share the one
 * live database, and a couple assert on global counts (e.g. "live expenses
 * untouched"). Running them in parallel would make those flap.
 *
 * Run: npm test
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Needs `npm run dev` on :3000 — skipped unless --with-http is passed. */
const NEEDS_HTTP = new Set([
  "test-reports.mjs",
  "test-settings-documents.mjs",
  "test-ia-redirects.mjs",
]);

const withHttp = process.argv.includes("--with-http");
const only = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

const suites = readdirSync(here)
  .filter((f) => f.startsWith("test-") && f.endsWith(".mjs") && f !== "test-all.mjs")
  .filter((f) => (only ? f.includes(only) : true))
  .sort((a, b) => {
    // harness first (everything depends on it), then the end-to-end story.
    const rank = (f) => (f === "test-harness.mjs" ? 0 : f === "test-e2e.mjs" ? 1 : 2);
    return rank(a) - rank(b) || a.localeCompare(b);
  });

function run(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const p = spawn(process.execPath, [join(here, file)], { encoding: "utf8" });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => {
      const m = out.match(/(\d+) passed, (\d+) failed/);
      resolve({
        file,
        code,
        passed: m ? +m[1] : 0,
        failed: m ? +m[2] : 0,
        ran: !!m,
        secs: ((Date.now() - started) / 1000).toFixed(1),
        out,
      });
    });
  });
}

const results = [];
for (const f of suites) {
  if (NEEDS_HTTP.has(f) && !withHttp) {
    console.log(`⊘ ${f} (needs a dev server — run with --with-http)`);
    continue;
  }
  process.stdout.write(`… ${f}`);
  const r = await run(f);
  results.push(r);
  const status = !r.ran ? "CRASHED" : r.failed ? `${r.failed} FAILED` : "ok";
  process.stdout.write(`\r${r.failed || !r.ran ? "✗" : "✓"} ${f.padEnd(32)} ${String(r.passed).padStart(3)} passed  ${status.padEnd(10)} ${r.secs}s\n`);
  if (!r.ran || r.failed) {
    // Show why, rather than making someone re-run it by hand.
    console.log(r.out.split("\n").filter((l) => l.includes("✗") || l.includes("Error")).slice(0, 12).map((l) => `    ${l.trim()}`).join("\n"));
  }
}

const totalPassed = results.reduce((s, r) => s + r.passed, 0);
const totalFailed = results.reduce((s, r) => s + r.failed, 0);
const crashed = results.filter((r) => !r.ran);

console.log(`\n${"─".repeat(64)}`);
console.log(`${results.length} suites · ${totalPassed} passed · ${totalFailed} failed${crashed.length ? ` · ${crashed.length} crashed` : ""}`);
if (crashed.length) console.log(`crashed: ${crashed.map((r) => r.file).join(", ")}`);
process.exit(totalFailed || crashed.length ? 1 : 0);
