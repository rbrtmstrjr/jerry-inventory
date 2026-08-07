-- ---------------------------------------------------------------------------
-- 0114 — units as reference data (groundwork for fractional quantities).
--
-- Gerry sells nails, lead, fasteners, welding materials and powders BY THE KILO,
-- and customers buy a *tingi* — a part kilo. So quantity has to accept 0.1, 2.3,
-- 10.2. The decision of WHICH products may do that is the unit's: if it is sold
-- in kilograms the quantity is editable, if it is sold in pieces it is not.
-- That is how a shopkeeper already thinks, and it means no per-product flag to
-- remember on every new item — choosing "Kilogram" in Receiving is the whole
-- action.
--
-- The obvious objection to keying off the unit is that `parts.unit` is FREE TEXT
-- (default 'pc'), so 'kg' / 'kilo' / 'kls' / 'Kg' would all behave differently
-- and a business rule would hinge on spelling. This table is the fix: the unit
-- becomes a controlled vocabulary chosen from a dropdown, which turns the
-- loophole into the mechanism.
--
-- A TABLE rather than a CHECK constraint (the `shops.color_key` pattern from
-- 0050) because units are reference data the office should manage: selling rope
-- by the metre should be a new row, not a migration. Same reasoning, and the
-- same shape, as `product_categories`.
--
-- THIS MIGRATION IS ADDITIVE AND CHANGES NO BEHAVIOUR. It does not touch
-- `parts`; wiring `parts.unit` to this table happens in 0115, which needs the
-- real production vocabulary first (see the plan doc). Applying this alone is
-- safe at any time, including while the shops are open.
-- ---------------------------------------------------------------------------

create table if not exists public.units (
  code              text primary key,
  label             text not null,
  -- The whole point of the table. Only kilograms start fractional; enabling
  -- another unit later is an UPDATE, not a migration.
  allows_fractional boolean not null default false,
  sort_order        int not null default 100,
  created_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  constraint units_code_lower check (code = lower(code)),
  constraint units_code_len   check (char_length(code) between 1 and 12)
);

comment on table public.units is
  'Controlled vocabulary for parts.unit. allows_fractional drives whether a '
  'product may be sold in tenths (0.1) — see 0116.';

-- Seed. `pc` matches the existing parts.unit default, so it must exist.
-- Only `kg` is fractional today; the rest are whole-unit goods.
insert into public.units (code, label, allows_fractional, sort_order) values
  ('pc',   'Piece',      false, 10),
  ('kg',   'Kilogram',   true,  20),
  ('set',  'Set',        false, 30),
  ('box',  'Box',        false, 40),
  ('roll', 'Roll',       false, 50),
  ('pair', 'Pair',       false, 60),
  ('m',    'Meter',      false, 70)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- RLS — mirrors product_categories: the whole office reads and writes it,
-- employees read it (the shop needs the label to render "12 kg on hand").
-- ---------------------------------------------------------------------------
alter table public.units enable row level security;
revoke all on public.units from anon;

drop policy if exists units_select on public.units;
create policy units_select on public.units
  for select to authenticated
  using (true);   -- non-sensitive reference data, like product_categories

drop policy if exists units_write on public.units;
create policy units_write on public.units
  for all to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

-- is_owner() wrapped in a scalar subquery so Postgres hoists it to a single
-- InitPlan instead of evaluating per row — the 0076/0108 rule.
