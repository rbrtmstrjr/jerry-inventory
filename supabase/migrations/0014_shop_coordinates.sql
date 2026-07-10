-- ============================================================================
-- 0014_shop_coordinates.sql — optional map pin per shop.
-- ============================================================================
alter table public.shops add column if not exists latitude double precision;
alter table public.shops add column if not exists longitude double precision;
