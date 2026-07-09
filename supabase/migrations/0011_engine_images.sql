-- ============================================================================
-- 0011_engine_images.sql — Engines get photos too (per serial unit, which
-- also lets second-hand units show their actual condition).
-- Same bucket + RLS as parts: object path {engineId}.webp in product-images.
-- ============================================================================

alter table public.engines add column if not exists image_path text;

-- shop_engines view: add image_path (drop + recreate, column list changes)
drop view if exists public.shop_engines;

create view public.shop_engines
with (security_barrier = true) as
select
  e.id as engine_id,
  e.serial_number,
  em.brand,
  em.model,
  em.horsepower,
  em.stroke,
  e.condition,
  e.price_centavos,      -- selling price only
  e.status,
  e.shop_id,
  e.image_path
from public.engines e
join public.engine_models em on em.id = e.engine_model_id
where e.deleted_at is null
  and e.status = 'delivered'
  and e.shop_id is not null
  and (public.is_owner() or e.shop_id = public.auth_shop_id());

revoke all on public.shop_engines from anon;
grant select on public.shop_engines to authenticated;
