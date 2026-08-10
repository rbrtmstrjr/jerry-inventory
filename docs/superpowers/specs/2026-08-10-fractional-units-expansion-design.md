# Extend tingi (fractional quantities) to Meter, Foot and Roll

**Date:** 2026-08-10
**Status:** shipped, then PARTIALLY REVERTED — Gerry clarified (message read
late, same day) that a **roll sells WHOLE**: part of a roll is the by-the-metre
product, never `0.5 roll`. `0131_roll_stays_whole.sql` reverts the roll arm;
`m` and `ft` keep their tenths.
**Migration:** `0130_more_fractional_units.sql` + `0131_roll_stays_whole.sql`

---

## Problem

Since 0114–0124 a quantity may be a tenth, but **only for products whose unit
says so**. `units.allows_fractional` is true for `kg` alone, so Gerry can sell
half a kilo of nails but not half a metre of rope or half a foot of pipe.

Production carries roughly 217 ft of bronze and Ehe pipe across five products
(the reason `ft` was added by hand as 0127), and those are exactly the goods a
customer buys a part-length of.

## Decision

Four units become splittable into tenths:

| Unit | Splittable | Rationale |
|------|-----------|-----------|
| `kg`   Kilogram | yes (already) | nails, lead, fasteners, welding materials, powders |
| `m`    Meter    | **yes, new**  | rope, wire, cable, hose cut to length |
| `ft`   Foot     | **yes, new**  | bronze and Ehe pipe |
| `roll` Roll     | **yes, new**  | a part roll is sold **as a roll** — see the note below |
| `pc`   Piece    | no | discrete |
| `set`  Set      | no | discrete |
| `box`  Box      | no | discrete |
| `pair` Pair     | no | discrete |

**`roll` stays priced and counted BY THE ROLL** (confirmed 2026-08-10). Half a
roll is recorded as `0.5 roll`, not converted into metres. This was the one
unit queried during design — the alternative was to leave `roll` whole and have
a cut roll re-measured as `m` — and it was settled deliberately: the product's
unit stays what the shop calls it, and the fraction expresses how much of it
was sold. Do not "improve" this later by unit-converting at the counter; the
stock figure and the price both key off the roll.

**Granularity stays at ONE decimal.** `numeric(12,1)` is unchanged. This was
weighed explicitly: `0.5 ft` (6 inches) is expressible, `0.25 ft` (3 inches) is
NOT and will be refused by name. Confirmed as acceptable — pipe is quoted in
halves, not quarters. Moving to two decimals would mean ALTERing all fifteen quantity
columns (thirteen in 0116, two more in 0125), redoing every tenths CHECK, `fn_assert_qty`, `fmt_qty`, `formatQty`
and `qtySchema` — a 0116-class migration with view snapshot/restore. It is
explicitly out of scope, and if it is ever needed it gets its own spec.

**No Units management UI.** Flipping a unit has come up twice in the project's
life. A Settings screen (create / rename / retire / toggle splittable) was
considered and rejected as YAGNI for now; it remains a clean follow-up if Gerry
ever wants to manage the vocabulary himself.

## Why this needs no schema change and almost no code

The 0114 design anticipated this. Every layer reads the flag **live**:

| Layer | How it decides |
|---|---|
| `fn_assert_qty` | `left join public.units u on u.code = p.unit` — evaluated per call |
| Record Sale | `units.some((u) => u.code === unit && u.allows_fractional)` |
| `qtySchema` | allows a tenth on *every* product, defers the rule to the database |
| `sanitizeQtyInput` | allows one decimal in *every* quantity box |

CLAUDE.md already states the consequence: *"Only `kg` is fractional today;
selling rope by the metre is an UPDATE, not a migration."* This spec is that
sentence being cashed in.

Grepping `app/`, `lib/` and `components/` for a hardcoded `"kg"` returns
**one** hit — a code comment. There is no logic keyed to a specific unit.

## Changes

### 1. `supabase/migrations/0130_more_fractional_units.sql`

A data migration, the same class as 0127 (which inserted the `ft` row).

```sql
update public.units set allows_fractional = true
 where code in ('m', 'ft', 'roll');

-- A missing or retired code would make the UPDATE a SILENT no-op, which is
-- the failure mode this project keeps getting bitten by (0125, the row cap).
-- Verify, and refuse rather than report success.
do $$
declare v_missing text;
begin
  select string_agg(c, ', ') into v_missing
    from (select unnest(array['m','ft','roll']) as c) x
   where not exists (
     select 1 from public.units u
      where u.code = x.c and u.allows_fractional and u.deleted_at is null);
  if v_missing is not null then
    raise exception 'units not flipped (missing or retired): %', v_missing;
  end if;
end $$;
```

Idempotent — re-running under `db push` is a no-op. The guard matters because
the vocabulary was verified on **staging only**; production's `roll` row is
unconfirmed, and a silent no-op there would leave the feature half-delivered
with every test green.

### 2. `components/unit-select.tsx`

The picker labels every fractional unit **"sold by weight"**. A fractional
Meter would read *"Meter — sold by weight"*, which is wrong. Replace with the
unit-neutral **"sold in parts"**. This is the only user-facing string in the
codebase that assumes weight.

### 3. `scripts/test-fractional-qty.mjs`

The mechanism is already covered — the suite proves the rule follows the unit
when the flag is flipped. What is missing is a **vocabulary assertion**:

- exactly `kg, m, ft, roll` are fractional, and `pc, set, box, pair` are not
- a `pc` product still refuses `2.5` (nobody sells half a spark plug)
- an `m` product accepts `1.5` end-to-end: receive → deliver → confirm → sell

Encoding the vocabulary means a future flip must update this test. That
friction is deliberate: it keeps the business decision explicit in the repo
instead of living only as database state nobody can see in a diff.

### 4. `scripts/qa-browser/fq20-fractional-units.mjs`

Provision a Meter product at Ternate, sell `1.5 m` through the real UI, and
assert **against the database** that the stored line is `1.5` and the line
total is `round(price × 1.5)`. Also assert a `pc` product's cart row still
shows no typed quantity box.

Browser QA is required, not optional: `test-fractional-qty` was 41/41 green
while the counter still refused `0.5`, because RPC-level suites cannot see the
form or the server action.

### 5. `CLAUDE.md`

Update the tingi section: `kg` is no longer the only fractional unit. Keep the
sentence explaining that the unit decides, and record that tenths remain the
granularity by decision, with quarters explicitly out of scope.

## Out of scope

- Two-decimal quantities (`0.25`) — see Decision above
- A Units management screen in Settings
- Any change to reorder levels, which stay whole numbers by Gerry's explicit
  instruction (a threshold, not a measurement)
- Engines, which remain one row per physical unit, quantity pinned at 1

## Risks

**Low, and bounded.** Flipping the flag only *permits* tenths going forward:

- existing whole quantities remain valid
- the seven `check (qty = round(qty, 1))` constraints already cover the
  quantity columns, so no new constraint is needed and none can be violated
- no backfill, no data rewrite, nothing to reverse beyond setting the flag back

The one real risk is the silent no-op on production if a unit code is absent,
which the migration's guard converts into a loud failure.

## Rollout

1. Apply `0130` to **staging**
2. `npm test` (expect 55 suites green, with the extended `test-fractional-qty`)
3. `node scripts/qa-browser/fq20-fractional-units.mjs`
4. Merge and deploy
5. Apply `0130` to **production**

No code/schema ordering hazard: the app behaves correctly with the flag in
either state, so the deploy and the migration are independent. This is the
reverse of the 0128 incident, where new code met an old schema.
