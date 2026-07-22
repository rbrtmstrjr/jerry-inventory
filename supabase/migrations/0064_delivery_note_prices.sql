-- 0064 — cost + selling price on the shop's incoming delivery lines
--
-- The delivery note now prints per-line cost + selling price and a total (at
-- cost and at selling), on BOTH the owner's and the shop's copy. The owner's
-- note reads master (`parts`/`engines`) directly; the SHOP's note reads the
-- safe view below, which never exposed price/cost — so add them here.
--
-- This extends the 0053 narrowing ("a shop may see the cost of its OWN on-hand
-- stock, read-only") to the delivery note the shop receives — at the owner's
-- request. Prices are read LIVE from master (no capture at delivery). Two
-- columns appended at the end so CREATE OR REPLACE is valid.

create or replace view public.shop_incoming_delivery_lines
with (security_barrier = true) as
select
  dl.id, dl.delivery_id, d.shop_id, dl.part_id, dl.engine_id,
  coalesce(p.name, em.brand || ' ' || em.model) as name,
  coalesce(p.unit, 'unit')                      as unit,
  e.serial_number,
  dl.qty                                        as qty_sent,
  dl.qty_received, dl.qty_outstanding, dl.shop_note,
  d.from_shop_id,
  coalesce(p.cost_centavos, e.cost_centavos)    as cost_centavos,
  coalesce(p.price_centavos, e.price_centavos)  as price_centavos
from public.delivery_lines dl
join public.deliveries d on d.id = dl.delivery_id and d.deleted_at is null
  and d.status in ('in_transit','confirmed','discrepancy','resolved')
left join public.parts p on p.id = dl.part_id
left join public.engines e on e.id = dl.engine_id
left join public.engine_models em on em.id = e.engine_model_id
where public.is_owner() or d.shop_id = public.auth_shop_id();

revoke all on public.shop_incoming_delivery_lines from anon;
grant select on public.shop_incoming_delivery_lines to authenticated;
