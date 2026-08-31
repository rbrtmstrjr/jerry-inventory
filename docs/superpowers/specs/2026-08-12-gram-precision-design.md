# Gram precision for weighed goods — design

Status: **SUPERSEDED by 0133 (grams as a whole-number unit).** Kept for the
reasoning: this records what widening to numeric(12,3) would have cost, and why
a new unit was the cheaper answer. Do NOT implement this.
Partly revived by 0134 (kg to two decimals, 2026-08-31): the column work
described here is real, but the accumulator sweep it feared is not needed.
See 2026-08-31-kg-two-decimals-design.md.
Migration: never allocated — 0133 went to the gram unit instead.
Depends on: 0114–0131 (the fractional-quantity feature)

## Problem

A customer buys by peso amount: "₱100 of concrete nails". The shop's digital
scale converts the amount to a weight using the selling price, the employee
weighs that out, and then types the weight into Record Sale.

Quantity is `numeric(12,1)` — tenths only. **A tenth of a kilo is 100 grams**,
so a 689.7 g weigh-out must be entered as `0.7 kg`:

| Nails at ₱145/kg | |
|---|---|
| Customer pays | ₱100.00 |
| Scale shows | 689.7 g |
| Cashier must enter | 0.7 kg |
| System charges | 0.7 × 145 = ₱101.50 |
| Error | ₱1.50, plus 10 g of stock deducted that never left |

Worst case is half a tenth: 50 g, or **₱7.25 on a ₱100 sale** — about 7%.

Tenths were a deliberate decision (Gerry, 2026-08-10) because widening means
altering every quantity column. The business has since outgrown it.

## Decision

**Quantity becomes `numeric(12,3)` — thousandths.** For a kilo that is one
gram, which is what a retail scale reads.

| | |
|---|---|
| What the cashier types | **kilograms, up to 3 decimals** — `0.198` |
| The anchor | **the weight.** Money stays derived: `round(unit_price × qty)` |
| Unit vocabulary | **untouched.** No `decimal_places` column, no per-unit precision |
| `allows_fractional` | **untouched.** `pc`, `set`, `box`, `pair`, `roll` stay whole numbers |

Explicitly rejected during design, and not to be revisited without a new
decision: a gram-denominated input box, per-unit precision as data, and
repricing weighed goods per 100 g.

## Known consequence

Because precision is uniform rather than per-unit, `m` and `ft` also gain
thousandths — `0.001 m` (one millimetre of pipe) becomes an accepted entry. It
is meaningless but harmless: it cannot break the ledger, and nothing rounds.
Accepted deliberately in exchange for not building per-unit machinery.

## What changes

### 1. Storage — the migration this would have needed

Fifteen columns from `numeric(12,1)` to `numeric(12,3)`:

```
count_snapshot_lines.expected_qty      delivery_lines.qty
count_snapshot_lines.counted_qty       delivery_lines.qty_damaged
delivery_discrepancies.qty             delivery_lines.qty_received
delivery_request_lines.qty_requested   delivery_lines.qty_resolved
losses.qty                             receiving_lines.qty
return_lines.qty                       return_lines.qty_damaged
sale_lines.qty                         stock_levels.qty
stock_movements.qty_change
```

Nine CHECK constraints move from `round(x, 1)` to `round(x, 3)`:

```
stock_levels_qty_tenths          delivery_lines_qty_tenths
sale_lines_qty_tenths            return_lines_qty_tenths
receiving_lines_qty_tenths       losses_qty_tenths
stock_movements_qty_tenths       delivery_discrepancies_qty_tenths
delivery_request_lines_qty_tenths
```

They keep their `_tenths` names — renaming them is churn with no benefit, and
the name is already wrong in the other direction if precision ever changes
again. The migration's header says so, so a future reader is not misled.

`delivery_lines.qty_outstanding` is a GENERATED column over `qty`; Postgres
refuses to alter a column a generated column depends on, so it is dropped and
recreated, exactly as 0116 did.

### 2. The three validation layers

The layering from 0114–0124 is preserved — only the depth changes.

| Layer | Now | After |
|---|---|---|
| `sanitizeQtyInput` (lib/format.ts) | keeps 1 decimal while typing | keeps 3 |
| `parseQty` (lib/format.ts) | `/^\d+(\.\d)?$/` | `/^\d+(\.\d{1,3})?$/` |
| `qtySchema` (lib/qty-schema.ts) | `n*10` within 1e-9 | `n*1000` within 1e-9 |
| `fn_assert_qty` (SQL) | raises unless `= round(p_qty,1)` | `round(p_qty,3)` |

`fn_assert_qty` remains the sole authority on whether a given product may hold
a fraction at all — that rule reads `units.allows_fractional` and is not
touched. Its refusal message changes from "one decimal only" to "three".

### 3. Rendering

`formatQty` (lib/format.ts) and `public.fmt_qty()` (SQL) both render up to 3
decimals, trailing zeros trimmed: `12` stays `12`, `0.5` stays `0.5`, `0.198`
renders `0.198`. **The two must agree** — 0123 exists because a printed
document that disagrees with the screen it was printed from is a support call.

## Why this is safe

- **Widening is lossless.** Every stored value is currently at tenths; 0.7
  becomes 0.700. No row can be damaged, and the change is reversible only
  until a 3-decimal value is written.
- **0116 is a proven recipe.** It performed this exact operation once. Its
  view-snapshot / restore loop, its grant and revoke restoration, and 0122's
  lesson about `security_barrier` reloptions all apply unchanged.
- **Money is unaffected.** It is already `round(unit_price × qty)` per line and
  stored, never re-derived. A finer qty just makes the product more accurate.
- **The ledger invariant is unaffected.** `Σ movements = stock_levels` is an
  equality over the same numeric type on both sides.

## Risks

- **It would not be re-runnable**, for the same reason 0116 is not: its
  `add constraint` has no `if not exists`. Run it exactly once per database.
- **Dropping a view discards grants, revokes AND reloptions.** 0122 exists
  because `anon` was silently re-granted on recreated views. The migration must
  restore all three and verify before committing.
- **PL/pgSQL rounds silently on assignment.** 0117–0121 and 0124 were an
  accumulator sweep after 0116 for exactly this. Any local variable still typed
  `numeric(12,1)` — or any `RETURNS TABLE` column, which is what 0121 had to
  fix — will silently round a 3-decimal quantity. The migration must sweep for
  these, matching `bigint` and `RETURNS TABLE` columns too, not just `int`.

## Testing

`scripts/test-fractional-qty.mjs` is extended rather than replaced:

- `0.198` accepted end-to-end through receive → deliver → confirm → sell → write off
- `0.1985` REFUSED, and provably changes nothing
- a `pc` product still refuses `2.5` — `allows_fractional` is untouched
- the ledger invariant holds exactly at a 3-decimal quantity
- money rounds once per line: `0.198 × ₱145.00 = ₱28.71`
- `formatQty` and `fmt_qty` agree on `0.198`, `0.5`, `12`
- reorder levels stay whole numbers
- engines stay pinned at 1

Its existing STATIC section (no `.int()` on a quantity, no `parseInt`) still
applies unchanged.

Browser QA: a sale of `0.198 kg` recorded at the counter, asserted against the
database — the stored `sale_lines.qty` and the resulting `stock_levels.qty`
must both read 0.198, not 0.2.

## Rollout

Branch off `staging` → apply the migration to staging → `npm test` + browser QA →
manual QA → merge to staging → production, applying it to production as a
separate, explicit step.
