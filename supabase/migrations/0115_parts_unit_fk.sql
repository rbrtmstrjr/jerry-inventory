-- ---------------------------------------------------------------------------
-- 0115 — normalise parts.unit, then constrain it to the units vocabulary.
--
-- 0114 created `units` but deliberately left `parts` alone. This is the step
-- that makes the unit trustworthy, which is what lets 0116 key "may this
-- product be sold in tenths?" off it.
--
-- PRODUCTION VOCABULARY, read 2026-08-03 (live rows):
--     pc   387
--     set    3
--     1      1   <-- "Sato Power Sprayer 4-Stroke", created 2026-08-03 01:33
--
-- `pc` and `set` already exist in `units`. The '1' is a typo — someone typed a
-- quantity into the unit field. A power sprayer is a per-piece machine, so it
-- becomes 'pc'.
--
-- THE ONE THING THIS MIGRATION WILL NOT DO IS GUESS. Every value is either
-- mapped explicitly below or it aborts, because silently coercing an unknown
-- unit to 'pc' would quietly change what a product IS — and the first symptom
-- would be a cashier unable to sell half a kilo of nails, weeks later, with
-- nothing in the history to explain why.
--
-- Note the guard checks EVERY row, not just live ones: a foreign key applies to
-- soft-deleted products too, so a retired item with a stray unit would block
-- the constraint.
-- ---------------------------------------------------------------------------

-- 1. Keep the previous values. Cheap, and the only way back if a mapping was
--    wrong — `parts` has no history of its own for this column.
create table if not exists public._parts_unit_backup_0115 as
  select id, unit, now() as captured_at from public.parts;

comment on table public._parts_unit_backup_0115 is
  'Pre-0115 parts.unit values. Safe to drop once the units migration has been '
  'live for a release or two.';

-- 2. The explicit mapping. Add a line per real value; never a catch-all.
update public.parts set unit = 'pc'  where unit = '1';

-- Case/whitespace drift is a plausible way for new bad values to appear between
-- writing this and running it, so fold the obvious ones rather than aborting on
-- something trivially recoverable.
update public.parts
   set unit = lower(btrim(unit))
 where unit <> lower(btrim(unit));

-- 3. Refuse to continue on anything unrecognised.
do $$
declare unmapped text;
begin
  select string_agg(distinct p.unit, ', ' order by p.unit)
    into unmapped
    from public.parts p
    left join public.units u on u.code = p.unit
   where u.code is null;

  if unmapped is not null then
    raise exception
      'parts.unit contains values not in public.units: %. Decide each one with '
      'the owner and add it to units (or map it above) before re-running. '
      'Do NOT default them to ''pc''.', unmapped;
  end if;
end $$;

-- 4. Constrain. From here the unit is a controlled vocabulary and the Receiving
--    dropdown is the only way a new one gets in.
alter table public.parts
  drop constraint if exists parts_unit_fk;

alter table public.parts
  add constraint parts_unit_fk
  foreign key (unit) references public.units(code);

-- Products are filtered and grouped by unit in the catalog UI, and the FK makes
-- this a natural lookup path.
create index if not exists parts_unit_idx on public.parts (unit);
