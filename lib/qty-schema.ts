import { z } from "zod";

/**
 * A quantity as the SERVER ACTIONS accept it (0114–0124).
 *
 * Quantity became `numeric(12,1)` in 0116, so `z.number().int()` is now wrong
 * everywhere it guards one: it rejects the 0.5 kg of nails this whole feature
 * exists for, and it does so in the server action — the database is never even
 * asked. That is why the bug survived a green test suite: the suites call the
 * RPCs directly, so they proved the DATABASE takes tenths while every path a
 * real cashier uses still refused them.
 *
 * The layering is deliberate:
 *
 *   here (Zod)      — the SHAPE. A finite number, sign, and at most one decimal.
 *   fn_assert_qty   — the RULE. Whether THIS product may be split at all, which
 *                     depends on its unit and is not knowable in the browser.
 *
 * So this does NOT check `allows_fractional`. A `pc` product sent 2.5 passes
 * here and is refused by the database with a message naming the product and its
 * unit. One authority for the business rule, not two that can drift.
 *
 * Reorder levels are NOT quantities in this sense — they stay `z.number().int()`
 * (a threshold, not a measurement). Money stays `int` centavos.
 */
export function qtySchema({ allowZero = false } = {}) {
  return z
    .number()
    .refine((n) => Number.isFinite(n), "Quantity must be a number")
    .refine(
      (n) => (allowZero ? n >= 0 : n > 0),
      allowZero ? "Quantity cannot be negative" : "Quantity must be more than zero"
    )
    // Tenths only. The tolerance is not optional: 0.3 * 10 is 2.9999999999999996
    // in IEEE-754, so an exact `Math.round(n * 10) === n * 10` would reject a
    // quantity the database accepts — a mismatch far worse than the bug itself.
    .refine(
      (n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9,
      "Quantity can have at most one decimal — e.g. 0.5 or 2.3"
    );
}
