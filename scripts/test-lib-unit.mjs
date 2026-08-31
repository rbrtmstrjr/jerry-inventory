/** Fast unit tests for pure lib math — no DB, no harness. Money parsing + PH date. */
import {
  formatCentavos, formatQty, parseQty, parseQtyInput, sanitizeQtyInput, parsePesosToCentavos,
} from "../lib/format.ts";
import { qtySchema } from "../lib/qty-schema.ts";
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

// ── quantities: tenths only, and the unit decides (0114–0124) ───────────────
console.log("\nparseQty — the client-side gate that stops 0.255 before the server:");
// whole numbers, always allowed
eq("'1'", parseQty("1"), 1);
eq("'12'", parseQty("12"), 12);
eq("'1,250' (comma)", parseQty("1,250"), 1250);
// tenths — only for a product whose unit allows it
eq("'0.1' fractional", parseQty("0.1", { allowFractional: true }), 0.1);
eq("'2.3' fractional", parseQty("2.3", { allowFractional: true }), 2.3);
eq("'10.2' fractional", parseQty("10.2", { allowFractional: true }), 10.2);
eq("'2.0' fractional", parseQty("2.0", { allowFractional: true }), 2);
// THE rule Gerry asked for: two decimals, never three. A silent round here
// would be a wrong receipt nobody notices, so it must return null, not 0.25.
eq("'0.25' accepted (the quarter kilo)", parseQty("0.25", { allowFractional: true }), 0.25);
eq("'0.05' accepted (10 g granularity)", parseQty("0.05", { allowFractional: true }), 0.05);
eq("'1.25' accepted", parseQty("1.25", { allowFractional: true }), 1.25);
eq("'0.255' rejected (3dp)", parseQty("0.255", { allowFractional: true }), null);
eq("'1.005' rejected (3dp)", parseQty("1.005", { allowFractional: true }), null);
// a whole-unit product refuses tenths even when the string is well-formed
eq("'2.5' rejected when not fractional", parseQty("2.5"), null);
eq("'0.1' rejected when not fractional", parseQty("0.1"), null);
// zero and below are not quantities unless the caller opts in (delivery confirm)
eq("'0' rejected by default", parseQty("0"), null);
eq("'0' allowed with allowZero", parseQty("0", { allowZero: true }), 0);
eq("'-1' rejected", parseQty("-1"), null);
eq("'-0.5' rejected", parseQty("-0.5", { allowFractional: true }), null);
// malformed input never becomes a number
eq("'' rejected", parseQty(""), null);
eq("'abc' rejected", parseQty("abc"), null);
eq("'1e3' rejected (no sci notation)", parseQty("1e3"), null);

// A LEADING or TRAILING dot is NORMALISED, not refused. These two used to
// assert null, deliberately — and that decision caused a production stock
// discrepancy. `sanitizeQtyInput` preserves ".1" and "2." so a half-typed value
// is not fought mid-keystroke, so the commit step was refusing strings the
// input step exists to allow. Record Sale's refusal branch then restored the
// PREVIOUS quantity silently: the cashier typed .1, the amount did not move,
// and the sale deducted 1 kg. ".1" has exactly one meaning — read it.
eq("'.1' normalised", parseQty(".1", { allowFractional: true }), 0.1);
eq("'.5' normalised", parseQty(".5", { allowFractional: true }), 0.5);
eq("'1.' normalised", parseQty("1.", { allowFractional: true }), 1);
eq("'2.' normalised", parseQty("2.", { allowFractional: true }), 2);
eq("'.5' still rejected when not fractional", parseQty(".5"), null);
// normalising must not loosen the tenths rule or the zero rule
eq("'.25' normalised", parseQty(".25", { allowFractional: true }), 0.25);
eq("'.255' still rejected (3dp)", parseQty(".255", { allowFractional: true }), null);
eq("'.' rejected (no digits at all)", parseQty(".", { allowFractional: true }), null);
eq("'.0' rejected (zero)", parseQty(".0", { allowFractional: true }), null);
eq("'.0' allowed with allowZero", parseQty(".0", { allowFractional: true, allowZero: true }), 0);

console.log("\nformatQty — mirrors public.fmt_qty() in SQL (0123):");
eq("12 → whole", formatQty(12), "12");
eq("0", formatQty(0), "0");
eq("9.5", formatQty(9.5), "9.5");
eq("0.1", formatQty(0.1), "0.1");
eq("0.25", formatQty(0.25), "0.25");
eq("0.05", formatQty(0.05), "0.05");
// trailing zeros are trimmed — 0.50 must not read "0.50" beside a "0.5" elsewhere
eq("0.5 not '0.50'", formatQty(0.5), "0.5");
eq("1.2 not '1.20'", formatQty(1.2), "1.2");
// the reason it exists: a JS sum of tenths is not exact
eq("0.1 + 0.2 (float artifact)", formatQty(0.1 + 0.2), "0.3");
eq("2.3 * 3 (float artifact)", formatQty(2.3 * 3), "6.9");
eq("null → ''", formatQty(null), "");
eq("undefined → ''", formatQty(undefined), "");
// below hundredths (invalid input), toFixed(2) rounds to "0.00" — must not
// collapse to a bare "0", indistinguishable from an exact zero
eq("0.001 → '0.0' (never a bare integer)", formatQty(0.001), "0.0");
// PostgREST hands numeric back as a number, but a string must not break it
eq("'10.5' string", formatQty("10.5"), "10.5");
eq("'12' string", formatQty("12"), "12");

// round-trip: anything parseQty accepts, formatQty renders back unchanged
for (const s of ["1", "12", "0.1", "2.3", "10.2"]) {
  const n = parseQty(s, { allowFractional: true });
  check(`round-trips '${s}'`, formatQty(n) === String(Number(s)), `got ${formatQty(n)}`);
}

// ── the two layers in front of the database ────────────────────────────────
// These exist because the DB suites passed while the counter still refused
// "0.5": they call the RPCs directly and never touch a form or an action.
console.log("\nparseQtyInput — parseInt's contract WITHOUT the truncation:");
eq("'0.5' (parseInt gave 0)", parseQtyInput("0.5"), 0.5);
eq("'2.3'", parseQtyInput("2.3"), 2.3);
eq("'10.2'", parseQtyInput("10.2"), 10.2);
eq("'12'", parseQtyInput("12"), 12);
eq("'1,250' (comma)", parseQtyInput("1,250"), 1250);
eq("'' → 0", parseQtyInput(""), 0);
eq("null → 0", parseQtyInput(null), 0);
eq("'abc' → 0", parseQtyInput("abc"), 0);
// It must NOT round: 0.255 has to reach the server to be refused by name.
eq("'0.12' passes through unrounded", parseQtyInput("0.12"), 0.12);

console.log("\nsanitizeQtyInput — what a quantity box accepts as you type:");
eq("'2.5'", sanitizeQtyInput("2.5"), "2.5");
eq("'2.' (mid-typing survives)", sanitizeQtyInput("2."), "2.");
eq("'0.1'", sanitizeQtyInput("0.1"), "0.1");
eq("'abc12' strips letters", sanitizeQtyInput("abc12"), "12");
eq("'0.25' keeps two decimals", sanitizeQtyInput("0.25"), "0.25");
eq("'0.255' masks the 3rd decimal", sanitizeQtyInput("0.255"), "0.25");
eq("'1.2.3' keeps one dot", sanitizeQtyInput("1.2.3"), "1.23");
eq("'' stays empty", sanitizeQtyInput(""), "");

console.log("\nqtySchema — the server action's gate:");
const okQ = (v, opts) => qtySchema(opts).safeParse(v).success;
check("0.5 accepted (the reported bug)", okQ(0.5) === true);
check("2.3 accepted", okQ(2.3) === true);
check("12 accepted", okQ(12) === true);
// 0.3 is 2.9999999999999996 when multiplied by 10 — an exact tenths check
// would reject a quantity the database accepts.
check("0.3 accepted despite the IEEE-754 artifact", okQ(0.3) === true);
check("0.7 accepted despite the IEEE-754 artifact", okQ(0.7) === true);
check("0.25 accepted (the quarter kilo)", okQ(0.25) === true);
check("0.05 accepted", okQ(0.05) === true);
// 0.29 * 100 is 28.999999999999996 — an exact check would reject what the
// database accepts, so the tolerance is not optional.
check("0.29 accepted despite the IEEE-754 artifact", okQ(0.29) === true);
check("0.255 rejected", okQ(0.255) === false);
check("1.005 rejected", okQ(1.005) === false);
check("0 rejected by default", okQ(0) === false);
check("0 accepted with allowZero", okQ(0, { allowZero: true }) === true);
check("-1 rejected", okQ(-1) === false);
check("-0.5 rejected with allowZero", okQ(-0.5, { allowZero: true }) === false);
check("NaN rejected", okQ(NaN) === false);
check("Infinity rejected", okQ(Infinity) === false);
// .nullable()/.default() must still compose — several call sites rely on it.
check("composes with .nullable()", qtySchema().nullable().safeParse(null).success === true);
check("composes with .default()", qtySchema({ allowZero: true }).default(0).safeParse(undefined).success === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
