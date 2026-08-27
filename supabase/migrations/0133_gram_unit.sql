-- 0133 — grams, for tingi weighed goods sold straight off the scale.
--
-- A customer buys by PESO AMOUNT ("₱100 of concrete nails"). The scale converts
-- that to a weight, the employee weighs it, and types it in. In kilos that
-- weight is 0.6897, and quantity is numeric(12,1) — so it had to be entered as
-- 0.7 kg, overcharging by ₱1.50 and deducting 10 g that never left the shop.
-- Worst case is half a tenth: 50 g, about 7% of a ₱100 sale.
--
-- Grams make the quantity a WHOLE NUMBER (198), so no precision is needed and
-- not one quantity column changes. `kg` is untouched and stays the common unit;
-- grams are for the few products sold by the peso off a scale, created fresh.
--
-- The cost, and it is a real one: price_centavos is an integer, so a per-gram
-- price moves in whole centavos — 1¢/g × 1000 = ₱10.00/kg. A gram-priced
-- product can only sit on a ₱10-per-kilo grid. Accepted deliberately (Gerry,
-- 2026-08-12); the alternative was widening fifteen quantity columns to
-- numeric(12,3), rebuilding a generated column and re-sweeping every PL/pgSQL
-- accumulator — see docs/superpowers/specs/2026-08-12-gram-precision-design.md
-- for the approach this replaced.
--
-- Same shape as 0127, which added `ft`: reference data, so enabling it is an
-- INSERT rather than a migration of the schema. Idempotent.

insert into public.units (code, label, allows_fractional, sort_order)
values ('g', 'Gram', false, 25)   -- 25 sits directly after kg (20) in the picker
on conflict (code) do nothing;
