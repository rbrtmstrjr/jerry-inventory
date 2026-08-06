# Plan — fractional quantities (sell by the kilo)

**Requested by Gerry, 2026-08-03.** He sells nails, lead and similar goods by
weight. Customers buy a *tingi* — a part-kilo — so the shop must be able to
record `0.5`, `2.3`, `10.2` kg, not just whole numbers.

**Precision: ONE decimal place. Tenths only.** `0.1` … `10.2` are valid;
`0.12`, `0.125` are not, and must be rejected rather than silently rounded.

**Status: PLAN ONLY. No migration in this document has been run.**
Production is live with Gerry's real books. Every migration here is for the
owner to apply, staging first, in a maintenance window.

---

## 1. Why this is bigger than it looks

`qty` is an **integer everywhere**, and the schema is knitted together through it:

| Table | Column(s) | Notes |
|---|---|---|
| `stock_levels` | `qty` | on-hand per shop |
| `sale_lines` | `qty` | `check (engine_id is null or qty = 1)` |
| `receiving_lines` | `qty` | |
| `delivery_lines` | `qty`, `qty_received`, `qty_resolved`, `qty_damaged` | **plus a generated column** |
| `return_lines` | `qty`, `qty_damaged` | |
| `losses` | `qty` | |
| `stock_movements` | `qty_change` | ~208k rows, append-only ledger |
| `count_snapshot_lines` | `expected_qty`, `counted_qty` | |

Three things make the migration awkward:

**1. A generated column.** `delivery_lines.qty_outstanding` is
`generated always as (qty - coalesce(qty_received,0) - qty_resolved) stored`
(`0028:44`). Postgres will not let you alter a column a generated column depends
on — it must be dropped and re-added.

**2. Thirty-three views.** Postgres refuses `ALTER COLUMN ... TYPE` when a view
depends on the column. Many do — `shop_stock`, `stock_in_transit`,
`movement_journal`, `shop_low_stock`, the slip views, the registry views. They
must be dropped and recreated **in dependency order**.

**3. The reconciliation invariant.** `Σ movements(product, location) =
stock_levels(product, location)` must still hold exactly. This is the reason to
use `numeric` and never a float — see below.

Roughly **9 RPC functions** take `p_qty int` and must be redefined.

---

## 2. Design decisions

### 2.1 Use `numeric(12,1)` — not float, not integer tenths

**Never `real`/`double precision`.** Binary floating point cannot represent 0.1
exactly. `0.1 + 0.2 != 0.3`, and the ledger invariant would drift by fractions
that accumulate over thousands of movements. `numeric` is exact decimal
arithmetic; the invariant continues to hold to the digit.

**Why not store integer tenths** (100 = 10.0 kg, the "centavos trick")? It would
avoid every type change above — genuinely tempting. But it makes every raw row
ambiguous: `stock_movements.qty_change = 102` means 102 pieces for one product
and 10.2 kg for another. Every report, every manual SQL query, every future
maintainer has to know the scale. Money gets away with it because *every* money
column is centavos, always. Here the unit would vary per row. Not worth it.

**`numeric(12,1)` enforces one decimal at rest** — but note Postgres **rounds**
to scale rather than rejecting, so `0.12` would silently store as `0.1`. That is
not acceptable for Gerry's requirement, so validation is explicit (§2.3).

### 2.2 Fractional derives from the UNIT (Gerry's design, and it is the right one)

Not a per-product flag. **The unit decides**: if a product is sold in kilos, its
quantity is editable; if it is sold in pieces, it is not.

One source of truth, it matches how a shopkeeper actually thinks, and it means
Gerry never has to remember to tick a box on a new product — choosing "Kilogram"
in Receiving is the whole action.

The objection to this was that `parts.unit` is free text, so `kg` / `kilo` /
`kls` / `Kg` would all behave differently. **Gerry's own suggestion fixes it:
make the unit a dropdown.** That turns the loophole into the mechanism.

```sql
create table public.units (
  code              text primary key,            -- 'pc', 'kg'
  label             text not null,               -- 'Piece', 'Kilogram'
  allows_fractional boolean not null default false,
  sort_order        int  not null default 100,
  deleted_at        timestamptz
);
```

Seeded with `pc` (Piece), `kg` (Kilogram, **fractional**), `set`, `box`, `roll`,
`pair`, `m` (Meter). Only `kg` starts fractional; enabling another later is a
row update, not a migration.

`parts.unit` then references `units.code`. A product's quantity is editable when
its unit's `allows_fractional` is true — resolved by a join, stored nowhere
twice.

**Why a table rather than a CHECK constraint** (the `shops.color_key` pattern
from 0050): a CHECK would need a migration every time Gerry wants to sell
something by the metre. Units are reference data he should be able to manage,
exactly like `product_categories`.

- Whole-unit goods stay whole — nobody sells 2.5 spark plugs.
- **Engines are never fractional.** The existing
  `check (engine_id is null or qty = 1)` still holds under numeric (`1 = 1.0`).

### 2.2b The existing free-text units must be normalised first

**This is a blocker, and it needs production data to resolve.** Staging is no
help — all 415 live parts there are `'pc'` (generated). Gerry's real vocabulary
exists only in production.

**Read-only query for the owner to run in the production SQL editor:**

```sql
select unit, count(*) as products
from public.parts
where deleted_at is null
group by unit
order by products desc;
```

The result decides the mapping table in `0115` — e.g. `'kls'` → `'kg'`,
`'pcs'` → `'pc'`. Until it is known, that migration cannot be written honestly.

**Do not guess this.** Mapping a unit wrongly makes a product fractional (or
not) against Gerry's intent, and the first sign would be a cashier unable to
sell half a kilo of nails.

### 2.3 Reject two decimals explicitly

Three layers, because the DB layer rounds rather than refuses:

1. **UI** — `step="0.1"`, and reject on submit if `qty * 10` is not an integer.
2. **RPC** — in every function taking a qty, raise if
   `p_qty <> round(p_qty, 1)`, with a plain message.
3. **CHECK constraint** — `check (qty = round(qty, 1))` on each qty column, as
   the backstop that makes the rule true regardless of caller.

Also enforce: `allow_fractional = false` ⇒ qty must be whole
(`qty = round(qty, 0)`), checked in the RPC, since it spans two tables and
cannot be a simple CHECK.

### 2.4 Money: round once, store it — the sharpest risk

`0.1 kg × ₱75.92` = `759.2` centavos. Money is integer centavos by design, so
fractional line totals must round. **Where that rounding happens decides whether
the P&L ties out.**

The good news: **the schema already stores line money rather than recomputing it.**

| Value | Where | Status |
|---|---|---|
| `sale_lines.line_total_centavos` | stored at sale | ✅ round once in `fn_record_sale` |
| `sales.total_centavos` | stored | ✅ sum of stored lines |
| `sale_line_costs.line_cost_centavos` | stored, frozen at approval (0038) | ✅ round once in `fn_approve_sale` |
| `losses.value_centavos` | stored | ✅ round at record/approve |

**Only two places multiply `qty × price` at read time**, and both need an
explicit `round()`:

- `0033_supplier_payables.sql:104` — `receiving_balances`:
  `sum(rl.qty * rl.unit_cost_centavos)`
- `0111_sales_report_facts.sql:71` — transit value:
  `sum(qty * unit_cost)`

**Rule to apply everywhere:** `round(unit_price_centavos * qty)` per line, then
sum the rounded line integers. Never sum unrounded products and round at the
end — the two differ, and the difference is what makes a receipt disagree with a
report.

**Consequence worth telling Gerry:** at 0.1 kg the per-line rounding is at most
half a centavo. It cannot accumulate, because each line is rounded and stored
once.

---

## 3. Migration plan — for the owner to run, staging first

Numbered `0114` onward. **Do not run any of this automatically.**

### 0114 — the units table, additive only, zero risk

Creates `public.units`, seeds the vocabulary, grants select to `authenticated`,
office-tier writes (`is_owner()`) mirroring `product_categories`. **Does not
touch `parts` yet**, so nothing changes behaviour.

Deployable on its own, any time — including before the rest is built.

### 0115 — normalise `parts.unit`, then constrain it

**Cannot be written until §2.2b's query has been run against production.**

1. `update parts set unit = <canonical>` using the mapping derived from the real
   values (case-folded, trimmed).
2. Any unmapped value → insert it into `units` as non-fractional rather than
   discarding it. **Never silently coerce an unknown unit to `'pc'`** — that
   would quietly change what a product *is*.
3. `alter table parts add constraint parts_unit_fk foreign key (unit)
   references units(code);`

Reversible: the FK can be dropped, and the previous values should be captured
first (`create table _unit_backup as select id, unit from parts;`).

### 0115 — the type change (the risky one)

Structure, in this order, in ONE transaction:

1. `drop view` every dependent view (33 exist; the dependency order matters —
   `shop_low_stock_safe` depends on `shop_low_stock`, the slip views on their
   parents).
2. `alter table delivery_lines drop column qty_outstanding;` (generated)
3. `alter table ... alter column ... type numeric(12,1)` for all columns in §1.
4. Re-add `qty_outstanding` as the same generated expression.
5. Add the `= round(qty, 1)` CHECKs.
6. `create view` every view again, byte-identical to its current definition
   except for the type flowing through.

**Operational notes for the owner:**
- This takes **ACCESS EXCLUSIVE locks** and rewrites tables. `stock_movements`
  (~208k rows) is the largest; expect seconds, not minutes — but the app is
  **fully blocked** for that window. Run it when the shops are closed.
- **Run the backup workflow manually first** and download the artifact. This is
  the one migration in the project's history that rewrites the ledger table.
- It is *not* practically reversible once written to. The rollback is the
  backup.

### 0116 — RPC signatures

Redefine the ~9 functions taking `p_qty int` to `numeric`, adding the
one-decimal guard and the `allow_fractional` check. Bodies otherwise unchanged.

**Postgres does not replace a function when the signature changes** — it creates
an overload. Each must be `drop function ... (old signature)` then recreated, or
old and new coexist and callers bind unpredictably.

### 0117 — the two computed money sites

Recreate `receiving_balances` and `fn_sales_report`'s transit arm with explicit
`round()`. Additive to correctness; no data change.

---

## 4. App changes

**Record Sale** (`app/(shop)/shop/record-sale/record-sale-form.tsx`)
- Qty becomes an editable input for fractional products, keeping −/+ (stepping
  by 0.1) for touch use. Whole-unit products keep today's behaviour exactly.
- The cart, the line total and the sale total display and compute in decimals.
- **The barcode scanner path is unaffected** — a scan still adds 1 (or 0.1?
  see §6). Whatever is chosen, the scan must not become a two-step interaction;
  that is the counter's fast path.

**Everywhere qty is displayed or entered** — shop stock, low stock, deliveries,
delivery confirm (good/damaged/missing), transfers, returns, counts, movements,
the ledger, and the five printed documents. Formatting rule: show `10.2` for
fractional products, `12` for whole ones — never `12.0`.

**`lib/db-types.ts`** — qty types become `number` (they already are in TS, but
the integer assumption is baked into UI logic such as `Math.min(qty, available)`
and the +/- handlers).

---

## 5. Test plan

Existing suites that must stay green, unchanged:

- **`test-movements`** — the invariant, now with decimals. Add a case that
  receives 10.5, delivers 2.3, sells 0.7, and asserts the ledger still sums
  exactly to the shelf. This is the single most important new test.
- **`test-delivery-confirm`** / **`test-receipt-damage`** — `qty_outstanding` is
  regenerated; confirm the transit bucket still reconciles with fractions.
- **`test-pnl`** — that per-line rounding leaves revenue, COGS and net income
  tying out to the centavo.
- **`test-pricing`** — the strict "above cost" floor with fractional qty.
- **`test-supplier-payables`** — `receiving_balances` after the `round()` change.

New: **`test-fractional-qty.mjs`** — 0.12 rejected at the RPC; a whole-unit
product refuses 2.5; 0.1 accepted; engines still forced to 1.

---

## 6. Answers from Gerry (2026-08-03)

1. **Sold by weight:** nails, lead, fasteners, welding materials, powders &
   compounds — anything sold in kilos. **Driven by the unit**, per §2.2.
2. **A scan adds 1 kilo.** The *tingi* happens by editing the quantity, never at
   scan time. **The scanner path is therefore untouched** — one scan, one
   action, exactly as today. (This also protects the counter flow fixed earlier
   this sweep.)
3. **Minimum 0.1.** Enforced as `check (qty >= 0.1)` on fractional lines and as
   the input `min`.
4. **Reorder levels stay whole numbers.** `parts.reorder_level` and
   `shop_reorder_levels` are **not** touched — they remain `int`. This removes a
   meaningful chunk of work.
   *Consequence to accept:* a kilo product's low-stock threshold is a whole
   kilo. "Alert me at 5 kg", not 5.5. Gerry is content with that.
5. **Existing stock figures are correct as-is.** They become `x.0`; no data
   migration of quantities is required.

### Still to confirm before 0115 can be written

**The distinct `parts.unit` values in PRODUCTION** — see §2.2b. This is the only
open blocker.

---

## 7. Recommended order

1. Answer §6 with Gerry — questions 1 and 3 change the UI design.
2. Apply **0114** (additive) to staging, then production. Safe any time.
3. Build and test **0115–0117** plus the app changes on **staging**, with the
   full suite green.
4. QA on `staging.gerwintrading.com` with realistic weights.
5. **Back up production**, then apply 0115–0117 in a closed-shop window.
6. Deploy the app, verify with one real weighed sale, watched.

**The 0114 step is worth doing early and alone.** It is genuinely zero-risk and
it lets Gerry start flagging his weight products before anything else ships.

---

## 8. What actually shipped (2026-08-06) — the production runbook

The plan estimated **0114–0117**. It took **0114–0124**. The extra seven are
not scope creep; five of them are the same class of defect found repeatedly,
which is the useful part of this record.

### The migrations, in the order they must be applied

| # | File | What it does | Re-runnable? |
|---|------|--------------|--------------|
| 0114 | `units.sql` | `public.units` vocabulary + RLS. Additive, zero behaviour change. | yes |
| 0115 | `parts_unit_fk.sql` | `parts.unit` → FK on `units`. | yes |
| 0116 | `fractional_qty.sql` | **THE RISKY ONE.** Eleven columns → `numeric(12,1)`, generated column rebuilt, tenths CHECKs, all dependent views snapshotted and restored. | **NO — run once** |
| 0117 | `fractional_qty_counter.sql` | `fn_record_sale` / `fn_record_loss` take `numeric`. | yes |
| 0118 | `fractional_qty_stock.sql` | `fn_assert_qty` + receive/deliver/confirm/return. | yes |
| 0119 | `fix_qty_accumulators.sql` | Widens `v_short`, `v_damaged`, `v_landed`, `v_left`, `v_damaged_line`. | yes |
| 0120 | `fractional_qty_transfers.sql` | Transfer + return request/approve paths. | yes |
| 0121 | `fix_stock_card_balance.sql` | `fn_stock_card`'s `balance` and `v_open` (both `bigint`). | yes |
| 0122 | `restore_anon_revokes.sql` | Re-revokes `anon` on the views 0116 recreated. | yes |
| 0123 | `fmt_qty.sql` | `public.fmt_qty()`, mirroring `formatQty` in TS. | yes |
| 0124 | `fix_count_shortage_qty.sql` | `v_shortage` in `fn_record_count_shortages`. | yes |

**0116 has no `if not exists` on its `add constraint`.** Applying it twice
fails partway. If it errors, read the error before re-running anything.

### Production sequence

1. Shops closed (no one recording).
2. **Back up production by hand first** — not the nightly job, a fresh one.
3. Apply 0114 → 0124 **in order**, one at a time, reading each result.
4. Deploy the app.
5. Gerry reclassifies his kilo products to unit `kg` (Master Inventory → edit →
   Unit dropdown). Until he does, everything behaves exactly as before — which
   is the safe default and why 0114 was worth shipping alone.
6. Watch one real weighed sale end to end.

### The defect class worth remembering

Five of the seven unplanned migrations are the same bug: **PL/pgSQL rounds
silently on assignment to `int`/`bigint`.** A local variable that receives a
quantity must be `numeric`, and missing one produces no error — just a wrong
number. 0119's `v_short` gated discrepancy-vs-confirmed, so a 0.4 kg shortfall
would have rounded to 0 and broken the ledger invariant with nothing in the log.

Each miss came from the same root cause: **the audit was narrower than the
change.** Grepping `int|integer` missed `bigint` (0121) and `RETURNS TABLE`
columns; auditing nine functions missed the tenth touched later (0124);
verifying grants missed revokes (0122). When sweeping a whole schema, the sweep
and the verification must have the same shape.

Item §6.3 ("minimum 0.1") needed no CHECK in the end: `fn_assert_qty` requires
`> 0` **and** one decimal, so 0.1 is the smallest expressible quantity by
construction.

### Verification

`scripts/test-fractional-qty.mjs` (39 assertions) proves the three rules
separately, the ledger invariant at a fractional quantity, and the money
rounding. `scripts/test-lib-unit.mjs` gained 36 pure-function assertions for
`parseQty` / `formatQty` — including that `0.12` returns `null` rather than
`0.1`, the silent-round failure this whole feature is built to prevent.
