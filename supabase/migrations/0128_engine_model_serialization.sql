-- ---------------------------------------------------------------------------
-- 0128 — some engine models have no serial numbers.
--
-- Gerry buys five identical small engines that carry ONE product code between
-- them and no per-unit plate. Today every engine must have its own unique
-- serial, so he could add one and then the system refused the rest — he was
-- typing the shared code into the serial box because it was the only way to get
-- a second unit in.
--
-- WHERE THE RULE LIVES, and why: on the MODEL, not on each unit. This is
-- 0114's `units.allows_fractional` decision again — kilograms may be split and
-- pieces may not, so the rule belongs on the unit rather than as a flag someone
-- must remember on every product. Same here: a Yamaha 40HP has plates and a
-- cheap brush cutter does not, and that is a fact about the MODEL. Choosing it
-- once when the model is created is the whole action.
--
-- WHAT DOES NOT CHANGE: engines are still one row per physical unit. Five units
-- are five `engines` rows. That is what keeps warranties working — one per
-- engine, enforced by a unique constraint on `warranties.engine_id` — along
-- with the chain of custody on /movements?tab=engines and the five
-- `check (engine_id is null or qty = 1)` constraints. Nothing about quantity
-- reaches the engine tables.
--
-- `is_serialized` DEFAULTS TRUE so all 30 existing models keep today's exact
-- behaviour and there is no data pass. Gerry switches the rare exceptions.
--
-- `sku` mirrors `parts.sku` deliberately — same concept, same word, so nobody
-- has to learn two names for a product code. Not unique, exactly like
-- `parts.sku`, because the live data is the authority on whether codes repeat
-- and a hard constraint here would reject rows Gerry already has. Searchable,
-- not scannable: it is his own reference rather than a barcode on the box. If
-- that changes, `parts` keeps scannable codes in a separate `barcode` column,
-- so the door is open without a redesign.
--
-- `UNIT-########` is what fills `serial_number` for a unit that has no serial.
-- The column is `not null unique` and 146 app sites read it as a string, so a
-- minted value keeps every one of them correct — a nullable column would turn
-- each into its own "what shows when empty?" decision. The prefix reads as a
-- system number rather than a plausible plate, which is the point: nobody
-- should mistake it for something stamped on metal.
--
-- Additive and behaviour-free on its own. Nothing calls the function yet.
-- Safe to apply while the shops are open.
-- ---------------------------------------------------------------------------

alter table public.engine_models
  add column if not exists is_serialized boolean not null default true;

alter table public.engine_models
  add column if not exists sku text;

comment on column public.engine_models.is_serialized is
  'False when this model''s units carry no individual plate — they share the '
  'model''s sku and are interchangeable. Drives whether a receiving line may '
  'carry a quantity (0129). Defaults true: most engines are serialized.';

comment on column public.engine_models.sku is
  'The shared product code for a model. Mirrors parts.sku — same concept, and '
  'like parts.sku it is NOT unique. Searchable, not scanned.';

-- The office searches models by code; the catalog is small so this is cheap.
create index if not exists idx_engine_models_sku
  on public.engine_models (sku)
  where sku is not null;

create sequence if not exists public.engine_unit_seq;

create or replace function public.fn_generate_engine_unit_no()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text;
begin
  if not public.is_owner() then
    raise exception 'Only the office can number engine units';
  end if;

  -- Loop because a human could conceivably have typed a UNIT- serial by hand.
  loop
    v_code := 'UNIT-' || lpad(nextval('engine_unit_seq')::text, 8, '0');
    exit when not exists (select 1 from engines where serial_number = v_code);
  end loop;

  return v_code;
end $$;

revoke all on function public.fn_generate_engine_unit_no() from public, anon;
grant execute on function public.fn_generate_engine_unit_no() to authenticated;
