-- 0067 — a shop can see sibling branches as transfer destinations
--
-- BUG: the shop "Send stock" picker read `public.shops` directly, but the
-- `shops_select` RLS policy (0002) scopes an employee to its OWN shop only
-- (id = auth_shop_id()). So the destination list only ever contained the
-- caller's own shop, which the page then filters out → "no other shops to
-- transfer to". The transfer RPC works (it's SECURITY DEFINER and takes a
-- shop id), but the picker had nothing to pick — broken since 0054.
--
-- Fix with the app's safe-view pattern: a security_barrier view exposing ONLY
-- basic identity (id, name, color_key) of active, live shops. Nothing here is
-- more than the transfer slip already shows a party (name + location). The
-- owner keeps full `shops` access via shops_select; this is the shop's picker.

create or replace view public.shop_transfer_destinations
with (security_barrier = true) as
select id, name, color_key
from public.shops
where active = true and deleted_at is null;
revoke all on public.shop_transfer_destinations from anon;
grant select on public.shop_transfer_destinations to authenticated;
