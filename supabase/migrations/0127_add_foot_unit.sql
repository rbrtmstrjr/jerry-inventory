-- ---------------------------------------------------------------------------
-- 0127 — `ft` (foot) joins the unit vocabulary.
--
-- Production sells bronze and Ehe pipe BY THE FOOT — five products, ~217 feet
-- on hand at the time of writing. `feet` was free text before 0115 wired
-- parts.unit to this table, and it is not in 0114's seed.
--
-- The alternatives were both worse:
--   * relabel to `m` — leaves the quantity alone and changes what it MEANS.
--     48 feet of pipe would read as 48 metres on every receipt and delivery
--     note, overstating the length 3.28x.
--   * relabel to `pc` — says a length of pipe is a countable item, which stops
--     the shop ever measuring one out.
--
-- NOT fractional. Gerry's call, 2026-08-06: kilograms are the priority and the
-- only unit that may be split for now. Selling pipe by the half-foot later is
-- an UPDATE on this row, not a migration — which is the whole point of keeping
-- the vocabulary as data (see 0114).
--
-- ⚠️  ORDERING — the reason this file is applied BY HAND before `db push`:
--
-- `0115` adds the foreign key parts.unit -> units.code and aborts on any value
-- it cannot find. It runs immediately after 0114 in the same push, so a
-- migration numbered 0127 is far too late to help the five pipe products.
--
-- 0114 and this file are both idempotent, so the release runs:
--     1. apply 0114_units.sql   by hand   (creates the table, seeds 7 units)
--     2. apply 0127_add_foot_unit.sql by hand   (adds the 8th)
--     3. map the five products to 'ft' in the pre-flight
--     4. npx supabase db push   — re-runs 0114 and this file harmlessly, and
--        0115 now finds every unit present
--
-- Apply it to staging as well, so the two vocabularies match.
-- ---------------------------------------------------------------------------

insert into public.units (code, label, allows_fractional, sort_order)
values ('ft', 'Foot', false, 75)
on conflict (code) do nothing;
