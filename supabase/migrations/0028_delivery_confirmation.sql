-- ============================================================================
-- 0028_delivery_confirmation.sql — deliveries stop auto-landing.
--
-- Stock is ALWAYS in exactly one bucket: master, in-transit, or a shop.
--   send    → master −qty, qty enters IN-TRANSIT (tied to the delivery line)
--   confirm → received qty moves IN-TRANSIT → shop
--   short   → the remainder STAYS in-transit, delivery flagged 'discrepancy'
--   resolve → OWNER moves the remainder in-transit → master, or writes it off
--
-- RECONCILIATION INVARIANT (asserted in scripts/test-delivery-confirm.mjs):
--     sum(stock_levels.qty)            -- master (shop_id IS NULL) + every shop
--   + sum(stock_in_transit.qty)        -- the in-transit bucket
--   = total owned
-- Only a transit write-off (stock genuinely lost) may reduce total owned.
--
-- SHAPE NOTE: `delivery_lines.qty` IS the sent quantity. It is deliberately
-- NOT renamed to qty_sent — it is read by the delivery-note print page, the
-- deliveries history and the request pre-fill, and a redundant second column
-- would be a drift risk. qty_received / qty_resolved are added alongside it,
-- and qty_outstanding is GENERATED so the in-transit bucket can never drift
-- from the line it came from.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Delivery lifecycle
-- ---------------------------------------------------------------------------
alter table public.deliveries
  add column if not exists status text not null default 'in_transit'
    check (status in ('in_transit','confirmed','discrepancy','resolved')),
  add column if not exists confirmed_at timestamptz,
  add column if not exists confirmed_by uuid references public.profiles(id),
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references public.profiles(id);

alter table public.delivery_lines
  add column if not exists qty_received int check (qty_received >= 0),
  add column if not exists qty_resolved int not null default 0 check (qty_resolved >= 0),
  add column if not exists shop_note text;

-- Outstanding = still in transit. Generated, so it is always true to the line.
-- Before confirmation qty_received IS NULL → the whole line is in transit.
alter table public.delivery_lines
  add column if not exists qty_outstanding int
    generated always as (qty - coalesce(qty_received, 0) - qty_resolved) stored;

create index if not exists idx_deliveries_status on public.deliveries (status);
create index if not exists idx_deliveries_shop_status on public.deliveries (shop_id, status);

-- ---------------------------------------------------------------------------
-- 2. BACKFILL — every existing delivery already auto-landed in its shop, so it
--    is 'confirmed' in full. Without this they would look in-transit and the
--    invariant above would double-count stock that is already at the shops.
-- ---------------------------------------------------------------------------
update public.delivery_lines set qty_received = qty where qty_received is null;
update public.deliveries
set status = 'confirmed',
    confirmed_at = coalesce(confirmed_at, delivered_at)
where status = 'in_transit';

-- ---------------------------------------------------------------------------
-- 3. Discrepancy resolutions (owner-only decisions, audit trail)
-- ---------------------------------------------------------------------------
create table if not exists public.delivery_discrepancies (
  id uuid primary key default gen_random_uuid(),
  delivery_line_id uuid not null references public.delivery_lines(id) on delete cascade,
  qty int not null check (qty > 0),
  resolution text not null check (resolution in ('returned_to_master','written_off')),
  reason text,
  resolved_by uuid not null references public.profiles(id),
  resolved_at timestamptz not null default now()
);

create index if not exists idx_delivery_discrepancies_line
  on public.delivery_discrepancies (delivery_line_id);

-- ---------------------------------------------------------------------------
-- 4. The IN-TRANSIT bucket. A view, not a table: the delivery line is the one
--    source of truth, so this bucket can never drift out of sync with it.
-- ---------------------------------------------------------------------------
drop view if exists public.stock_in_transit;
create view public.stock_in_transit
with (security_barrier = true) as
select
  dl.id                          as delivery_line_id,
  d.id                           as delivery_id,
  d.shop_id,
  sh.name                        as shop_name,
  d.delivered_at,
  d.status                       as delivery_status,
  dl.part_id,
  dl.engine_id,
  coalesce(p.name, em.brand || ' ' || em.model) as name,
  coalesce(p.unit, 'unit')       as unit,
  dl.qty                         as qty_sent,
  dl.qty_received,
  dl.qty_outstanding             as qty,
  dl.shop_note
from public.delivery_lines dl
join public.deliveries d on d.id = dl.delivery_id and d.deleted_at is null
join public.shops sh on sh.id = d.shop_id
left join public.parts p on p.id = dl.part_id
left join public.engines e on e.id = dl.engine_id
left join public.engine_models em on em.id = e.engine_model_id
where dl.qty_outstanding > 0
  and (public.is_owner() or d.shop_id = public.auth_shop_id());

revoke all on public.stock_in_transit from anon;
grant select on public.stock_in_transit to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Shop-facing safe views. `deliveries`/`delivery_lines`/`parts` are all
--    owner-only base tables, so shops reach their incoming stock only through
--    these — own shop only, no cost columns.
-- ---------------------------------------------------------------------------
drop view if exists public.shop_incoming_deliveries;
create view public.shop_incoming_deliveries
with (security_barrier = true) as
select
  d.id,
  d.shop_id,
  d.delivered_at,
  d.note,
  d.status,
  d.confirmed_at,
  d.resolved_at,
  (select count(*) from public.delivery_lines dl where dl.delivery_id = d.id) as line_count,
  (select coalesce(sum(dl.qty), 0) from public.delivery_lines dl where dl.delivery_id = d.id) as qty_sent,
  (select coalesce(sum(dl.qty_outstanding), 0) from public.delivery_lines dl where dl.delivery_id = d.id) as qty_outstanding
from public.deliveries d
where d.deleted_at is null
  and (public.is_owner() or d.shop_id = public.auth_shop_id());

drop view if exists public.shop_incoming_delivery_lines;
create view public.shop_incoming_delivery_lines
with (security_barrier = true) as
select
  dl.id,
  dl.delivery_id,
  d.shop_id,
  dl.part_id,
  dl.engine_id,
  coalesce(p.name, em.brand || ' ' || em.model) as name,
  coalesce(p.unit, 'unit')                      as unit,
  e.serial_number,
  dl.qty                                        as qty_sent,
  dl.qty_received,
  dl.qty_outstanding,
  dl.shop_note
from public.delivery_lines dl
join public.deliveries d on d.id = dl.delivery_id and d.deleted_at is null
left join public.parts p on p.id = dl.part_id
left join public.engines e on e.id = dl.engine_id
left join public.engine_models em on em.id = e.engine_model_id
where public.is_owner() or d.shop_id = public.auth_shop_id();

revoke all on public.shop_incoming_deliveries from anon;
revoke all on public.shop_incoming_delivery_lines from anon;
grant select on public.shop_incoming_deliveries to authenticated;
grant select on public.shop_incoming_delivery_lines to authenticated;

-- ---------------------------------------------------------------------------
-- 6. RLS — discrepancy records are owner-only; the shop's window into
--    deliveries stays the safe views above (no new base-table access).
-- ---------------------------------------------------------------------------
alter table public.delivery_discrepancies enable row level security;

drop policy if exists delivery_discrepancies_owner_all on public.delivery_discrepancies;
create policy delivery_discrepancies_owner_all on public.delivery_discrepancies for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

-- ---------------------------------------------------------------------------
-- 7. Notification types for the flow
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'master_low_stock','shop_low_stock','delivery_request',
  'delivery_request_fulfilled','delivery_request_dismissed',
  'utang_payment','utang_payment_voided',
  'delivery_incoming','delivery_confirmed','delivery_discrepancy'
));

-- ---------------------------------------------------------------------------
-- 8. Realtime for the shop's incoming list + owner's discrepancy queue
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.deliveries;
exception when duplicate_object then null; end $$;
