# 0134 — kilograms to two decimals

**Status:** approved, not yet built
**Branch:** `feat/kg-two-decimals` (from `main`)
**Supersedes:** `2026-08-12-gram-precision-design.md` (three decimals, never built)

---

## The problem

A customer buys a quarter kilo. Quantity is `numeric(12,1)`, so `0.25` is
refused — the cashier must ring up `0.2` or `0.3`, and either is wrong by 50 g.

This is not the same problem `g` (0133) solved. Grams answer *"₱100 of concrete
nails"* — the customer names a peso amount, the scale names the weight, and a
fresh gram-unit product records it as a whole number. Quarter kilos are the
opposite: the customer names the **weight**, the product is an existing kg
product with kg history, and `stock_levels` already reads in kilos.

Converting those products to `g` is not available. Flipping an existing
product's unit would leave `stock_levels` reading `44` where `44000` belongs,
and `stock_movements` is append-only — that history cannot be restated without
breaking `Σ movements = stock_levels`. Grams stay for products created fresh.

So kg has to hold two decimals.

## Decision

**Two decimals, not three.** `0.25`, `0.5`, `0.75`, `1.25` and `0.05` all
become expressible — 10 g granularity, which covers every fraction a customer
actually asks for. `0.255`, `0.125` and `0.333` stay refused.

The migration cost is identical for two or three decimals (the same 15 columns,
the same 9 CHECKs), so the choice was purely about which values are valid.
Three decimals would let a cashier record a gram of lead as a kg quantity,
which is exactly the false precision `g` exists to avoid.

## What changes

### Database — `0134_two_decimal_qty.sql`

Structurally a re-run of **0116** with `1` → `2`, and it must be written by
copying 0116, not from memory. Same three obstacles, same handling:

1. Snapshot every view in `public` from the live catalog — definition,
   reloptions, comment, grants.
2. Drop them (CASCADE), drop `delivery_lines.qty_outstanding`.
3. `alter column ... type numeric(12,2)` on all **15** quantity columns:

   | | |
   |---|---|
   | `stock_levels.qty` | `delivery_lines.qty` |
   | `sale_lines.qty` | `delivery_lines.qty_received` |
   | `receiving_lines.qty` | `delivery_lines.qty_resolved` |
   | `losses.qty` | `delivery_lines.qty_damaged` |
   | `return_lines.qty` | `count_snapshot_lines.expected_qty` |
   | `return_lines.qty_damaged` | `count_snapshot_lines.counted_qty` |
   | `stock_movements.qty_change` | `delivery_discrepancies.qty` |
   | `delivery_request_lines.qty_requested` | |

   The last two are the pair **0125** had to add after 0116 missed them. They
   are in this list because the columns were enumerated by grepping the schema
   for quantity columns, not by reasoning about which tables carry stock — the
   reasoning is what missed them last time.

4. Rebuild `qty_outstanding` as `numeric(12,2)`, same generated expression.
5. Drop the 9 `_tenths` CHECKs and add `_hundredths` CHECKs
   (`check (qty = round(qty, 2))`). Renaming rather than reusing the name makes
   a half-applied migration visible.
6. Restore views in the retry loop; restore grants; **revoke all on every view
   from `anon`** — this is 0122's lesson, and 0116 is exactly the migration
   that dropped it. Verify view count and reloptions survived, or raise and
   roll back.

One `do` block, atomic however it is run.

### The accumulator sweep is **not** needed

The superseded spec budgeted for repeating 0117–0121 and 0124. Three findings
say it is unnecessary:

- **Zero** PL/pgSQL variables anywhere in the migration tree are declared
  `numeric(12,1)`. The accumulators are unconstrained `numeric`, which has no
  scale limit.
- Every `int`/`bigint` accumulator that caused 0119, 0121 and 0124 was fixed
  there; those are the latest definitions of `fn_confirm_delivery`,
  `fn_stock_card` and `fn_record_count_shortages`.
- The general argument, which is the one that matters: **anything that still
  rounds at two decimals already rounds at one.** Widening tenths to hundredths
  cannot create a rounding site that tenths did not already expose, and tenths
  have been in production since 0116.

This is the single biggest reduction in risk versus the three-decimal spec.

### Bundled fix — `fn_dashboard_top_products`

Found while auditing for the above. Migration 0074 declares
`returns table (name text, qty bigint)` and computes `sum(sl.qty)::bigint`, so
the Dashboard's top-products list **rounds fractional quantities today** — 2.5
kg sold displays as 3. It is the 0121 failure mode in a function the 0117–0124
sweep missed, because that sweep followed the stock pipeline and this is a
dashboard aggregate.

Cosmetic, not ledger-affecting, and wrong at one decimal as much as at two.
Fixed in this migration: the return column becomes `numeric` and the cast is
dropped. Body otherwise byte-identical to 0074.

### Application layer

Four layers validate quantity; each changes depth only, and none learns a new
rule.

| Layer | Where | Now | After |
|---|---|---|---|
| the box | `sanitizeQtyInput` in `lib/format.ts` | keeps 1 decimal | keeps 2 |
| the parser | `parseQty` in `lib/format.ts` | one-decimal regex | one-or-two |
| the action | `qtySchema()` in `lib/qty-schema.ts` | `n*10` within 1e-9 | `n*100` |
| the authority | `fn_assert_qty` | `round(p_qty, 1)` | `round(p_qty, 2)` |

`sanitizeQtyInput` must keep preserving the half-typed forms `.2` and `2.` —
that is the 2026-08-10 production bug, where a silent refusal read as
acceptance and deducted 1 kg instead of 0.1. `parseQty` keeps normalising both.

**Rendering:** `formatQty` and `public.fmt_qty()` both go to two decimals with
trailing zeros trimmed — `12` stays `12`, `0.5` stays `0.5`, `0.25` renders
`0.25`. The two must agree or a printed document contradicts the screen it was
printed from.

Any user-facing message that says "one decimal" or offers `0.1` as the example
is swept to match.

## What deliberately does not change

- **Grams.** `g` has `allows_fractional = false`; `fn_assert_qty` still refuses
  `2.5 g` exactly as today. Nothing about the gram unit or its per-kilo pricing
  is touched.
- **Which units may be split.** `units.allows_fractional` still decides, and
  the row values are unchanged. `pc`, `set`, `box`, `pair`, `roll` and `g` stay
  whole.
- **Reorder levels.** A threshold, not a measurement — integer, per Gerry.
- **Money.** Centavos stay integer; `round(unit_price × qty)` is still computed
  once per line and stored, never re-derived downstream.
- **The engine exemption.** `fn_assert_qty` still returns early on a null
  `part_id`; an engine is counted, not measured.

### One accepted side effect

`m` and `ft` gain two decimals too — the precision is a property of the column,
not of the unit. `0.25 m` is 25 cm and `0.01 m` is 1 cm, both meaningful for
pipe sold by length. This is a small bonus rather than a cost, and is the
reason two decimals is safe where three (1 mm of pipe) was not.

## Risks

| Risk | Handling |
|---|---|
| A view returns without `security_barrier`, or `anon` re-granted | The migration verifies reloptions and revokes `anon` explicitly, then raises and rolls back on mismatch |
| Half-applied CHECK constraints | Renamed `_tenths` to `_hundredths`, so the state is visible; the whole block is atomic anyway |
| The ledger rewrite | `stock_movements` (~208k rows) is rewritten. Shops closed, manual backup downloaded first, staging proven green first — the 0116 protocol |
| An app layer left at one decimal | `test-fractional-qty.mjs` asserts each of the three layers separately, precisely because any one can rot alone |

**Rollback** is a restore from the pre-migration backup. Narrowing
`numeric(12,2)` back to `(12,1)` would round real recorded quantities and is
not a rollback path.

## Verification

1. `test-fractional-qty.mjs` extended: `0.25` accepted end-to-end through
   receive → deliver → confirm → sell → write off; `0.255` refused and provably
   changing nothing; a `pc` product still refusing `2.5`; a `g` product still
   refusing `0.5`; the ledger invariant holding exactly at `0.25`;
   `₱15.50 × 0.25` rounded once and stored.
2. `test-movements.mjs` — the invariant at two decimals.
3. Full `npm test` green on staging before production.
4. Browser QA: record a `0.25 kg` sale end to end, and confirm the Dashboard
   top-products list shows a fractional quantity unrounded.
