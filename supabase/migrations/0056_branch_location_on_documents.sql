-- 0056_branch_location_on_documents.sql — put each BRANCH's identity (name +
-- LOCATION) on the customer documents a shop hands out.
-- ============================================================================
-- The business name/address (Jerry's Marine, from public_settings) is the same
-- letterhead on every document. But a customer holding a receipt or warranty
-- should be able to tell WHICH branch issued it — the branch name and its
-- location. The receipt already carried the shop name (and fetches location);
-- the warranty certificate carried only the shop name.
--
-- This migration adds the selling shop's `location` to the two SHOP-facing
-- warranty sources so the certificate is self-contained (same pattern as
-- transfer_slip's from/to locations):
--   • shop_warranties          — the reprint view (append-only column)
--   • fn_shop_warranty_preview — the point-of-sale cert (0055)
--
-- The owner cert page reads the base tables and simply embeds shops.location —
-- no DB change needed there. Nothing here is sensitive: a shop already reads
-- its own shop row (name + location) via `shops_select`.
-- ============================================================================

-- 1) shop_warranties — expose the selling shop's location. `create or replace
--    view` may append columns at the end, so the existing column list is
--    reproduced verbatim (0031) with `shop_location` added last.
create or replace view public.shop_warranties
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
  sa.receipt_no,
  sh.location                              as shop_location
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

-- 2) fn_shop_warranty_preview — add shop_location. Adding a column to a
--    RETURNS TABLE changes the return type, which create-or-replace refuses,
--    so drop then recreate. Body is byte-identical to 0055 apart from the new
--    sh.location column (guard, terms, void-with-sale all unchanged).
drop function if exists public.fn_shop_warranty_preview(uuid);

create or replace function public.fn_shop_warranty_preview(p_sale_id uuid)
returns table (
  engine_id uuid,
  serial_number text,
  condition text,
  brand text,
  model text,
  horsepower numeric,
  stroke text,
  customer_name text,
  customer_phone text,
  customer_address text,
  shop_name text,
  shop_location text,
  sold_on date,
  months int,
  expires_on date
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_default_months int;
begin
  select sa.shop_id into v_shop
  from public.sales sa
  where sa.id = p_sale_id and sa.deleted_at is null;

  if v_shop is null then
    return;
  end if;

  if not (public.is_owner() or v_shop = public.auth_shop_id()) then
    raise exception 'Not authorized to view this warranty';
  end if;

  select s.default_warranty_months into v_default_months
  from public.settings s where s.id = 1;

  return query
  select
    e.id,
    e.serial_number,
    e.condition,
    em.brand,
    em.model,
    em.horsepower,
    em.stroke,
    c.name,
    c.phone,
    c.address,
    sh.name,
    sh.location,
    sa.business_date,
    coalesce(e.warranty_months, em.default_warranty_months, v_default_months, 12),
    (sa.business_date
       + (coalesce(e.warranty_months, em.default_warranty_months, v_default_months, 12)
          || ' months')::interval)::date
  from public.sales sa
  join public.sale_lines l on l.sale_id = sa.id and l.engine_id is not null
  join public.engines e on e.id = l.engine_id
  join public.engine_models em on em.id = e.engine_model_id
  join public.shops sh on sh.id = sa.shop_id
  left join public.customers c on c.id = sa.customer_id
  where sa.id = p_sale_id and sa.deleted_at is null
  order by e.serial_number;
end;
$$;

revoke all on function public.fn_shop_warranty_preview(uuid) from public, anon;
grant execute on function public.fn_shop_warranty_preview(uuid) to authenticated;
