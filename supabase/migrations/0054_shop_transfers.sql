-- ============================================================================
-- 0054 — Shop-to-shop transfers, reusing the delivery/transit model.
--
-- A transfer is a delivery whose SOURCE is a shop instead of master. We
-- generalize `deliveries` with `from_shop_id` (NULL = master, exactly today's
-- behavior) and reuse everything: the transit lifecycle (0028), the generated
-- in-transit bucket (delivery_lines.qty_outstanding), shop confirmation
-- (fn_confirm_delivery — already scopes to the destination and needs NO
-- change), and the movement types delivery / transit_return / transit_writeoff.
--
-- THE LEDGER INVARIANT SURVIVES BY CONSTRUCTION. The journal already relocates
-- transit_writeoff to the synthetic 'transit' location shop-AGNOSTICALLY
-- (0045: the movement_type branch is tested before any shop_id check) and the
-- stock card excludes transit_writeoff by type — so booking a transfer
-- write-off at shop_id = SOURCE keeps Σ movements(source) = stock_levels(source)
-- exactly as a master write-off keeps master whole. The legs:
--   approve  : stock_levels(source) −qty · delivery −qty @ source
--   confirm  : stock_levels(dest)  +recv · delivery +recv @ dest   (unchanged fn)
--   → source : stock_levels(source) +qty · transit_return +qty @ source
--   → writeoff: (no stock write)         · transit_writeoff −qty @ source
-- No new movement types. from_shop_id defaults NULL → every existing delivery
-- is untouched (0028-style backfill). No CHECK that could reject live rows.
-- ============================================================================

-- ── 1. generalize deliveries ────────────────────────────────────────────────
alter table public.deliveries
  add column if not exists from_shop_id uuid references public.shops(id),
  add column if not exists requested_by uuid references public.profiles(id),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists review_note text;   -- owner's approve/reject note

-- no transfer to self
alter table public.deliveries
  drop constraint if exists deliveries_no_self_transfer;
alter table public.deliveries
  add constraint deliveries_no_self_transfer
    check (from_shop_id is null or from_shop_id <> shop_id);

-- pre-approval states used ONLY by transfers (master deliveries are still born
-- directly as in_transit and never touch these)
alter table public.deliveries drop constraint if exists deliveries_status_check;
alter table public.deliveries add constraint deliveries_status_check
  check (status in ('requested','in_transit','confirmed','discrepancy','resolved','rejected','cancelled'));

create index if not exists idx_deliveries_from_shop on public.deliveries (from_shop_id) where from_shop_id is not null;

comment on column public.deliveries.from_shop_id is
  'Transfer source shop. NULL = master (a normal owner delivery). A transfer
   is a delivery whose source is a shop; the whole transit lifecycle is reused.';

-- ── 2. discrepancy resolution gains returned_to_source ──────────────────────
alter table public.delivery_discrepancies drop constraint if exists delivery_discrepancies_resolution_check;
alter table public.delivery_discrepancies add constraint delivery_discrepancies_resolution_check
  check (resolution in ('returned_to_master','returned_to_source','written_off'));

-- ── 3. notification types for the transfer lifecycle ────────────────────────
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'master_low_stock','shop_low_stock','delivery_request',
    'delivery_request_fulfilled','delivery_request_dismissed',
    'utang_payment','utang_payment_voided',
    'delivery_incoming','delivery_confirmed','delivery_discrepancy',
    'warranty_expiring',
    'supplier_limit_warning','supplier_limit_reached','supplier_payment_overdue',
    'transfer_requested','transfer_approved','transfer_rejected'
  ));

-- ── 4. fn_request_transfer — source shop requests; NO stock moves ───────────
create or replace function public.fn_request_transfer(
  p_to_shop_id uuid,
  p_lines jsonb,
  p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_delivery_id uuid;
  r record;
  v_status public.engine_status;
  v_qty int;
  v_count int := 0;
  v_to_name text;
begin
  select shop_id into v_from from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_from is null then
    raise exception 'Only shop staff can send a transfer';
  end if;
  if p_to_shop_id = v_from then
    raise exception 'Cannot transfer to your own shop';
  end if;
  if not exists (select 1 from shops where id = p_to_shop_id and active and deleted_at is null) then
    raise exception 'Destination shop not found or inactive';
  end if;

  insert into deliveries (shop_id, from_shop_id, note, created_by, requested_by, status)
  values (p_to_shop_id, v_from, p_note, auth.uid(), auth.uid(), 'requested')
  returning id into v_delivery_id;

  for r in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(part_id uuid, engine_id uuid, qty int)
  loop
    if (r.part_id is null) = (r.engine_id is null) then
      raise exception 'Each line is a part OR an engine';
    end if;

    if r.part_id is not null then
      if r.qty is null or r.qty <= 0 then
        raise exception 'Quantity must be positive';
      end if;
      select qty into v_qty from stock_levels where part_id = r.part_id and shop_id = v_from;
      if coalesce(v_qty, 0) < r.qty then
        raise exception 'You only have % of that item on hand', coalesce(v_qty, 0);
      end if;
      insert into delivery_lines (delivery_id, part_id, qty) values (v_delivery_id, r.part_id, r.qty);
    else
      select status into v_status from engines
      where id = r.engine_id and shop_id = v_from and deleted_at is null;
      if v_status is null or v_status <> 'delivered' then
        raise exception 'That engine is not at your shop';
      end if;
      if exists (
        select 1 from delivery_lines dl join deliveries d on d.id = dl.delivery_id
        where dl.engine_id = r.engine_id and d.deleted_at is null
          and d.status in ('requested','in_transit','discrepancy')
      ) then
        raise exception 'That engine is already in an open transfer';
      end if;
      if exists (
        select 1 from sale_lines sl join sales s on s.id = sl.sale_id
        where sl.engine_id = r.engine_id and s.deleted_at is null
          and s.status in ('recorded','pending','questioned')
      ) then
        raise exception 'That engine is in an open sale';
      end if;
      if exists (
        select 1 from losses lo where lo.engine_id = r.engine_id and lo.deleted_at is null
          and lo.status in ('recorded','pending','questioned')
      ) then
        raise exception 'That engine is in an open loss';
      end if;
      insert into delivery_lines (delivery_id, engine_id, qty) values (v_delivery_id, r.engine_id, 1);
    end if;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'A transfer needs at least one line';
  end if;

  select name into v_to_name from shops where id = p_to_shop_id;
  perform public.fn_notify(
    'owner', v_from, 'transfer_requested',
    'A shop wants to transfer stock',
    v_count || ' item(s) requested to move to ' || coalesce(v_to_name, 'another shop') || ' — needs your approval.',
    'deliveries', v_delivery_id);

  return v_delivery_id;
end $$;

revoke all on function public.fn_request_transfer(uuid, jsonb, text) from public, anon;
grant execute on function public.fn_request_transfer(uuid, jsonb, text) to authenticated;

-- ── 5. fn_approve_transfer — owner approves/rejects; debit source on approve ─
create or replace function public.fn_approve_transfer(
  p_delivery_id uuid,
  p_action text,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_del record;
  r record;
  v_qty int;
  v_status public.engine_status;
  v_count int := 0;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve a transfer';
  end if;
  if p_action not in ('approve','reject') then
    raise exception 'Unknown action: %', p_action;
  end if;

  select * into v_del from deliveries where id = p_delivery_id and deleted_at is null for update;
  if not found then raise exception 'Transfer not found'; end if;
  if v_del.from_shop_id is null then
    raise exception 'That is a master delivery, not a transfer';
  end if;
  if v_del.status <> 'requested' then
    raise exception 'This transfer was already reviewed (status: %)', v_del.status;
  end if;

  if p_action = 'reject' then
    if coalesce(trim(p_note), '') = '' then
      raise exception 'A rejection needs a note for the shop';
    end if;
    update deliveries
    set status = 'rejected', review_note = p_note, approved_by = auth.uid(), approved_at = now()
    where id = p_delivery_id;
    perform public.fn_notify(
      'shop', v_del.from_shop_id, 'transfer_rejected',
      'Your transfer was declined',
      p_note, 'deliveries', p_delivery_id);
    return;
  end if;

  -- approve: re-check the source STILL holds every line, then debit into
  -- transit. Any shortfall aborts the whole request (no partial movement) —
  -- same preventive model as sale approval's negative-stock guard.
  for r in select * from delivery_lines where delivery_id = p_delivery_id loop
    if r.part_id is not null then
      select qty into v_qty from stock_levels
      where part_id = r.part_id and shop_id = v_del.from_shop_id for update;
      if coalesce(v_qty, 0) < r.qty then
        raise exception 'Source shop no longer has enough of a line (needs %, has %) — it may have sold since the request',
          r.qty, coalesce(v_qty, 0);
      end if;

      update stock_levels set qty = qty - r.qty
      where part_id = r.part_id and shop_id = v_del.from_shop_id;

      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
      values ('delivery', r.part_id, -r.qty, v_del.from_shop_id, auth.uid(), p_delivery_id,
              coalesce(nullif(trim(coalesce(p_note,'')),''), 'Transfer approved'));
    else
      select status into v_status from engines
      where id = r.engine_id and shop_id = v_del.from_shop_id and deleted_at is null for update;
      if v_status is null or v_status <> 'delivered' then
        raise exception 'An engine is no longer at the source shop';
      end if;

      update engines set status = 'in_transit', shop_id = v_del.shop_id where id = r.engine_id;

      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
      values ('delivery', r.engine_id, -1, v_del.from_shop_id, auth.uid(), p_delivery_id,
              coalesce(nullif(trim(coalesce(p_note,'')),''), 'Transfer approved'));
    end if;
    v_count := v_count + 1;
  end loop;

  update deliveries
  set status = 'in_transit', approved_by = auth.uid(), approved_at = now(),
      review_note = nullif(trim(coalesce(p_note,'')),'')
  where id = p_delivery_id;

  perform public.fn_notify(
    'shop', v_del.shop_id, 'delivery_incoming',
    'Stock is on the way (transfer)',
    v_count || ' item(s) transferred in — confirm what actually arrives.',
    'deliveries', p_delivery_id);
  perform public.fn_notify(
    'shop', v_del.from_shop_id, 'transfer_approved',
    'Your transfer was approved',
    v_count || ' item(s) left your shop into transit.',
    'deliveries', p_delivery_id);
end $$;

revoke all on function public.fn_approve_transfer(uuid, text, text) from public, anon;
grant execute on function public.fn_approve_transfer(uuid, text, text) to authenticated;

-- ── 6. fn_cancel_transfer — source cancels its own, only while requested ────
create or replace function public.fn_cancel_transfer(p_delivery_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from uuid;
  v_del record;
begin
  select shop_id into v_from from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_from is null then
    raise exception 'Only shop staff can cancel a transfer';
  end if;

  select * into v_del from deliveries where id = p_delivery_id and deleted_at is null for update;
  if not found then raise exception 'Transfer not found'; end if;
  if v_del.from_shop_id is distinct from v_from then
    raise exception 'That transfer is not from your shop';
  end if;
  if v_del.status <> 'requested' then
    raise exception 'Only a pending transfer can be cancelled (status: %)', v_del.status;
  end if;

  update deliveries set status = 'cancelled' where id = p_delivery_id;
end $$;

revoke all on function public.fn_cancel_transfer(uuid) from public, anon;
grant execute on function public.fn_cancel_transfer(uuid) to authenticated;

-- ── 7. fn_resolve_delivery_discrepancy — + returned_to_source; writeoff booked
--        at the delivery's from_shop (NULL for master, source for transfers) ──
create or replace function public.fn_resolve_delivery_discrepancy(
  p_delivery_line_id uuid,
  p_qty int,
  p_resolution text,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line record;
  v_del record;
  v_left int;
  v_writeoff_shop uuid;   -- NULL for master delivery, source shop for a transfer
begin
  if not public.is_owner() then
    raise exception 'Only the owner can resolve a delivery discrepancy';
  end if;
  if p_resolution not in ('returned_to_master','returned_to_source','written_off') then
    raise exception 'Unknown resolution: %', p_resolution;
  end if;

  select * into v_line from delivery_lines where id = p_delivery_line_id for update;
  if not found then raise exception 'Delivery line not found'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be positive'; end if;
  if p_qty > v_line.qty_outstanding then
    raise exception 'Only % outstanding on that line', v_line.qty_outstanding;
  end if;

  select * into v_del from deliveries where id = v_line.delivery_id for update;
  v_writeoff_shop := v_del.from_shop_id;  -- where the units were debited

  -- resolution must match the delivery type
  if v_del.from_shop_id is null and p_resolution = 'returned_to_source' then
    raise exception 'A master delivery returns to master, not to a source shop';
  end if;
  if v_del.from_shop_id is not null and p_resolution = 'returned_to_master' then
    raise exception 'A transfer returns to the source shop, not to master';
  end if;

  if v_line.part_id is not null then
    if p_resolution = 'returned_to_master' then
      insert into stock_levels (part_id, shop_id, qty)
      values (v_line.part_id, null, p_qty)
      on conflict (part_id, shop_id) do update set qty = stock_levels.qty + excluded.qty;
      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.part_id, p_qty, null, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Recovered from transit'));

    elsif p_resolution = 'returned_to_source' then
      insert into stock_levels (part_id, shop_id, qty)
      values (v_line.part_id, v_del.from_shop_id, p_qty)
      on conflict (part_id, shop_id) do update set qty = stock_levels.qty + excluded.qty;
      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.part_id, p_qty, v_del.from_shop_id, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Returned to source shop'));

    else -- written_off: it left the source and never landed. No stock write.
      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_writeoff', v_line.part_id, -p_qty, v_writeoff_shop, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Lost in transit'));
    end if;
  else
    if p_qty <> 1 then raise exception 'Engines are resolved one serial at a time'; end if;
    if p_resolution = 'returned_to_master' then
      update engines set status = 'in_master', shop_id = null where id = v_line.engine_id;
      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.engine_id, 1, null, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Recovered from transit'));

    elsif p_resolution = 'returned_to_source' then
      update engines set status = 'delivered', shop_id = v_del.from_shop_id where id = v_line.engine_id;
      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.engine_id, 1, v_del.from_shop_id, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Returned to source shop'));

    else
      update engines set deleted_at = now() where id = v_line.engine_id;
      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_writeoff', v_line.engine_id, -1, v_writeoff_shop, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Lost in transit'));
    end if;
  end if;

  insert into delivery_discrepancies (delivery_line_id, qty, resolution, reason, resolved_by)
  values (p_delivery_line_id, p_qty, p_resolution, nullif(trim(coalesce(p_reason, '')), ''), auth.uid());

  update delivery_lines set qty_resolved = qty_resolved + p_qty where id = p_delivery_line_id;

  select coalesce(sum(qty_outstanding), 0) into v_left
  from delivery_lines where delivery_id = v_line.delivery_id;
  if v_left = 0 then
    update deliveries set status = 'resolved', resolved_at = now(), resolved_by = auth.uid()
    where id = v_line.delivery_id;
  end if;
end $$;

revoke all on function public.fn_resolve_delivery_discrepancy(uuid, int, text, text) from public, anon;
grant execute on function public.fn_resolve_delivery_discrepancy(uuid, int, text, text) to authenticated;

-- ── 7b. stock_in_transit: only stock that has ACTUALLY LEFT its source ──────
-- A 'requested' (or rejected/cancelled) transfer's lines have qty_received NULL
-- → qty_outstanding = qty > 0, but NO stock has moved yet (the units are still
-- on the source shelf, counted in stock_levels). Without a status filter the
-- reconciliation Σ stock_levels + Σ in_transit = total owned would DOUBLE-COUNT
-- them. Master deliveries are never in these pre-approval states, so this only
-- affects transfers. In-transit stock is exactly in_transit + discrepancy.
create or replace view public.stock_in_transit
with (security_barrier = true) as
select
  dl.id                          as delivery_line_id,
  d.id                           as delivery_id,
  d.shop_id, sh.name             as shop_name,
  d.delivered_at, d.status       as delivery_status,
  dl.part_id, dl.engine_id,
  coalesce(p.name, em.brand || ' ' || em.model) as name,
  coalesce(p.unit, 'unit')       as unit,
  dl.qty                         as qty_sent,
  dl.qty_received,
  dl.qty_outstanding             as qty,
  dl.shop_note
from public.delivery_lines dl
join public.deliveries d on d.id = dl.delivery_id and d.deleted_at is null
join public.shops sh on sh.id = d.shop_id
left join public.parts p on p.id = dl.part_id
left join public.engines e on e.id = dl.engine_id
left join public.engine_models em on em.id = e.engine_model_id
where dl.qty_outstanding > 0
  and d.status in ('in_transit','discrepancy')
  and (public.is_owner() or d.shop_id = public.auth_shop_id());

revoke all on public.stock_in_transit from anon;
grant select on public.stock_in_transit to authenticated;

-- ── 8. shop_incoming views: add source label + hide pre-approval transfers ──
create or replace view public.shop_incoming_deliveries
with (security_barrier = true) as
select
  d.id, d.shop_id, d.delivered_at, d.note, d.status,
  d.confirmed_at, d.resolved_at,
  (select count(*) from public.delivery_lines dl where dl.delivery_id = d.id) as line_count,
  (select coalesce(sum(dl.qty), 0) from public.delivery_lines dl where dl.delivery_id = d.id) as qty_sent,
  (select coalesce(sum(dl.qty_outstanding), 0) from public.delivery_lines dl where dl.delivery_id = d.id) as qty_outstanding,
  d.from_shop_id,
  (select sh.name from public.shops sh where sh.id = d.from_shop_id) as from_shop_name
from public.deliveries d
where d.deleted_at is null
  -- a requested/rejected/cancelled transfer must NOT surface to the destination
  and d.status in ('in_transit','confirmed','discrepancy','resolved')
  and (public.is_owner() or d.shop_id = public.auth_shop_id());

revoke all on public.shop_incoming_deliveries from anon;
grant select on public.shop_incoming_deliveries to authenticated;

create or replace view public.shop_incoming_delivery_lines
with (security_barrier = true) as
select
  dl.id, dl.delivery_id, d.shop_id, dl.part_id, dl.engine_id,
  coalesce(p.name, em.brand || ' ' || em.model) as name,
  coalesce(p.unit, 'unit')                      as unit,
  e.serial_number,
  dl.qty                                        as qty_sent,
  dl.qty_received, dl.qty_outstanding, dl.shop_note,
  d.from_shop_id
from public.delivery_lines dl
join public.deliveries d on d.id = dl.delivery_id and d.deleted_at is null
  and d.status in ('in_transit','confirmed','discrepancy','resolved')
left join public.parts p on p.id = dl.part_id
left join public.engines e on e.id = dl.engine_id
left join public.engine_models em on em.id = e.engine_model_id
where public.is_owner() or d.shop_id = public.auth_shop_id();

revoke all on public.shop_incoming_delivery_lines from anon;
grant select on public.shop_incoming_delivery_lines to authenticated;

-- ── 9. shop_outgoing_transfers — the source shop tracks what it sent ────────
create view public.shop_outgoing_transfers
with (security_barrier = true) as
select
  d.id, d.from_shop_id, d.shop_id as to_shop_id,
  ts.name as to_shop_name, ts.location as to_shop_location, ts.color_key as to_shop_color_key,
  d.status, d.note, d.review_note,
  d.created_at as requested_at, d.approved_at, d.confirmed_at, d.resolved_at,
  (select count(*) from public.delivery_lines dl where dl.delivery_id = d.id) as line_count,
  (select coalesce(sum(dl.qty), 0) from public.delivery_lines dl where dl.delivery_id = d.id) as qty_sent,
  (select coalesce(sum(dl.qty_outstanding), 0) from public.delivery_lines dl where dl.delivery_id = d.id) as qty_outstanding
from public.deliveries d
join public.shops ts on ts.id = d.shop_id
where d.deleted_at is null and d.from_shop_id is not null
  and (public.is_owner() or d.from_shop_id = public.auth_shop_id());

revoke all on public.shop_outgoing_transfers from anon;
grant select on public.shop_outgoing_transfers to authenticated;

create view public.shop_outgoing_transfer_lines
with (security_barrier = true) as
select
  dl.id, dl.delivery_id, d.from_shop_id, dl.part_id, dl.engine_id,
  coalesce(p.name, em.brand || ' ' || em.model) as name,
  p.sku, coalesce(p.unit, 'unit') as unit,
  e.serial_number,
  dl.qty as qty_sent, dl.qty_received, dl.qty_outstanding, dl.shop_note
from public.delivery_lines dl
join public.deliveries d on d.id = dl.delivery_id and d.deleted_at is null and d.from_shop_id is not null
left join public.parts p on p.id = dl.part_id
left join public.engines e on e.id = dl.engine_id
left join public.engine_models em on em.id = e.engine_model_id
where public.is_owner() or d.from_shop_id = public.auth_shop_id();

revoke all on public.shop_outgoing_transfer_lines from anon;
grant select on public.shop_outgoing_transfer_lines to authenticated;

-- ── 10. transfer_slip (+ lines) — readable by owner, source, OR destination ─
-- The document that travels with the goods. Party-scoping is the gate: a
-- non-party session gets no row → the /transfer/[id]/slip page notFound()s
-- (same pattern as the shop warranty certificate). No cost columns.
create view public.transfer_slip
with (security_barrier = true) as
select
  d.id,
  d.from_shop_id, fs.name as from_shop_name, fs.location as from_shop_location,
  d.shop_id as to_shop_id, ts.name as to_shop_name, ts.location as to_shop_location,
  d.status, d.note, d.review_note,
  d.created_at as requested_at, d.approved_at, d.confirmed_at, d.resolved_at,
  rq.full_name as requested_by_name,
  ap.full_name as approved_by_name,
  cf.full_name as confirmed_by_name
from public.deliveries d
join public.shops fs on fs.id = d.from_shop_id
join public.shops ts on ts.id = d.shop_id
left join public.profiles rq on rq.id = d.requested_by
left join public.profiles ap on ap.id = d.approved_by
left join public.profiles cf on cf.id = d.confirmed_by
where d.deleted_at is null and d.from_shop_id is not null
  and (public.is_owner()
       or d.from_shop_id = public.auth_shop_id()
       or d.shop_id = public.auth_shop_id());

revoke all on public.transfer_slip from anon;
grant select on public.transfer_slip to authenticated;

create view public.transfer_slip_lines
with (security_barrier = true) as
select
  dl.id, dl.delivery_id,
  coalesce(p.name, em.brand || ' ' || em.model) as name,
  p.sku, coalesce(p.unit, 'unit') as unit,
  e.serial_number,
  dl.qty as qty_sent, dl.qty_received, dl.qty_outstanding
from public.delivery_lines dl
join public.deliveries d on d.id = dl.delivery_id and d.deleted_at is null and d.from_shop_id is not null
left join public.parts p on p.id = dl.part_id
left join public.engines e on e.id = dl.engine_id
left join public.engine_models em on em.id = e.engine_model_id
where public.is_owner()
   or d.from_shop_id = public.auth_shop_id()
   or d.shop_id = public.auth_shop_id();

revoke all on public.transfer_slip_lines from anon;
grant select on public.transfer_slip_lines to authenticated;

-- ── 11. fn_stock_card — transfer-aware delivery particular ──────────────────
-- The only change vs 0045: the 'delivery' particular is now SIGN-based and
-- names the real source/destination, so a transfer-in reads "Received from
-- Branch 1" (not "Received from Master") and a transfer-out reads "Delivered
-- to Branch 2". Correct for master too (source name is NULL → "Master").
create or replace function public.fn_stock_card(
  p_part_id uuid,
  p_shop_id uuid,
  p_from    date,
  p_to      date
)
returns table (
  kind         text,
  movement_id  uuid,
  created_at   timestamptz,
  movement_type text,
  reference    text,
  particulars  text,
  qty_in       int,
  qty_out      int,
  balance      bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_open   bigint;
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can read a stock card';
  end if;

  v_from_ts := (p_from::timestamp) at time zone 'Asia/Manila';
  v_to_ts   := ((p_to + 1)::timestamp) at time zone 'Asia/Manila';

  select coalesce(sum(m.qty_change), 0) into v_open
  from public.stock_movements m
  where m.part_id = p_part_id
    and m.shop_id is not distinct from p_shop_id
    and m.movement_type::text <> 'transit_writeoff'
    and m.created_at < v_from_ts;

  return query
  select
    'opening'::text, null::uuid, v_from_ts, null::text, null::text,
    'Opening balance'::text, null::int, null::int, v_open

  union all

  select
    'movement'::text,
    r.id,
    r.created_at,
    r.movement_type,
    r.reference,
    r.particulars,
    r.qty_in,
    r.qty_out,
    v_open + sum(r.qty_change) over (order by r.created_at, r.id)
  from (
    select
      m.id,
      m.created_at,
      m.movement_type::text as movement_type,
      m.qty_change,
      greatest(m.qty_change, 0)  as qty_in,
      greatest(-m.qty_change, 0) as qty_out,
      case
        when m.receiving_id is not null then 'RCV-' || upper(left(m.receiving_id::text, 8))
        when m.delivery_id  is not null then 'DN-'  || upper(left(m.delivery_id::text, 8))
        when m.return_id    is not null then 'RET-' || upper(left(m.return_id::text, 8))
        when m.sale_id      is not null then coalesce(s.receipt_no, 'OR-' || upper(left(m.sale_id::text, 8)))
        when m.loss_id      is not null then 'LOS-' || upper(left(m.loss_id::text, 8))
        else null
      end as reference,
      case m.movement_type::text
        when 'received'       then 'Received from ' || coalesce(sup.name, 'supplier')
        -- sign-based so it is correct for master AND transfers:
        --   −qty is the outbound (send) leg; +qty is the inbound (arrive) leg
        when 'delivery'       then case
                                     when m.qty_change < 0 then 'Delivered to ' || coalesce(dsh.name, 'shop')
                                     else 'Received from ' || coalesce(fsh.name, 'Master')
                                   end
        when 'return'         then case
                                     when m.shop_id is null then 'Returned from ' || coalesce(rsh.name, 'shop')
                                     else 'Returned to Master'
                                   end
        when 'sale'           then 'Sold' || coalesce(' — ' || s.receipt_no, '')
        when 'loss'           then coalesce(initcap(l.reason::text), 'Loss')
                                   || coalesce(' — ' || nullif(l.note, ''), '')
        when 'transit_return' then 'Recovered from transit'
        when 'correction'     then 'Correction'
        else m.movement_type::text
      end as particulars
    from public.stock_movements m
    left join public.sales s      on s.id = m.sale_id
    left join public.losses l     on l.id = m.loss_id
    left join public.receivings rc on rc.id = m.receiving_id
    left join public.suppliers sup on sup.id = rc.supplier_id
    left join public.deliveries d  on d.id = m.delivery_id
    left join public.shops dsh     on dsh.id = d.shop_id
    left join public.shops fsh     on fsh.id = d.from_shop_id
    left join public.returns rt    on rt.id = m.return_id
    left join public.shops rsh     on rsh.id = rt.shop_id
    where m.part_id = p_part_id
      and m.shop_id is not distinct from p_shop_id
      and m.movement_type::text <> 'transit_writeoff'
      and m.created_at >= v_from_ts
      and m.created_at <  v_to_ts
  ) r
  order by 3, 2 nulls first;
end;
$$;

revoke all on function public.fn_stock_card(uuid, uuid, date, date) from public, anon;
grant execute on function public.fn_stock_card(uuid, uuid, date, date) to authenticated;
