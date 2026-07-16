-- ============================================================================
-- 0031_shop_warranties.sql — shops can see the warranties they SOLD.
--
-- Access model (strict):
--   • Shop  → read-only, ONLY warranties whose originating sale is theirs.
--             A shop cannot look up a serial it didn't sell — not even
--             read-only. No edit / void / extend / claim path exists for them.
--   • Owner → everything (unchanged), via the base tables.
--
-- Verified before writing: `warranties.sale_id` exists and every row has one,
-- so the selling shop is derivable as warranties → sales.shop_id. No
-- denormalised shop_id is needed.
--
-- Near-expiry threshold is configurable (settings.warranty_expiry_alert_days,
-- default 30) rather than hardcoded.
-- ============================================================================

alter table public.settings
  add column if not exists warranty_expiry_alert_days int not null default 30
    check (warranty_expiry_alert_days >= 0);

-- Stable helper so the view/function don't each re-read settings inline.
create or replace function public.fn_warranty_alert_days()
returns int
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select warranty_expiry_alert_days from settings where id = 1), 30);
$$;

revoke all on function public.fn_warranty_alert_days() from public, anon;
grant execute on function public.fn_warranty_alert_days() to authenticated;

-- ---------------------------------------------------------------------------
-- shop_warranties — the shop's ONLY window onto warranties.
-- Scoped through the originating sale; owner sees all. No cost/margin columns
-- anywhere (mirrors shop_stock / shop_engines / shop_receivables).
-- The INNER join to sales is deliberate: a warranty with no sale has no
-- selling shop and therefore no shop may see it.
-- ---------------------------------------------------------------------------
drop view if exists public.shop_warranties;

create view public.shop_warranties
with (security_barrier = true) as
select
  w.id,
  w.engine_id,
  sa.shop_id,
  sh.name                                  as shop_name,
  e.serial_number,
  e.condition,
  em.brand,
  em.model,
  em.horsepower,
  em.stroke,
  c.name                                   as customer_name,
  c.phone                                  as customer_phone,
  c.address                                as customer_address,
  w.sold_on,
  w.months,
  w.expires_on,
  (w.expires_on - public.ph_today())       as days_left,
  (w.expires_on >= public.ph_today())      as active,
  (w.expires_on >= public.ph_today()
   and w.expires_on <= public.ph_today() + public.fn_warranty_alert_days())
                                           as expiring_soon,
  w.sale_id,
  sa.receipt_no
from public.warranties w
join public.sales sa on sa.id = w.sale_id and sa.deleted_at is null
join public.shops sh on sh.id = sa.shop_id
join public.engines e on e.id = w.engine_id
join public.engine_models em on em.id = e.engine_model_id
left join public.customers c on c.id = w.customer_id
where w.deleted_at is null
  and (public.is_owner() or sa.shop_id = public.auth_shop_id());

revoke all on public.shop_warranties from anon;
grant select on public.shop_warranties to authenticated;

-- ---------------------------------------------------------------------------
-- Notification type
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'master_low_stock','shop_low_stock','delivery_request',
  'delivery_request_fulfilled','delivery_request_dismissed',
  'utang_payment','utang_payment_voided',
  'delivery_incoming','delivery_confirmed','delivery_discrepancy',
  'warranty_expiring'
));

-- ---------------------------------------------------------------------------
-- Daily near-expiry check. Warranties expire on a DATE, so evaluating once a
-- day in PH time is sufficient — no need to check on every request.
-- Dedupe comes free from fn_notify: at most one UNREAD notification per
-- (recipient, type, ref, shop), so a warranty sitting in the window all month
-- never re-spams.
-- Returns the number of warranties in the window.
-- ---------------------------------------------------------------------------
create or replace function public.fn_check_warranty_expiry()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_days int;
  v_n int := 0;
begin
  v_days := public.fn_warranty_alert_days();

  for r in
    select w.id,
           w.expires_on,
           (w.expires_on - public.ph_today()) as days_left,
           e.serial_number,
           em.brand, em.model,
           sa.shop_id,
           sh.name as shop_name,
           c.name as customer_name
    from warranties w
    join sales sa on sa.id = w.sale_id and sa.deleted_at is null
    join shops sh on sh.id = sa.shop_id
    join engines e on e.id = w.engine_id
    join engine_models em on em.id = e.engine_model_id
    left join customers c on c.id = w.customer_id
    where w.deleted_at is null
      and w.expires_on >= public.ph_today()
      and w.expires_on <= public.ph_today() + v_days
  loop
    -- the selling shop faces the customer
    perform public.fn_notify(
      'shop', r.shop_id, 'warranty_expiring',
      r.brand || ' ' || r.model || ' warranty expires in ' || r.days_left || ' day(s)',
      'SN ' || r.serial_number || coalesce(' · ' || r.customer_name, '')
        || ' · expires ' || to_char(r.expires_on, 'Mon DD, YYYY'),
      'warranties', r.id);

    -- the owner sees everything
    perform public.fn_notify(
      'owner', r.shop_id, 'warranty_expiring',
      r.brand || ' ' || r.model || ' warranty expiring at ' || coalesce(r.shop_name, 'a shop'),
      'SN ' || r.serial_number || ' · ' || r.days_left || ' day(s) left · expires '
        || to_char(r.expires_on, 'Mon DD, YYYY'),
      'warranties', r.id);

    v_n := v_n + 1;
  end loop;

  return v_n;
end $$;

-- Only the scheduler / service role runs this — never a logged-in user.
revoke all on function public.fn_check_warranty_expiry() from public, anon, authenticated;
grant execute on function public.fn_check_warranty_expiry() to service_role;
