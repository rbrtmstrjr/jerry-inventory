/** Fast unit tests for pure lib math — no DB, no harness. Money parsing + PH date. */
import { formatCentavos, parsePesosToCentavos } from "../lib/format.ts";
import { ph_today } from "../lib/ph-date.ts";

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
};
const eq = (name, got, want) => check(`${name} → ${want}`, got === want, `got ${got}`);

console.log("parsePesosToCentavos — no float ever touches money:");
eq("'12.50'", parsePesosToCentavos("12.50"), 1250);
eq("'12.5' (pad)", parsePesosToCentavos("12.5"), 1250);
eq("'12'", parsePesosToCentavos("12"), 1200);
eq("'0'", parsePesosToCentavos("0"), 0);
eq("'0.01'", parsePesosToCentavos("0.01"), 1);
eq("'1,250.75' (comma)", parsePesosToCentavos("1,250.75"), 125075);
eq("'₱1,250' (symbol)", parsePesosToCentavos("₱1,250"), 125000);
eq("'12.5 ' (trailing space)", parsePesosToCentavos("12.5 "), 1250);
eq("'999999.99'", parsePesosToCentavos("999999.99"), 99999999);
// rejections — return null, never NaN or a rounded float
eq("'12.555' (>2dp) rejected", parsePesosToCentavos("12.555"), null);
eq("'-5' (negative) rejected", parsePesosToCentavos("-5"), null);
eq("'abc' rejected", parsePesosToCentavos("abc"), null);
eq("'' rejected", parsePesosToCentavos(""), null);
eq("'12.' (trailing dot) rejected", parsePesosToCentavos("12."), null);
eq("'.5' (no whole) rejected", parsePesosToCentavos(".5"), null);
eq("'1.2.3' rejected", parsePesosToCentavos("1.2.3"), null);
eq("'12e3' (no sci notation) rejected", parsePesosToCentavos("12e3"), null);

console.log("\nformatCentavos — renders at the edge:");
check("1250 → contains 12.50", formatCentavos(1250).includes("12.50"), formatCentavos(1250));
check("0 → contains 0.00", formatCentavos(0).includes("0.00"), formatCentavos(0));
check("−5000 → contains 50.00", formatCentavos(-5000).includes("50.00"), formatCentavos(-5000));
check("125075 → grouped 1,250.75", formatCentavos(125075).includes("1,250.75"), formatCentavos(125075));

console.log("\nround-trip: parse(format(x)) === x for representative amounts:");
for (const c of [0, 1, 99, 1250, 125075, 99999999, 2600000]) {
  const rt = parsePesosToCentavos(formatCentavos(c));
  check(`${c} survives format→parse`, rt === c, `got ${rt} from "${formatCentavos(c)}"`);
}

console.log("\nph_today — PH calendar day, not UTC:");
const t = ph_today();
check("format is YYYY-MM-DD", /^\d{4}-\d{2}-\d{2}$/.test(t), t);
check("is a real calendar date", !Number.isNaN(Date.parse(`${t}T00:00:00Z`)), t);
// PH is UTC+8, so the PH date is the UTC date or one day ahead — never behind, never >1 ahead.
const utc = new Date().toISOString().slice(0, 10);
const dayDiff = Math.round(
  (Date.parse(`${t}T00:00:00Z`) - Date.parse(`${utc}T00:00:00Z`)) / 86400000
);
check("PH date is UTC date or +1 (never behind)", dayDiff === 0 || dayDiff === 1, `diff ${dayDiff}`);
check("matches Intl Asia/Manila", t === new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date()), t);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
