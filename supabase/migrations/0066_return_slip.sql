-- 0066 — printable Return Slip (the document a return travels with)
--
-- Mirrors the Stock Transfer Slip (0054): a party-scoped view is the gate, so
-- the /return/[id]/slip page (outside every role group, like /receipt and
-- /transfer/[id]/slip) reads it with the caller's own session — a non-party
-- (or anon) reads no row → notFound(). A return always goes shop → master, so
-- there is one party besides the owner: the returning shop. No cost columns.

create or replace view public.return_slip
with (security_barrier = true) as
select
  r.id,
  r.shop_id, s.name as shop_name, s.location as shop_location,
  r.reason, r.status, r.review_note,
  r.created_at as requested_at, r.approved_at,
  rq.full_name as requested_by_name,
  ap.full_name as approved_by_name
from public.returns r
join public.shops s on s.id = r.shop_id
left join public.profiles rq on rq.id = r.requested_by
left join public.profiles ap on ap.id = r.approved_by
where r.deleted_at is null
  and (public.is_owner() or r.shop_id = public.auth_shop_id());
revoke all on public.return_slip from anon;
grant select on public.return_slip to authenticated;

create or replace view public.return_slip_lines
with (security_barrier = true) as
select
  rl.id, rl.return_id,
  coalesce(p.name, em.brand || ' ' || em.model) as name,
  p.sku, coalesce(p.unit, 'unit') as unit,
  e.serial_number,
  rl.qty, rl.qty_damaged,
  rl.qty - coalesce(rl.qty_damaged, 0) as qty_good
from public.return_lines rl
join public.returns r on r.id = rl.return_id and r.deleted_at is null
left join public.parts p on p.id = rl.part_id
left join public.engines e on e.id = rl.engine_id
left join public.engine_models em on em.id = e.engine_model_id
where public.is_owner() or r.shop_id = public.auth_shop_id();
revoke all on public.return_slip_lines from anon;
grant select on public.return_slip_lines to authenticated;
