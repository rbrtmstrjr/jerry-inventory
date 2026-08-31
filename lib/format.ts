/** Money is integer centavos everywhere (₱12.50 → 1250). Format to pesos only
 *  at the render edge — never do float math on money. */
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

/** Render a quantity (12 → "12", 9.5 → "9.5"). Exists for the SUMS — a browser
 *  reduce is IEEE-754. Mirrors public.fmt_qty(); the two must agree. */
export function formatQty(qty: number | string | null | undefined): string {
  if (qty === null || qty === undefined || qty === "") return "";
  const n = typeof qty === "string" ? Number(qty) : qty;
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  // Two decimals, trailing zeros trimmed, so 0.5 never renders "0.50" beside a
  // "0.5" elsewhere. toFixed also absorbs the float artifact this exists for.
  const trimmed = n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  // A non-integer input must never collapse to a bare integer string — that
  // reads as an exact zero. Below 0.005, toFixed(2) rounds to "0.00"/"x.00".
  return /\./.test(trimmed) ? trimmed : `${trimmed}.0`;
}

/** Keystroke sanitiser for a quantity box: digits plus two decimals, returned as
 *  a STRING so a half-typed "2." survives. Masks a third decimal as you type. */
export function sanitizeQtyInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
}

/** `parseInt`'s contract without the truncation — 0.5 stays 0.5, invalid → 0.
 *  Never rounds; `0.255` is refused downstream. Use `parseQty` for a yes/no. */
export function parseQtyInput(input: string | null | undefined): number {
  const n = Number(String(input ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Validity ANSWER for a typed quantity: two decimals max, null when refused.
 *  Mirrors fn_assert_qty — this is the convenience, that is the control. */
export function parseQty(
  input: string,
  { allowFractional = false, allowZero = false } = {}
): number | null {
  let cleaned = input.replace(/[,\s]/g, "");
  // Normalise the dot forms sanitizeQtyInput deliberately allows, or the commit
  // step refuses strings the input step exists to permit (".1" deducted 1 kg).
  if (cleaned.startsWith(".")) cleaned = `0${cleaned}`;
  if (cleaned.endsWith(".")) cleaned = cleaned.slice(0, -1);
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null; // hundredths — 0.255 refused
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return allowZero ? 0 : null;
  if (!allowFractional && !Number.isInteger(n)) return null;
  return n;
}

/** Grams are the unit for products weighed off a scale (0133). The business
 *  thinks in pesos per KILO, so the forms take that and convert here. */
export const GRAMS_PER_KILO = 1000;

/**
 * "₱100 per kilo" → 10 centavos per gram.
 *
 * `price_centavos` is an integer, so a per-gram price only exists when the
 * per-kilo figure lands on a ₱10 grid. Returns null otherwise — NEVER a
 * rounded value: ₱145/kg quietly becoming ₱140 is the same silent-wrong-number
 * failure that cost a stock discrepancy on 2026-08-10.
 */
export function perKiloToCentavosPerGram(pesosPerKilo: string): number | null {
  const perKilo = parsePesosToCentavos(pesosPerKilo);
  if (perKilo === null) return null;
  if (perKilo % GRAMS_PER_KILO !== 0) return null;
  return perKilo / GRAMS_PER_KILO;
}

/** 10 centavos per gram → 10,000 centavos (₱100.00) per kilo. */
export function centavosPerGramToPerKilo(centavosPerGram: number): number {
  return centavosPerGram * GRAMS_PER_KILO;
}

/** The two nearest usable per-kilo prices, in centavos, for the refusal hint. */
export function nearestGramGrid(perKiloCentavos: number): { low: number; high: number } {
  const low = Math.floor(perKiloCentavos / GRAMS_PER_KILO) * GRAMS_PER_KILO;
  return { low, high: low + GRAMS_PER_KILO };
}
