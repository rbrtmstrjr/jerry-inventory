-- 0081: shop-safe delivery-request line names
--
-- The shop's Low Stock → My Requests tab lists what it asked Admin to deliver.
-- delivery_request_lines point at the OWNER-ONLY parts / engine_models tables,
-- so the shop's own `delivery_request_lines(parts(name))` embed resolved to
-- NULL under RLS and every catalog item rendered as the 0077 "New product"
-- custom-line fallback — only the free-text custom_name lines showed correctly.
--
-- Fix it the way every other shop-facing name is resolved: a security_barrier
-- view owned by the table owner reads parts / engine_models past their
-- owner-only RLS (same mechanism as shop_stock), projecting ONLY the resolved
-- name and scoping every row to the caller's own shop. No cost, no catalog
-- browsing — just the name of a line the shop itself requested.

create or replace view public.shop_delivery_request_lines
with (security_barrier = true) as
select
  drl.delivery_request_id,
  drl.qty_requested,
  drl.note,
  drl.custom_name,
  drl.engine_model_id is not null                       as is_engine,
  (drl.part_id is null and drl.engine_model_id is null) as is_custom,
  coalesce(
    p.name,
    nullif(trim(coalesce(em.brand, '') || ' ' || coalesce(em.model, '')), ''),
    drl.custom_name
  )                                                     as name
from public.delivery_request_lines drl
join public.delivery_requests dr on dr.id = drl.delivery_request_id
left join public.parts p on p.id = drl.part_id
left join public.engine_models em on em.id = drl.engine_model_id
where dr.deleted_at is null
  and (public.is_owner() or dr.shop_id = public.auth_shop_id());

revoke all on public.shop_delivery_request_lines from anon;
grant select on public.shop_delivery_request_lines to authenticated;
