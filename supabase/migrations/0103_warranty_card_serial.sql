-- ---------------------------------------------------------------------------
-- 0103 — Physical warranty cards: record the card number, retire the
-- in-app certificate (the 0082 suki-card pattern, applied to warranties).
--
-- Gerwin prints physical warranty cards in a SEPARATE external system. The
-- card handed to the customer is THE warranty document, so the app stops
-- printing certificates entirely (shop list print, the certificate pages,
-- and the point-of-sale preview all leave with this migration's app code).
-- What the app does instead is RECORD which physical card belongs to which
-- engine sale: `warranties.warranty_serial`, editable by the selling shop
-- and the office, unique across all cards.
--
-- A claim-replacement repoints the warranty to the new engine (0070) but the
-- row — and therefore the recorded card — stays, which is exactly right: the
-- customer keeps the same physical card.
-- ---------------------------------------------------------------------------

alter table public.warranties add column if not exists warranty_serial text;

-- one physical card, one warranty — case-insensitive
create unique index if not exists warranties_warranty_serial_unique
  on public.warranties (upper(warranty_serial))
  where warranty_serial is not null;

-- ── the recorder: selling shop or office, upper+trim, clear with empty ──────
create or replace function public.fn_set_warranty_serial(
  p_warranty_id uuid,
  p_serial text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_clean text;
begin
  select sa.shop_id into v_shop
  from warranties w
  join sales sa on sa.id = w.sale_id and sa.deleted_at is null
  where w.id = p_warranty_id and w.deleted_at is null;
  if v_shop is null then
    raise exception 'Warranty not found';
  end if;

  if not (public.is_owner() or v_shop = public.auth_shop_id()) then
    raise exception 'You can only record card numbers for your own shop''s warranties';
  end if;

  v_clean := nullif(upper(trim(coalesce(p_serial, ''))), '');
  begin
    update warranties set warranty_serial = v_clean where id = p_warranty_id;
  exception when unique_violation then
    raise exception 'Card number % is already recorded on another warranty', v_clean;
  end;
end $$;

revoke all on function public.fn_set_warranty_serial(uuid, text) from public, anon;
grant execute on function public.fn_set_warranty_serial(uuid, text) to authenticated;

-- ── shop_warranties: append the card number (0057 body + warranty_serial) ───
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
  sh.logo_path                             as shop_logo_path,
  w.warranty_serial
from public.warranties w
join public.sales sa on sa.id = w.sale_id and sa.deleted_at is null
join public.shops sh on sh.id = sa.shop_id
join public.engines e on e.id = w.engine_id
join public.engine_models em on em.id = e.engine_model_id
left join public.customers c on c.id = w.customer_id
where w.deleted_at is null
  and (public.is_owner() or sa.shop_id = public.auth_shop_id());

-- ── warranty_registry: card number appended + searchable (0084 body) ────────
create or replace view public.warranty_registry
with (security_barrier = true) as
select
  w.id,
  w.engine_id,
  e.serial_number,
  trim(concat_ws(' ', em.brand, em.model))        as model,
  em.horsepower,
  c.name                                          as customer,
  c.phone                                         as customer_phone,
  sh.name                                         as shop,
  sh.color_key                                    as shop_color_key,
  w.sold_on,
  w.months,
  w.expires_on,
  (w.expires_on >= public.ph_today())             as active,
  (select count(*) from public.warranty_claims wc
    where wc.warranty_id = w.id and wc.deleted_at is null) as claims_count,
  lower(concat_ws(' ', e.serial_number, c.name, c.phone, em.brand, em.model, sh.name, w.warranty_serial))
                                                  as search_text,
  w.warranty_serial
from public.warranties w
left join public.engines e        on e.id = w.engine_id
left join public.engine_models em on em.id = e.engine_model_id
left join public.customers c      on c.id = w.customer_id
left join public.sales s          on s.id = w.sale_id
left join public.shops sh         on sh.id = s.shop_id
where w.deleted_at is null
  and public.is_owner();

-- ── the point-of-sale certificate preview leaves with the certificates ──────
drop function if exists public.fn_shop_warranty_preview(uuid);
