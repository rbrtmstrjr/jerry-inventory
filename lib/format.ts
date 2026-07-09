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
