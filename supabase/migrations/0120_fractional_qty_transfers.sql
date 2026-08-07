-- ---------------------------------------------------------------------------
-- 0120 — transfers, returns and the remainder. Completes the fractional series.
--
--   fn_request_transfer · fn_approve_transfer · fn_request_return
--   fn_approve_return · fn_return_stock · fn_create_delivery_request
--   fn_check_stock_alerts · fn_stock_card · fn_merge_parts
--
-- Before generating, EVERY int local in these nine was audited for quantity
-- flow, not just the ones named *qty* — the lesson 0119 cost us. That found
-- four the name-based transform would have missed again:
--
--     v_good      <- coalesce(r.qty_good, 0)          (3 functions)
--     v_damaged   <- coalesce(r.qty_damaged, 0)       (3 functions)
--     v_transit   <- sum(dl.qty_outstanding)          (fn_merge_parts)
--
-- v_transit is the sharpest: fn_merge_parts refuses to merge a product that
-- still has stock in transit. Rounded to int, 0.4 kg in transit reads as 0 and
-- the merge is allowed — folding away a product whose stock has not landed.
--
-- DELIBERATELY LEFT AS int: `v_thr` in fn_check_stock_alerts. It holds a
-- reorder level, and Gerry asked for whole-number thresholds ("alert me at
-- 5 kg", not 5.5). parts.reorder_level stays integer throughout.
--
-- MONEY: damaged units on a return become an approved loss valued at cost, in
-- fn_approve_return and fn_return_stock. Both now round(cost * qty) — same rule
-- as everywhere else: round the line, store it, never re-derive.
--
-- ---------------------------------------------------------------------------
-- THE DROPS BELOW ARE NOT OPTIONAL — read this before removing any of them.
--
-- `create or replace function` REPLACES only when the argument list and return
-- type are unchanged. Change either and Postgres creates a SECOND function.
-- Three cases in this series did exactly that:
--
--   * fn_stock_card    — returns table(... qty_in int, qty_out int ...), and the
--                        return type is changing. `create or replace` would be
--                        REFUSED outright ("cannot change return type").
--   * fn_record_loss   — 0117 changed p_qty int -> numeric, so the ORIGINAL
--                        (uuid, uuid, int, loss_reason, text) is still there.
--   * fn_resolve_delivery_discrepancy
--                      — 0118 changed p_qty int -> numeric; same story.
--
-- Leaving the old overloads is not cosmetic. A caller passing an integer
-- literal binds to the INT version — the pre-fractional code, with no
-- fn_assert_qty call — or Postgres refuses the call as ambiguous. Either way
-- the fix silently does not apply on the path that matters.
-- ---------------------------------------------------------------------------

drop function if exists public.fn_stock_card(uuid, uuid, date, date);
drop function if exists public.fn_record_loss(uuid, uuid, int, public.loss_reason, text);
drop function if exists public.fn_resolve_delivery_discrepancy(uuid, int, text, text);

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
  v_qty numeric;
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
      as x(part_id uuid, engine_id uuid, qty numeric)
  loop
    if (r.part_id is null) = (r.engine_id is null) then
      raise exception 'Each line is a part OR an engine';
    end if;

    if r.part_id is not null then
      if r.qty is null or r.qty <= 0 then
        raise exception 'Quantity must be positive';
      end if;
      perform public.fn_assert_qty(r.part_id, r.qty);
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
  v_qty numeric;
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
  v_shop_qty numeric;
  v_good numeric;
  v_damaged numeric;
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
      as x(part_id uuid, qty_good numeric, qty_damaged numeric)
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
  v_shop_qty numeric;
  v_good numeric;
  v_damaged numeric;
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
                'approved', round(coalesce(v_cost, 0) * v_damaged), auth.uid(), now())
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

create or replace function public.fn_return_stock(
  p_shop_id uuid,
  p_reason text,
  p_parts jsonb default '[]'::jsonb,
  p_engine_ids jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_return_id uuid;
  r record;
  e record;
  v_shop_qty numeric;
  v_good numeric;
  v_damaged numeric;
  v_pname text;
  v_cost bigint;
  v_loss_id uuid;
  v_eng record;
  v_count int := 0;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can process returns';
  end if;

  insert into returns (shop_id, reason, created_by)
  values (p_shop_id, p_reason, auth.uid())
  returning id into v_return_id;

  -- Parts: good → master, damaged → approved loss @shop.
  for r in
    select * from jsonb_to_recordset(coalesce(p_parts, '[]'::jsonb))
      as x(part_id uuid, qty numeric, qty_good numeric, qty_damaged numeric, note text, photo_path text)
  loop
    v_good := coalesce(r.qty_good, r.qty, 0);   -- accept the legacy {part_id, qty}
    v_damaged := coalesce(r.qty_damaged, 0);
    if r.part_id is null then
      raise exception 'Invalid part line';
    end if;
    if v_good < 0 or v_damaged < 0 then
      raise exception 'Quantities cannot be negative';
    end if;
    if v_good + v_damaged <= 0 then
      raise exception 'Each part line needs at least one good or damaged unit';
    end if;

    select qty into v_shop_qty from stock_levels
    where part_id = r.part_id and shop_id = p_shop_id
    for update;
    if v_shop_qty is null or v_shop_qty < v_good + v_damaged then
      raise exception 'Shop does not have enough stock of part % (have %, need %)',
        r.part_id, coalesce(v_shop_qty, 0), v_good + v_damaged;
    end if;

    -- pull everything inspected off the shop shelf
    update stock_levels set qty = qty - (v_good + v_damaged)
    where part_id = r.part_id and shop_id = p_shop_id;

    insert into return_lines (return_id, part_id, qty, qty_damaged, damage_photo_path)
    values (v_return_id, r.part_id, v_good + v_damaged, v_damaged,
            nullif(trim(coalesce(r.photo_path, '')), ''));

    if v_good > 0 then
      insert into stock_levels (part_id, shop_id, qty)
      values (r.part_id, null, v_good)
      on conflict (part_id, shop_id) do update set qty = stock_levels.qty + excluded.qty;

      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, return_id, note)
      values ('return', r.part_id, -v_good, p_shop_id, auth.uid(), v_return_id, p_reason),
             ('return', r.part_id,  v_good, null,      auth.uid(), v_return_id, p_reason);
    end if;

    if v_damaged > 0 then
      select name, cost_centavos into v_pname, v_cost from parts where id = r.part_id;
      insert into losses (shop_id, recorded_by, part_id, qty, reason, note, description,
                          status, value_centavos, reviewed_by, reviewed_at)
      values (p_shop_id, auth.uid(), r.part_id, v_damaged, 'nasira',
              nullif(trim(coalesce(r.note, '')), ''), v_pname,
              'approved', round(coalesce(v_cost, 0) * v_damaged), auth.uid(), now())
      returning id into v_loss_id;

      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, loss_id, note)
      values ('loss', r.part_id, -v_damaged, p_shop_id, auth.uid(), v_loss_id,
              'nasira: damaged on return' || coalesce(' — ' || nullif(trim(coalesce(r.note,'')),''), ''));
    end if;

    v_count := v_count + 1;
  end loop;

  -- Engines: good → in_master, damaged → soft-deleted + approved loss.
  for e in
    select * from jsonb_to_recordset(coalesce(p_engine_ids, '[]'::jsonb))
      as x(engine_id uuid, condition text, note text, photo_path text)
  loop
    if e.engine_id is null then
      raise exception 'Invalid engine line';
    end if;
    if coalesce(e.condition, 'good') not in ('good', 'damaged') then
      raise exception 'Engine condition must be good or damaged';
    end if;

    select id, status, shop_id, cost_centavos, serial_number into v_eng from engines
    where id = e.engine_id and deleted_at is null
    for update;
    if v_eng.id is null then
      raise exception 'Engine % not found', e.engine_id;
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from p_shop_id then
      raise exception 'Engine % is not at this shop', e.engine_id;
    end if;

    if coalesce(e.condition, 'good') = 'good' then
      update engines set status = 'in_master', shop_id = null where id = e.engine_id;

      insert into return_lines (return_id, engine_id, qty, qty_damaged)
      values (v_return_id, e.engine_id, 1, 0);

      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, return_id, note)
      values ('return', e.engine_id, -1, p_shop_id, auth.uid(), v_return_id, p_reason),
             ('return', e.engine_id,  1, null,      auth.uid(), v_return_id, p_reason);
    else
      update engines set deleted_at = now() where id = e.engine_id;

      insert into return_lines (return_id, engine_id, qty, qty_damaged, damage_photo_path)
      values (v_return_id, e.engine_id, 1, 1, nullif(trim(coalesce(e.photo_path, '')), ''));

      insert into losses (shop_id, recorded_by, engine_id, qty, reason, note, description,
                          status, value_centavos, reviewed_by, reviewed_at)
      values (p_shop_id, auth.uid(), e.engine_id, 1, 'nasira',
              nullif(trim(coalesce(e.note, '')), ''), 'Engine ' || v_eng.serial_number,
              'approved', coalesce(v_eng.cost_centavos, 0), auth.uid(), now())
      returning id into v_loss_id;

      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, loss_id, note)
      values ('loss', e.engine_id, -1, p_shop_id, auth.uid(), v_loss_id,
              'nasira: damaged on return' || coalesce(' — ' || nullif(trim(coalesce(e.note,'')),''), ''));
    end if;

    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Return must contain at least one line';
  end if;

  return v_return_id;
end $$;

create or replace function public.fn_create_delivery_request(
  p_lines jsonb,
  p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_id uuid;
  r record;
  v_count int := 0;
  v_shop_name text;
  v_custom text;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can request a delivery';
  end if;

  insert into delivery_requests (shop_id, requested_by, note)
  values (v_shop, auth.uid(), nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;

  for r in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(part_id uuid, engine_model_id uuid, qty_requested numeric, note text,
           custom_name text)
  loop
    v_custom := nullif(trim(coalesce(r.custom_name, '')), '');
    -- exactly one identity: existing part, existing engine model, or free text
    if ((r.part_id is not null)::int + (r.engine_model_id is not null)::int
        + (v_custom is not null)::int) <> 1 then
      raise exception 'Each request line needs exactly one product';
    end if;
    if r.qty_requested is null or r.qty_requested <= 0 then
      raise exception 'Requested quantity must be positive';
    end if;

    insert into delivery_request_lines
      (delivery_request_id, part_id, engine_model_id, qty_requested, note,
       custom_name)
    values (v_id, r.part_id, r.engine_model_id, r.qty_requested,
            nullif(trim(coalesce(r.note, '')), ''), v_custom);
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Add at least one item to the request';
  end if;

  select name into v_shop_name from shops where id = v_shop;
  perform public.fn_notify(
    'owner', v_shop, 'delivery_request',
    'Delivery request from ' || coalesce(v_shop_name, 'a shop'),
    v_count || ' item(s) requested' || coalesce(' — ' || nullif(trim(coalesce(p_note,'')), ''), ''),
    'delivery_requests', v_id);

  return v_id;
end $$;

CREATE OR REPLACE FUNCTION public.fn_check_stock_alerts(p_part_id uuid, p_engine_id uuid, p_shop_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_model uuid;
  v_name text;
  v_qty numeric;
  v_thr int;
  v_shop_name text;
begin
  if p_shop_id is not null then
    select name into v_shop_name from shops where id = p_shop_id;
  end if;

  -- ------------------------------- PARTS -------------------------------
  if p_part_id is not null then
    select name, reorder_level into v_name, v_thr
    from parts where id = p_part_id and deleted_at is null;

    if v_name is not null and coalesce(v_thr, 0) > 0 then
      select coalesce(qty, 0) into v_qty
      from stock_levels where part_id = p_part_id and shop_id is null;
      v_qty := coalesce(v_qty, 0);
      if v_qty <= v_thr then
        perform public.fn_notify(
          'owner', null, 'master_low_stock',
          v_name || ' is low in master',
          'On hand ' || v_qty || ' · reorder at ' || v_thr || ' — order from your supplier.',
          'parts', p_part_id);
      end if;
    end if;

    if p_shop_id is not null then
      select coalesce(sro.reorder_level, p.reorder_level), p.name
        into v_thr, v_name
      from parts p
      left join shop_reorder_levels sro
        on sro.shop_id = p_shop_id and sro.part_id = p.id and sro.deleted_at is null
      where p.id = p_part_id and p.deleted_at is null;

      select coalesce(qty, 0) into v_qty
      from stock_levels where part_id = p_part_id and shop_id = p_shop_id;
      v_qty := coalesce(v_qty, 0);

      if v_name is not null and coalesce(v_thr, 0) > 0 and v_qty <= v_thr then
        perform public.fn_notify(
          'shop', p_shop_id, 'shop_low_stock',
          v_name || ' is low',
          'On hand ' || v_qty || ' · reorder at ' || v_thr || ' — request a delivery from Admin.',
          'parts', p_part_id);
        perform public.fn_notify(
          'owner', p_shop_id, 'shop_low_stock',
          v_name || ' is low at ' || coalesce(v_shop_name, 'a shop'),
          'On hand ' || v_qty || ' · reorder at ' || v_thr,
          'parts', p_part_id);
      end if;
    end if;
  end if;

  -- ------------------------- ENGINES (by MODEL) -------------------------
  if p_engine_id is not null then
    select engine_model_id into v_model from engines where id = p_engine_id;
    if v_model is null then return; end if;

    select em.brand || ' ' || em.model, em.reorder_level into v_name, v_thr
    from engine_models em where em.id = v_model and em.deleted_at is null;

    if v_name is not null and coalesce(v_thr, 0) > 0 then
      select count(*)::int into v_qty from engines
      where engine_model_id = v_model and status = 'in_master' and deleted_at is null;
      if v_qty <= v_thr then
        perform public.fn_notify(
          'owner', null, 'master_low_stock',
          v_name || ' is low in master',
          'In master ' || v_qty || ' unit(s) · reorder at ' || v_thr || ' — order from your supplier.',
          'engine_models', v_model);
      end if;
    end if;

    if p_shop_id is not null then
      select coalesce(sro.reorder_level, em.reorder_level), em.brand || ' ' || em.model
        into v_thr, v_name
      from engine_models em
      left join shop_reorder_levels sro
        on sro.shop_id = p_shop_id and sro.engine_model_id = em.id and sro.deleted_at is null
      where em.id = v_model and em.deleted_at is null;

      select count(*)::int into v_qty from engines
      where engine_model_id = v_model and shop_id = p_shop_id
        and status = 'delivered' and deleted_at is null;

      if v_name is not null and coalesce(v_thr, 0) > 0 and v_qty <= v_thr then
        perform public.fn_notify(
          'shop', p_shop_id, 'shop_low_stock',
          v_name || ' is low',
          'On hand ' || v_qty || ' unit(s) · reorder at ' || v_thr || ' — request a delivery from Admin.',
          'engine_models', v_model);
        perform public.fn_notify(
          'owner', p_shop_id, 'shop_low_stock',
          v_name || ' is low at ' || coalesce(v_shop_name, 'a shop'),
          'On hand ' || v_qty || ' unit(s) · reorder at ' || v_thr,
          'engine_models', v_model);
      end if;
    end if;
  end if;
end $function$
;

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
  qty_in       numeric,
  qty_out      numeric,
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

create or replace function public.fn_merge_parts(
  p_source_id uuid,
  p_target_id uuid,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src record;
  v_tgt record;
  v_qty numeric;
  v_loc text;
  v_transit numeric;
begin
  if not public.is_primary_owner() then
    raise exception 'Only the owner can merge products';
  end if;
  if p_source_id = p_target_id then
    raise exception 'A part cannot be merged into itself';
  end if;

  select id, name, deleted_at, merged_into into v_src
  from parts where id = p_source_id;
  if v_src.id is null then raise exception 'Source part not found'; end if;
  if v_src.deleted_at is not null then
    raise exception 'The duplicate is already retired';
  end if;

  select id, name, deleted_at, merged_into into v_tgt
  from parts where id = p_target_id;
  if v_tgt.id is null then raise exception 'Target part not found'; end if;
  -- merged is checked BEFORE retired: a merged part is also soft-deleted, and
  -- "merge into the surviving part" is the message that tells the owner what
  -- to do next (one-hop enforcement).
  if v_tgt.merged_into is not null then
    raise exception 'The target was itself merged — merge into the surviving part instead';
  end if;
  if v_tgt.deleted_at is not null then
    raise exception 'Cannot merge into a retired part';
  end if;

  -- ── preconditions: the source must be safe to RETIRE (ledger stays whole) ──
  -- 1. no live stock anywhere (master + every shop)
  select sl.qty, coalesce(sh.name, 'master') into v_qty, v_loc
  from stock_levels sl
  left join shops sh on sh.id = sl.shop_id
  where sl.part_id = p_source_id and sl.qty > 0
  order by sl.qty desc
  limit 1;
  if v_qty is not null then
    raise exception '% has % on hand at % — sell, return, or count it to zero before merging',
      v_src.name, v_qty, v_loc;
  end if;

  -- 2. nothing in transit
  select coalesce(sum(dl.qty_outstanding), 0) into v_transit
  from delivery_lines dl where dl.part_id = p_source_id;
  if v_transit > 0 then
    raise exception '% has % unit(s) still in transit — confirm or resolve the delivery before merging',
      v_src.name, v_transit;
  end if;

  -- 3. no open (recorded/pending/questioned) sale or loss line
  if exists (
    select 1 from sale_lines sl
    join sales s on s.id = sl.sale_id
    where sl.part_id = p_source_id
      and s.deleted_at is null
      and s.status in ('recorded','pending','questioned')
  ) or exists (
    select 1 from losses l
    where l.part_id = p_source_id
      and l.deleted_at is null
      and l.status in ('recorded','pending','questioned')
  ) then
    raise exception '% is on an unsubmitted or pending sale/loss — resolve it before merging',
      v_src.name;
  end if;

  -- ── effect: retire the source; roll identity up to the survivor ──
  -- carry fitments forward (dedupe) BEFORE the source is soft-deleted
  insert into part_fitments (part_id, engine_model_id)
  select p_target_id, engine_model_id
  from part_fitments where part_id = p_source_id
  on conflict (part_id, engine_model_id) do nothing;

  -- the blessed retirement: soft-delete + drop the (zero) stock_levels rows,
  -- leaving historical stock_movements as tolerated debris. The ledger is
  -- untouched — no movement is written, edited, or deleted.
  delete from stock_levels where part_id = p_source_id;

  update parts
  set merged_into = p_target_id,
      deleted_at = now()
  where id = p_source_id;

  insert into part_merges (source_part_id, target_part_id, merged_by, note)
  values (p_source_id, p_target_id, auth.uid(), nullif(trim(coalesce(p_note,'')),''));
end $$;

