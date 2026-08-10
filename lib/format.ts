/**
 * Money is stored as integer centavos everywhere (₱12.50 → 1250).
 * Only format to pesos at the render edge — never do float math on money.
 */
const peso = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
});

export function formatCentavos(centavos: number): string {
  return peso.format(centavos / 100);
}

/** Parse a user-entered peso amount ("12.50", "₱1,250") into centavos. */
export function parsePesosToCentavos(input: string): number | null {
  const cleaned = input.replace(/[₱,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return parseInt(whole, 10) * 100 + parseInt(frac.padEnd(2, "0") || "0", 10);
}

/**
 * Quantities are numeric(12,1) since migration 0116 — goods sold by the kilo
 * need tenths (0.5 kg of nails).
 *
 *     12 → "12"      9.5 → "9.5"      0.1 → "0.1"
 *
 * WHY this exists, since PostgREST hands `numeric` back as a JSON number and a
 * bare {row.qty} already renders 12 as "12": it is the SUMS that need it. Once
 * quantities can be fractional, any `reduce((s, l) => s + l.qty, 0)` in the
 * browser is IEEE-754 arithmetic — 0.1 + 0.2 renders as
 * "0.30000000000000004" on a delivery note. Rounding to one decimal at the
 * render edge is the fix, and applying it to single values too means no future
 * reader has to work out which is which.
 *
 * Mirrors public.fmt_qty() in SQL (0123) — the two must agree, or a printed
 * document disagrees with the screen it was printed from.
 */
export function formatQty(qty: number | string | null | undefined): string {
  if (qty === null || qty === undefined || qty === "") return "";
  const n = typeof qty === "string" ? Number(qty) : qty;
  if (!Number.isFinite(n)) return "";
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/**
 * Parse a user-entered quantity, enforcing the rule Gerry asked for: ONE
 * decimal place. "0.12" is refused rather than silently rounded to 0.1 — a
 * quietly rounded weight is a wrong receipt nobody notices.
 *
 * `allowFractional` comes from the product's unit (units.allows_fractional):
 * nails are sold by the kilo, spark plugs are not sold in halves.
 *
 * Returns null when the input is not acceptable, so callers can refuse rather
 * than guess. Mirrors fn_assert_qty() server-side — this is the convenience,
 * that is the control.
 */
/**
 * `parseInt`'s contract for a quantity text input — a number, invalid → 0 —
 * except it does not TRUNCATE. This is the drop-in for the ~20 places that read
 * a quantity out of a text field with `parseInt(x || "0", 10)`; against a `0.5`
 * those returned 0 and the shop silently recorded nothing.
 *
 * It deliberately does NOT round: `0.12` comes back as 0.12 and is refused
 * downstream (by `qtySchema`, then by `fn_assert_qty`) with a message the
 * cashier can act on. Rounding it to 0.1 here would be the exact silent-wrong-
 * number failure the whole feature is built to avoid.
 *
 * Use `parseQty` instead where you want a validity ANSWER (null on bad input)
 * rather than a value to keep computing with.
 */
/**
 * Sanitize keystrokes in a quantity box: digits plus at most one decimal place.
 * Returns the STRING to put back, so a half-typed "2." survives while typing.
 *
 * Every quantity box gets this, not just the ones on weighed products — the
 * box does not know the unit, and `fn_assert_qty` does. Typing 2.5 into a
 * spark-plug line is refused by the database naming the product and its unit,
 * which is one authority for the rule instead of two that can drift apart.
 *
 * The second decimal is masked as you type rather than accepted and rejected:
 * you always see exactly what will be submitted.
 */
export function sanitizeQtyInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 1)}` : whole;
}

export function parseQtyInput(input: string | null | undefined): number {
  const n = Number(String(input ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function parseQty(
  input: string,
  { allowFractional = false, allowZero = false } = {}
): number | null {
  let cleaned = input.replace(/[,\s]/g, "");
  // NORMALISE a leading or trailing dot before validating. `sanitizeQtyInput`
  // deliberately preserves ".1" and "2." so a half-typed weight is not fought
  // mid-keystroke — so validating for canonical form only meant the COMMIT step
  // refused strings the INPUT step exists to allow. Record Sale's refusal branch
  // silently restored the previous quantity, so a cashier typing ".1" saw the
  // amount stay put and the sale deducted 1 kg. ".1" has exactly one meaning.
  if (cleaned.startsWith(".")) cleaned = `0${cleaned}`;
  if (cleaned.endsWith(".")) cleaned = cleaned.slice(0, -1);
  if (!/^\d+(\.\d)?$/.test(cleaned)) return null; // tenths only — 0.12 refused
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return allowZero ? 0 : null;
  if (!allowFractional && !Number.isInteger(n)) return null;
  return n;
}
