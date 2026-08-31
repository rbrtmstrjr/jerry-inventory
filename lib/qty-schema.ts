import { z } from "zod";

/** Quantity SHAPE for server actions — never `.int()`, which rejects the
 *  hundredths 0116/task-2 exist for. The RULE (may this product split?) is fn_assert_qty's. */
export function qtySchema({ allowZero = false } = {}) {
  return z
    .number()
    .refine((n) => Number.isFinite(n), "Quantity must be a number")
    .refine(
      (n) => (allowZero ? n >= 0 : n > 0),
      allowZero ? "Quantity cannot be negative" : "Quantity must be more than zero"
    )
    // Hundredths only. The tolerance is not optional — 0.29 * 100 is
    // 28.999999999999996 in IEEE-754, so an exact check would reject 0.29.
    .refine(
      (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9,
      "Quantity can have at most two decimals — e.g. 0.25 or 2.5"
    );
}
