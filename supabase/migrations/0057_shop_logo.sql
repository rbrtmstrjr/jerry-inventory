-- 0057_shop_logo.sql — a per-branch LOGO on the customer documents.
-- ============================================================================
-- The owner can upload a logo when creating/editing a shop. It replaces the
-- generic anchor on the two documents the shop hands a customer — the sale
-- receipt and the warranty certificate — so each branch's paper carries its own
-- mark. No logo → the anchor stays (unchanged default).
--
-- Storage: the image lives in the existing public `product-images` bucket
-- (owner-only writes, public read — same policies as product photos), so no new
-- bucket or storage policy is needed. `shops.logo_path` holds only the object
-- path, exactly like `parts.image_path`.
--
-- Like the branch location (0056), the logo path is threaded onto the two
-- shop-facing warranty sources so the certificate stays self-contained:
--   • shop_warranties          (append `shop_logo_path`)
--   • fn_shop_warranty_preview (drop+recreate to widen the return)
-- The owner cert page and the receipt read the shop row directly and embed it.
-- Nothing sensitive: the logo is public-read and a shop already reads its own
-- shop row.
-- ============================================================================

alter table public.shops add column if not exists logo_path text;

-- shop_warranties — reproduce 0056's column list, append shop_logo_path last.
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
  sh.location                              as shop_location,
  sh.logo_path                             as shop_logo_path
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

-- fn_shop_warranty_preview — add shop_logo_path (return type widens → drop first).
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
  shop_logo_path text,
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
    sh.logo_path,
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
