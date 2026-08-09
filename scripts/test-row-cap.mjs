/**
 * STATIC tripwire: no unbounded select on a table that GROWS.
 *
 * PostgREST caps a response at the API's `db-max-rows` and TRUNCATES WITH NO
 * ERROR. On 2026-08-09 that took down stock visibility in production: Gloria
 * Trading crossed 1,032 products and the 32 that sorted last vanished from the
 * shop's stock screen, from Record Sale (unsellable), from the delivery picker
 * and from Stock Alerts. The rows were in `stock_levels` the whole time — every
 * query "worked", every page rendered, and the failure looked exactly like
 * missing data. It cost an afternoon to find because nothing anywhere errored.
 *
 * `lib/pnl.ts` already knew: its fetchAll comment records the same cap silently
 * computing the P&L from the first 1,000 of ~29,000 sales. The lesson was
 * learned for money and never swept across stock or catalog. This suite is that
 * sweep, made permanent — it is STATIC because no RPC-level test can see it:
 * the database is perfectly correct, and only the client's un-ranged request
 * is wrong.
 *
 * A site is fine if it pages (fetchAll / fetchAllOffset), bounds itself
 * (.limit / .range), or reads one row (.single / .maybeSingle / .eq("id")).
 * Anything else must carry a trailing `row-cap-ok` marker comment stating why
 * the set cannot grow past the cap — same explicit-exemption idiom as
 * test-fractional-qty's `whole-unit-qty`.
 *
 * Run: node scripts/test-row-cap.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Tables/views whose row count grows with the BUSINESS, not with configuration.
 * `shops`, `units`, `product_categories`, `engine_models` and `profiles` are
 * deliberately absent — those are bounded by how the store is set up (tens of
 * rows), and listing them would only train people to add exemptions.
 */
const GROWING = [
  "shop_stock",
  "shop_engines",
  "stock_levels",
  "parts",
  "engines",
  "sale_lines",
  "sales",
  "losses",
  "stock_movements",
  "movement_journal",
  "part_fitments",
  "warranties",
  "utang_payments",
  "expenses",
  "receiving_lines",
  "delivery_lines",
  "customers",
];

const GUARDS = [
  ".limit(",
  ".range(",
  ".single()",
  ".maybeSingle()",
  'count: "exact"',
  'count: "planned"',
  '.eq("id"',
  '.in("id"',
  "row-cap-ok",
  // Scoped to ONE parent DOCUMENT. A sale/loss/receiving/delivery has a
  // handful of lines and a handful of ledger rows, so these are bounded by the
  // shape of the data, not by luck.
  //
  // `shop_id` and `part_id` are deliberately NOT here: `.eq("shop_id", …)` on
  // stock_levels is EXACTLY the query that broke production at 1,032 rows. A
  // parent that owns lines bounds a read; a parent that owns a whole catalogue
  // does not.
  '.eq("sale_id"',
  '.eq("loss_id"',
  '.eq("receiving_id"',
  '.eq("delivery_id"',
  '.eq("engine_id"',
  '.eq("batch_id"',
  '.eq("snapshot_id"',
];

function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(p)) out.push(p);
  }
  return out;
}

let passed = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) passed++;
  else failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
}

const files = [...walk(join(root, "app")), ...walk(join(root, "lib"))];
console.log(`\nscanning ${files.length} files for unbounded reads\n`);

let sites = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const rel = relative(root, file).replace(/\\/g, "/");

  for (const table of GROWING) {
    const needle = `.from("${table}")`;
    let i = -1;
    while ((i = src.indexOf(needle, i + 1)) !== -1) {
      // The slice runs to the next .from( or 1800 chars — enough to cover the
      // whole chained call without spilling into the next query.
      const after = src.slice(i + needle.length);
      const nextFrom = after.indexOf(".from(");
      const slice = after.slice(0, nextFrom === -1 ? 1800 : Math.min(nextFrom, 1800));

      // Only SELECTs are row-capped; update/insert/delete/upsert are not reads.
      const ops = [".select(", ".update(", ".insert(", ".delete(", ".upsert("]
        .map((op) => ({ op, at: slice.indexOf(op) }))
        .filter((o) => o.at !== -1)
        .sort((a, b) => a.at - b.at);
      if (!ops.length || ops[0].op !== ".select(") continue;

      sites++;
      const before = src.slice(Math.max(0, i - 400), i);
      // (a) inline: fetchAll(() => supabase.from(...))
      let paged = /fetchAll(Offset)?\s*(<[^>]*>)?\s*\(/.test(before);

      // (b) the BUILDER pattern, which the window in (a) cannot see:
      //       const buildSales = () => supabase.from("sales")…   // ← here
      //       …40 lines…
      //       const rows = await fetchAll(buildSales)
      //     A factory is required (a query is consumed on await), so this is
      //     the normal shape for anything reused or conditionally filtered.
      //     Missing it flagged every paged report query in the codebase.
      if (!paged) {
        const decl = [...before.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:\([^)]*\)|\w+)\s*=>/g)].pop();
        if (decl) {
          const name = decl[1];
          paged = new RegExp(`fetchAll(?:Offset)?\\s*(?:<[^>]*>)?\\s*\\(\\s*${name}\\b`).test(src);
        }
      }

      const guarded = paged || GUARDS.some((g) => slice.includes(g));

      const line = src.slice(0, i).split("\n").length;
      check(
        `${rel}:${line} ${table}`,
        guarded,
        guarded ? "" : "unbounded select — page it with fetchAll, bound it, or mark row-cap-ok"
      );
    }
  }
}

console.log(`  ${sites} select sites on growing tables inspected`);

// The scan must actually be able to fail, or it certifies nothing.
const canary = `
  const x = supabase.from("shop_stock").select("*").order("name");
`;
const canaryOps = canary.indexOf(".select(") !== -1;
const canaryGuarded = GUARDS.some((g) => canary.includes(g));
check(
  "tripwire self-test: an unguarded select IS detected",
  canaryOps && !canaryGuarded,
  "the detector would not catch the production bug it exists for"
);

console.log("");
for (const f of failures) console.log(`  FAIL  ${f}`);
console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
