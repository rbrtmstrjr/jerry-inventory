-- ============================================================================
-- 0024_stock_alerts.sql — low-stock visibility, delivery requests, notifications.
--
-- The core distinction this models:
--   MASTER low  → buy from a SUPPLIER  → printable purchase list.
--   SHOP low    → request a DELIVERY from the owner (hub-and-spoke; shops
--                 never buy from suppliers).
--
-- Notes on what already existed (verified, not assumed):
--   • parts.reorder_level ALREADY exists (0001) — reused as the default.
--   • engine_models had no reorder level → added here. Engines are serialized,
--     so "low" = COUNT of in-stock units for that MODEL vs the threshold.
--   • Nothing linked a product to a supplier (suppliers only reached through
--     receivings) → preferred_supplier_id added, falling back to the most
--     recent supplier that actually delivered the item.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Thresholds + supplier hints
-- ---------------------------------------------------------------------------
alter table public.engine_models
  add column if not exists reorder_level int not null default 0
    check (reorder_level >= 0);

alter table public.parts
  add column if not exists preferred_supplier_id uuid references public.suppliers(id);
alter table public.engine_models
  add column if not exists preferred_supplier_id uuid references public.suppliers(id);

-- Per-shop override of a product's reorder level. No row = use the product
-- default (master usually needs a bigger buffer than a branch).
create table if not exists public.shop_reorder_levels (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  part_id uuid references public.parts(id) on delete cascade,
  engine_model_id uuid references public.engine_models(id) on delete cascade,
  reorder_level int not null default 0 check (reorder_level >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint shop_reorder_item check ((part_id is null) <> (engine_model_id is null))
);

create unique index if not exists shop_reorder_part_uq
  on public.shop_reorder_levels (shop_id, part_id) where part_id is not null and deleted_at is null;
create unique index if not exists shop_reorder_model_uq
  on public.shop_reorder_levels (shop_id, engine_model_id) where engine_model_id is not null and deleted_at is null;

-- ---------------------------------------------------------------------------
-- 2. Delivery requests (shop → owner). A REQUEST, not a stock mutation: it
--    never touches stock and never enters the sales Approval Queue. The owner
--    converts it into the EXISTING delivery flow.
-- ---------------------------------------------------------------------------
create table if not exists public.delivery_requests (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id),
  status text not null default 'open' check (status in ('open','fulfilled','dismissed')),
  note text,
  owner_note text,
  requested_by uuid not null references public.profiles(id),
  fulfilled_delivery_id uuid references public.deliveries(id),
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.delivery_request_lines (
  id uuid primary key default gen_random_uuid(),
  delivery_request_id uuid not null references public.delivery_requests(id) on delete cascade,
  part_id uuid references public.parts(id),
  engine_model_id uuid references public.engine_models(id),
  qty_requested int not null check (qty_requested > 0),
  note text,
  created_at timestamptz not null default now(),
  constraint delivery_request_line_item check ((part_id is null) <> (engine_model_id is null))
);

create index if not exists idx_delivery_requests_shop_status
  on public.delivery_requests (shop_id, status);

-- ---------------------------------------------------------------------------
-- 3. Notifications — the RECORD is channel-independent. Delivery fans out to
--    enabled channels via notification_dispatches, so adding SMS later is
--    "enable the channel + run a worker over pending dispatches" — no schema
--    redesign. SMS is intentionally NOT implemented (seeded disabled).
-- ---------------------------------------------------------------------------
create table if not exists public.notification_channels (
  code text primary key,              -- 'in_app' | 'sms' | future
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.notification_channels (code, enabled) values ('in_app', true)
on conflict (code) do nothing;
insert into public.notification_channels (code, enabled) values ('sms', false)
on conflict (code) do nothing;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_role text not null check (recipient_role in ('owner','shop')),
  -- For recipient_role='shop' this is the RECIPIENT. For 'owner' it is
  -- CONTEXT (which shop the alert is about; null = master), so the owner can
  -- get one alert per shop instead of them collapsing into one.
  -- Visibility is decided by recipient_role in RLS, never by this column.
  shop_id uuid references public.shops(id) on delete cascade,
  type text not null check (type in (
    'master_low_stock','shop_low_stock','delivery_request',
    'delivery_request_fulfilled','delivery_request_dismissed'
  )),
  title text not null,
  body text,
  ref_table text,
  ref_id uuid,
  read_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- a shop notification must name its shop; an owner one may carry context
  constraint notification_scope check (
    recipient_role = 'owner'
    or (recipient_role = 'shop' and shop_id is not null)
  )
);

create index if not exists idx_notifications_owner
  on public.notifications (recipient_role, created_at desc) where deleted_at is null;
create index if not exists idx_notifications_shop
  on public.notifications (shop_id, created_at desc) where deleted_at is null;
-- powers the "one open notification per recipient+product+scope" dedupe
create index if not exists idx_notifications_dedupe
  on public.notifications (recipient_role, type, ref_table, ref_id, shop_id)
  where read_at is null and deleted_at is null;

create table if not exists public.notification_dispatches (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  channel text not null references public.notification_channels(code),
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped')),
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists idx_dispatches_pending
  on public.notification_dispatches (channel, status) where status = 'pending';

do $$
declare t text;
begin
  foreach t in array array[
    'shop_reorder_levels','delivery_requests','notification_channels'
  ] loop
    execute format(
      'drop trigger if exists set_updated_at on public.%I;
       create trigger set_updated_at before update on public.%I
       for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. RLS
-- ---------------------------------------------------------------------------
alter table public.shop_reorder_levels enable row level security;
alter table public.delivery_requests enable row level security;
alter table public.delivery_request_lines enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_channels enable row level security;
alter table public.notification_dispatches enable row level security;

-- thresholds: owner CRUD; shops never edit (they read the effective value
-- through the safe view only)
drop policy if exists shop_reorder_owner_all on public.shop_reorder_levels;
create policy shop_reorder_owner_all on public.shop_reorder_levels for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

-- requests: shop reads its own, owner reads all; writes go through definer fns
drop policy if exists delivery_requests_select on public.delivery_requests;
create policy delivery_requests_select on public.delivery_requests for select
  to authenticated using (
    public.is_owner() or shop_id = public.auth_shop_id()
  );
drop policy if exists delivery_requests_owner_write on public.delivery_requests;
create policy delivery_requests_owner_write on public.delivery_requests for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists delivery_request_lines_select on public.delivery_request_lines;
create policy delivery_request_lines_select on public.delivery_request_lines for select
  to authenticated using (
    exists (select 1 from public.delivery_requests r
            where r.id = delivery_request_id
              and (public.is_owner() or r.shop_id = public.auth_shop_id()))
  );
drop policy if exists delivery_request_lines_owner_write on public.delivery_request_lines;
create policy delivery_request_lines_owner_write on public.delivery_request_lines for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

-- notifications: strictly the intended recipient
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select
  to authenticated using (
    deleted_at is null
    and (
      (recipient_role = 'owner' and public.is_owner())
      or (recipient_role = 'shop' and shop_id = public.auth_shop_id())
    )
  );

drop policy if exists channels_owner_all on public.notification_channels;
create policy channels_owner_all on public.notification_channels for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists dispatches_owner_all on public.notification_dispatches;
create policy dispatches_owner_all on public.notification_dispatches for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

-- ---------------------------------------------------------------------------
-- 5. Low-stock views (always computed — never stored flags, so never stale)
-- ---------------------------------------------------------------------------

-- MASTER shortages → buy from a supplier. Owner-only.
drop view if exists public.master_low_stock;
create view public.master_low_stock
with (security_barrier = true) as
select
  'part'::text                       as kind,
  p.id                               as product_id,
  p.name,
  p.sku,
  p.barcode,
  p.unit,
  coalesce(sl.qty, 0)                as on_hand,
  p.reorder_level                    as threshold,
  greatest(p.reorder_level - coalesce(sl.qty, 0), 0) as shortfall,
  sup.id                             as supplier_id,
  sup.name                           as supplier_name,
  sup.contact                        as supplier_contact
from public.parts p
left join public.stock_levels sl on sl.part_id = p.id and sl.shop_id is null
left join lateral (
  select r.supplier_id
  from public.receiving_lines rl
  join public.receivings r on r.id = rl.receiving_id
  where rl.part_id = p.id and r.supplier_id is not null and r.deleted_at is null
  order by r.received_at desc
  limit 1
) last_sup on true
left join public.suppliers sup
  on sup.id = coalesce(p.preferred_supplier_id, last_sup.supplier_id)
 and sup.deleted_at is null
where p.deleted_at is null
  and p.reorder_level > 0
  and coalesce(sl.qty, 0) <= p.reorder_level
  and public.is_owner()

union all

select
  'engine_model'::text,
  em.id,
  em.brand || ' ' || em.model,
  null, null,
  'unit',
  count(e.id)::int,
  em.reorder_level,
  greatest(em.reorder_level - count(e.id)::int, 0),
  sup.id, sup.name, sup.contact
from public.engine_models em
left join public.engines e
  on e.engine_model_id = em.id and e.status = 'in_master' and e.deleted_at is null
left join lateral (
  select r.supplier_id
  from public.receiving_lines rl
  join public.receivings r on r.id = rl.receiving_id
  join public.engines e2 on e2.id = rl.engine_id
  where e2.engine_model_id = em.id and r.supplier_id is not null and r.deleted_at is null
  order by r.received_at desc
  limit 1
) last_sup on true
left join public.suppliers sup
  on sup.id = coalesce(em.preferred_supplier_id, last_sup.supplier_id)
 and sup.deleted_at is null
where em.deleted_at is null
  and em.reorder_level > 0
  and public.is_owner()
group by em.id, em.brand, em.model, em.reorder_level, sup.id, sup.name, sup.contact
having count(e.id) <= em.reorder_level;

-- SHOP shortages → request a delivery. Owner sees every shop; a shop sees only
-- itself. NO cost columns anywhere in this shape.
drop view if exists public.shop_low_stock;
create view public.shop_low_stock
with (security_barrier = true) as
select
  sl.shop_id,
  sh.name                                            as shop_name,
  'part'::text                                       as kind,
  p.id                                               as product_id,
  p.name,
  p.unit,
  sl.qty                                             as on_hand,
  coalesce(sro.reorder_level, p.reorder_level)       as threshold,
  greatest(coalesce(sro.reorder_level, p.reorder_level) - sl.qty, 0) as shortfall,
  (sro.id is not null)                               as threshold_is_override
from public.stock_levels sl
join public.shops sh on sh.id = sl.shop_id and sh.deleted_at is null
join public.parts p on p.id = sl.part_id and p.deleted_at is null
left join public.shop_reorder_levels sro
  on sro.shop_id = sl.shop_id and sro.part_id = p.id and sro.deleted_at is null
where sl.shop_id is not null
  and coalesce(sro.reorder_level, p.reorder_level) > 0
  and sl.qty <= coalesce(sro.reorder_level, p.reorder_level)
  and (public.is_owner() or sl.shop_id = public.auth_shop_id())

union all

select
  sh.id,
  sh.name,
  'engine_model'::text,
  em.id,
  em.brand || ' ' || em.model,
  'unit',
  count(e.id)::int,
  coalesce(sro.reorder_level, em.reorder_level),
  greatest(coalesce(sro.reorder_level, em.reorder_level) - count(e.id)::int, 0),
  (sro.id is not null)
from public.shops sh
cross join public.engine_models em
left join public.engines e
  on e.engine_model_id = em.id and e.shop_id = sh.id
 and e.status = 'delivered' and e.deleted_at is null
left join public.shop_reorder_levels sro
  on sro.shop_id = sh.id and sro.engine_model_id = em.id and sro.deleted_at is null
where sh.deleted_at is null
  and em.deleted_at is null
  and (public.is_owner() or sh.id = public.auth_shop_id())
group by sh.id, sh.name, em.id, em.brand, em.model, em.reorder_level, sro.reorder_level, sro.id
having coalesce(sro.reorder_level, em.reorder_level) > 0
   and count(e.id) <= coalesce(sro.reorder_level, em.reorder_level)
   -- don't list every model for every shop: only ones the shop stocks or has
   -- an explicit threshold for
   and (count(e.id) > 0 or sro.id is not null);

-- Employee-facing alias (already shop-scoped + cost-free), mirroring the
-- shop_stock / shop_engines / shop_receivables pattern.
drop view if exists public.shop_low_stock_safe;
create view public.shop_low_stock_safe
with (security_barrier = true) as
select * from public.shop_low_stock;

revoke all on public.master_low_stock from anon;
revoke all on public.shop_low_stock from anon;
revoke all on public.shop_low_stock_safe from anon;
grant select on public.master_low_stock to authenticated;
grant select on public.shop_low_stock to authenticated;
grant select on public.shop_low_stock_safe to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Realtime so the bell + request lists update live
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.notifications;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.delivery_requests;
exception when duplicate_object then null; end $$;
