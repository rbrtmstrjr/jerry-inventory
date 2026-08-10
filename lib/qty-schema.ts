import { z } from "zod";

/** Quantity SHAPE for server actions — never `.int()`, which rejects the tenths
 *  0116 exists for. The RULE (may this product split?) is fn_assert_qty's. */
export function qtySchema({ allowZero = false } = {}) {
  return z
    .number()
    .refine((n) => Number.isFinite(n), "Quantity must be a number")
    .refine(
      (n) => (allowZero ? n >= 0 : n > 0),
      allowZero ? "Quantity cannot be negative" : "Quantity must be more than zero"
    )
    // Tenths only. The tolerance is not optional — 0.3 * 10 is 2.9999999999999996
    // in IEEE-754, so an exact check would reject what the database accepts.
    .refine(
      (n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9,
      "Quantity can have at most one decimal — e.g. 0.5 or 2.3"
    );
}
