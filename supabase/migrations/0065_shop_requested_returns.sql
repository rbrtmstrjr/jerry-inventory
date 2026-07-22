-- 0065 — shop-initiated returns with admin approval
--
-- Returns become a REQUEST → APPROVE flow, mirroring shop-to-shop transfers
-- (0054): the SHOP initiates a return (its stock → master), the OWNER approves
-- or rejects it in Deliveries & Returns → "Transfers & Returns". The owner's
-- immediate "New Return" is retired from the UI (fn_return_stock stays for
-- back-compat/tests but is no longer called from a screen).
--
-- On APPROVAL the stock returns to master exactly as the old return did (0058):
-- good units → master, damaged → an approved loss at cost. Reason + damaged are
-- chosen by the shop AT REQUEST time; the owner just approves/rejects. No
-- transit step — the owner is the receiver, so approving lands it in master.

-- ── 1. lifecycle on returns ────────────────────────────────────────────────
alter table public.returns
  add column if not exists status text not null default 'approved'
    check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  add column if not exists requested_by uuid references public.profiles(id),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists review_note text;
-- existing rows are owner-initiated immediate returns → already done; default
-- 'approved' covers them (explicit for clarity, in case the column pre-existed).
update public.returns set status = 'approved' where status is null;

-- ── 2. shop-facing safe views (a shop reads its OWN return requests) ────────
create or replace view public.shop_returns
with (security_barrier = true) as
select
  r.id, r.shop_id, r.reason, r.status, r.review_note, r.created_at, r.approved_at,
  (select count(*) from public.return_lines rl where rl.return_id = r.id) as line_count,
  (select coalesce(sum(rl.qty), 0) from public.return_lines rl where rl.return_id = r.id) as qty_total
from public.returns r
where r.deleted_at is null
  and (public.is_owner() or r.shop_id = public.auth_shop_id());
revoke all on public.shop_returns from anon;
grant select on public.shop_returns to authenticated;

create or replace view public.shop_return_lines
with (security_barrier = true) as
select
  rl.id, rl.return_id, r.shop_id, rl.part_id, rl.engine_id,
  coalesce(p.name, em.brand || ' ' || em.model) as name,
  coalesce(p.unit, 'unit') as unit,
  e.serial_number,
  rl.qty, rl.qty_damaged
from public.return_lines rl
join public.returns r on r.id = rl.return_id and r.deleted_at is null
left join public.parts p on p.id = rl.part_id
left join public.engines e on e.id = rl.engine_id
left join public.engine_models em on em.id = e.engine_model_id
where public.is_owner() or r.shop_id = public.auth_shop_id();
revoke all on public.shop_return_lines from anon;
grant select on public.shop_return_lines to authenticated;

-- ── 3. fn_request_return — shop records the request; NO stock moves ─────────
-- The shop keeps the stock on its shelf until the owner approves (same as a
-- transfer request). We only validate the stock EXISTS now; approval re-checks.
create or replace function public.fn_request_return(
  p_reason text,
  p_parts jsonb default '[]'::jsonb,
  p_engine_ids jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_return_id uuid;
  r record;
  e record;
  v_shop_qty int;
  v_good int;
  v_damaged int;
  v_eng record;
  v_count int := 0;
begin
  v_shop := public.auth_shop_id();
  if v_shop is null then
    raise exception 'Only a shop can request a return';
  end if;

  insert into returns (shop_id, reason, status, requested_by, created_by)
  values (v_shop, nullif(trim(coalesce(p_reason, '')), ''), 'requested', auth.uid(), auth.uid())
  returning id into v_return_id;

  for r in
    select * from jsonb_to_recordset(coalesce(p_parts, '[]'::jsonb))
      as x(part_id uuid, qty_good int, qty_damaged int)
  loop
    v_good := coalesce(r.qty_good, 0);
    v_damaged := coalesce(r.qty_damaged, 0);
    if r.part_id is null then raise exception 'Invalid part line'; end if;
    if v_good < 0 or v_damaged < 0 then raise exception 'Quantities cannot be negative'; end if;
    if v_good + v_damaged <= 0 then raise exception 'Each part line needs a good or damaged unit'; end if;

    select qty into v_shop_qty from stock_levels
    where part_id = r.part_id and shop_id = v_shop;
    if v_shop_qty is null or v_shop_qty < v_good + v_damaged then
      raise exception 'Your shop does not have enough of that item (have %, need %)',
        coalesce(v_shop_qty, 0), v_good + v_damaged;
    end if;

    insert into return_lines (return_id, part_id, qty, qty_damaged)
    values (v_return_id, r.part_id, v_good + v_damaged, v_damaged);
    v_count := v_count + 1;
  end loop;

  for e in
    select * from jsonb_to_recordset(coalesce(p_engine_ids, '[]'::jsonb))
      as x(engine_id uuid, condition text)
  loop
    if e.engine_id is null then raise exception 'Invalid engine line'; end if;
    if coalesce(e.condition, 'good') not in ('good', 'damaged') then
      raise exception 'Engine condition must be good or damaged';
    end if;
    select id, status, shop_id into v_eng from engines
    where id = e.engine_id and deleted_at is null;
    if v_eng.id is null then raise exception 'Engine not found'; end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_shop then
      raise exception 'That engine is not at your shop';
    end if;
    insert into return_lines (return_id, engine_id, qty, qty_damaged)
    values (v_return_id, e.engine_id, 1,
            case when coalesce(e.condition, 'good') = 'damaged' then 1 else 0 end);
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then raise exception 'A return needs at least one item'; end if;
  return v_return_id;
end $$;
revoke all on function public.fn_request_return(text, jsonb, jsonb) from public, anon;
grant execute on function public.fn_request_return(text, jsonb, jsonb) to authenticated;

-- ── 4. fn_approve_return — owner; good → master, damaged → approved loss ────
-- Re-checks the shop STILL holds each line (RAISES if sold since the request),
-- then runs the exact 0058 return legs off the stored return_lines.
create or replace function public.fn_approve_return(p_return_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_reason text;
  v_status text;
  rl record;
  v_shop_qty int;
  v_good int;
  v_damaged int;
  v_pname text;
  v_cost bigint;
  v_loss_id uuid;
  v_eng record;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve returns';
  end if;

  select shop_id, reason, status into v_shop, v_reason, v_status
  from returns where id = p_return_id and deleted_at is null for update;
  if v_shop is null then raise exception 'Return not found'; end if;
  if v_status <> 'requested' then raise exception 'This return is not pending'; end if;

  for rl in
    select id, part_id, engine_id, qty, qty_damaged
    from return_lines where return_id = p_return_id
  loop
    if rl.part_id is not null then
      v_good := rl.qty - coalesce(rl.qty_damaged, 0);
      v_damaged := coalesce(rl.qty_damaged, 0);

      select qty into v_shop_qty from stock_levels
      where part_id = rl.part_id and shop_id = v_shop for update;
      if v_shop_qty is null or v_shop_qty < rl.qty then
        raise exception 'The shop no longer has enough of that item (sold since the request?)';
      end if;

      update stock_levels set qty = qty - rl.qty
      where part_id = rl.part_id and shop_id = v_shop;

      if v_good > 0 then
        insert into stock_levels (part_id, shop_id, qty)
        values (rl.part_id, null, v_good)
        on conflict (part_id, shop_id) do update set qty = stock_levels.qty + excluded.qty;
        insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, return_id, note)
        values ('return', rl.part_id, -v_good, v_shop, auth.uid(), p_return_id, v_reason),
               ('return', rl.part_id,  v_good, null,   auth.uid(), p_return_id, v_reason);
      end if;

      if v_damaged > 0 then
        select name, cost_centavos into v_pname, v_cost from parts where id = rl.part_id;
        insert into losses (shop_id, recorded_by, part_id, qty, reason, description,
                            status, value_centavos, reviewed_by, reviewed_at)
        values (v_shop, auth.uid(), rl.part_id, v_damaged, 'nasira', v_pname,
                'approved', coalesce(v_cost, 0) * v_damaged, auth.uid(), now())
        returning id into v_loss_id;
        insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, loss_id, note)
        values ('loss', rl.part_id, -v_damaged, v_shop, auth.uid(), v_loss_id, 'nasira: damaged on return');
      end if;
    else
      select id, status, shop_id, cost_centavos, serial_number into v_eng from engines
      where id = rl.engine_id and deleted_at is null for update;
      if v_eng.id is null then raise exception 'Engine no longer available'; end if;
      if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_shop then
        raise exception 'That engine is no longer at the shop';
      end if;

      if coalesce(rl.qty_damaged, 0) = 0 then
        update engines set status = 'in_master', shop_id = null where id = rl.engine_id;
        insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, return_id, note)
        values ('return', rl.engine_id, -1, v_shop, auth.uid(), p_return_id, v_reason),
               ('return', rl.engine_id,  1, null,   auth.uid(), p_return_id, v_reason);
      else
        update engines set deleted_at = now() where id = rl.engine_id;
        insert into losses (shop_id, recorded_by, engine_id, qty, reason, description,
                            status, value_centavos, reviewed_by, reviewed_at)
        values (v_shop, auth.uid(), rl.engine_id, 1, 'nasira', 'Engine ' || v_eng.serial_number,
                'approved', coalesce(v_eng.cost_centavos, 0), auth.uid(), now())
        returning id into v_loss_id;
        insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, loss_id, note)
        values ('loss', rl.engine_id, -1, v_shop, auth.uid(), v_loss_id, 'nasira: damaged on return');
      end if;
    end if;
  end loop;

  update returns
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_return_id;
  return p_return_id;
end $$;
revoke all on function public.fn_approve_return(uuid) from public, anon;
grant execute on function public.fn_approve_return(uuid) to authenticated;

-- ── 5. fn_reject_return — owner; note required, no stock moved ──────────────
create or replace function public.fn_reject_return(p_return_id uuid, p_note text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_status text;
begin
  if not public.is_owner() then raise exception 'Only the owner can reject returns'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'A reason is required to reject'; end if;
  select status into v_status from returns where id = p_return_id and deleted_at is null for update;
  if v_status is null then raise exception 'Return not found'; end if;
  if v_status <> 'requested' then raise exception 'This return is not pending'; end if;
  update returns
  set status = 'rejected', review_note = trim(p_note),
      approved_by = auth.uid(), approved_at = now()
  where id = p_return_id;
  return p_return_id;
end $$;
revoke all on function public.fn_reject_return(uuid, text) from public, anon;
grant execute on function public.fn_reject_return(uuid, text) to authenticated;

-- ── 6. fn_cancel_return — shop cancels its own, only while requested ────────
create or replace function public.fn_cancel_return(p_return_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_shop uuid; v_status text;
begin
  select shop_id, status into v_shop, v_status from returns
  where id = p_return_id and deleted_at is null for update;
  if v_shop is null then raise exception 'Return not found'; end if;
  if v_shop is distinct from public.auth_shop_id() then
    raise exception 'You can only cancel your own return';
  end if;
  if v_status <> 'requested' then raise exception 'Only a pending return can be cancelled'; end if;
  update returns set status = 'cancelled' where id = p_return_id;
  return p_return_id;
end $$;
revoke all on function public.fn_cancel_return(uuid) from public, anon;
grant execute on function public.fn_cancel_return(uuid) to authenticated;
