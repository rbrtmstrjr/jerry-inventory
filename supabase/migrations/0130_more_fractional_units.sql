-- ---------------------------------------------------------------------------
-- 0130 — `m`, `ft` and `roll` become splittable, alongside `kg`.
--
-- Gerwin sells rope, wire, cable and hose by the metre, bronze and Ehe pipe by
-- the foot, and a part roll AS A ROLL. Until now `kg` was the only unit a
-- customer could buy a part of.
--
-- THERE IS NO SCHEMA CHANGE HERE, AND THAT IS THE POINT. 0114 made the
-- vocabulary DATA precisely so this day would be an UPDATE: fn_assert_qty
-- joins `units` on every call, and the Record Sale form reads the table
-- through useUnits, so both the server rule and the editable quantity box
-- follow this row the moment it flips. 0127 wrote the prediction down —
-- "selling pipe by the half-foot later is an UPDATE on this row, not a
-- migration".
--
-- Granularity stays at ONE decimal. 0.5 ft (6 inches) is expressible; 0.25 ft
-- is NOT, and is refused by name. Confirmed with Gerry 2026-08-10 — pipe is
-- quoted in halves. Two decimals would mean ALTERing all fifteen quantity
-- columns and redoing every tenths CHECK: a 0116-class migration, out of scope.
--
-- `roll` is counted BY THE ROLL — 0.5 roll, never converted to metres. The
-- product's unit stays what the shop calls it; the fraction says how much of
-- it was sold.
--
-- Existing whole quantities stay valid, no backfill: the flag only PERMITS
-- tenths from here on, and the seven `check (qty = round(qty, 1))` constraints
-- already cover the quantity columns.
-- ---------------------------------------------------------------------------

update public.units set allows_fractional = true
 where code in ('m', 'ft', 'roll');

-- A missing or retired code makes the UPDATE a SILENT no-op — the exact
-- failure mode that cost this project 0125 (a rounded audit row) and the
-- 2026-08-09 row-cap outage (a truncated response with no error). The
-- vocabulary was verified on STAGING; production's `roll` row is unconfirmed.
-- Fail loudly rather than report success.
do $$
declare v_missing text;
begin
  select string_agg(c, ', ') into v_missing
    from (select unnest(array['m', 'ft', 'roll']) as c) x
   where not exists (
     select 1 from public.units u
      where u.code = x.c
        and u.allows_fractional
        and u.deleted_at is null);
  if v_missing is not null then
    raise exception
      '0130 did not flip these units (missing or retired): %', v_missing;
  end if;
end $$;
