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
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Keystroke sanitiser for a quantity box: digits plus one decimal, returned as
 *  a STRING so a half-typed "2." survives. Masks a second decimal as you type. */
export function sanitizeQtyInput(raw: string): string {
  const cleaned = raw.replace(/[^\d.]/g, "");
  const [whole, ...rest] = cleaned.split(".");
  return rest.length ? `${whole}.${rest.join("").slice(0, 1)}` : whole;
}

/** `parseInt`'s contract without the truncation — 0.5 stays 0.5, invalid → 0.
 *  Never rounds; `0.12` is refused downstream. Use `parseQty` for a yes/no. */
export function parseQtyInput(input: string | null | undefined): number {
  const n = Number(String(input ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Validity ANSWER for a typed quantity: one decimal max, null when refused.
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
  if (!/^\d+(\.\d)?$/.test(cleaned)) return null; // tenths only — 0.12 refused
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return allowZero ? 0 : null;
  if (!allowFractional && !Number.isInteger(n)) return null;
  return n;
}
