-- ============================================================================
-- 0029_delivery_confirmation_functions.sql
--
-- The shop RECORDS what arrived; the OWNER DECIDES what happens to anything
-- missing. There is deliberately NO shop-callable path that returns, rejects
-- or writes off stock — a shop can only enter counts and notes.
--
--   fn_deliver_stock            (owner) master → in-transit, notify the shop
--   fn_confirm_delivery         (shop)  in-transit → shop, shortfall stays
--                                       in-transit, notify the owner
--   fn_resolve_delivery_discrepancy (owner ONLY) in-transit → master, or
--                                       write off as a transit loss
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Deliver: stock LEAVES master and enters transit. It does NOT land yet.
-- ---------------------------------------------------------------------------
create or replace function public.fn_deliver_stock(
  p_shop_id uuid,
  p_note text,
  p_parts jsonb default '[]'::jsonb,
  p_engine_ids jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delivery_id uuid;
  r record;
  v_engine_id uuid;
  v_master_qty int;
  v_status public.engine_status;
  v_count int := 0;
  v_shop_name text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can deliver stock';
  end if;

  if not exists (select 1 from shops where id = p_shop_id and active and deleted_at is null) then
    raise exception 'Shop not found or inactive';
  end if;

  insert into deliveries (shop_id, note, created_by, status)
  values (p_shop_id, p_note, auth.uid(), 'in_transit')
  returning id into v_delivery_id;

  -- Parts: master − only. The qty now sits in transit (delivery_lines
  -- .qty_outstanding) until the shop confirms it.
  for r in
    select * from jsonb_to_recordset(coalesce(p_parts, '[]'::jsonb))
      as x(part_id uuid, qty int)
  loop
    if r.part_id is null or r.qty is null or r.qty <= 0 then
      raise exception 'Invalid part line';
    end if;

    select qty into v_master_qty
    from stock_levels
    where part_id = r.part_id and shop_id is null
    for update;

    if v_master_qty is null or v_master_qty < r.qty then
      raise exception 'Not enough master stock for part % (have %, need %)',
        r.part_id, coalesce(v_master_qty, 0), r.qty;
    end if;

    update stock_levels set qty = qty - r.qty
    where part_id = r.part_id and shop_id is null;

    insert into delivery_lines (delivery_id, part_id, qty)
    values (v_delivery_id, r.part_id, r.qty);

    -- ledger: leaves master. The matching "+ at shop" row is written on
    -- confirmation, not now.
    insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
    values ('delivery', r.part_id, -r.qty, null, auth.uid(), v_delivery_id, p_note);

    v_count := v_count + 1;
  end loop;

  -- Engines: in_master → in_transit (shop_id = destination, not arrived yet).
  -- shop_engines filters status='delivered', so it stays out of shop stock.
  for v_engine_id in
    select value::uuid from jsonb_array_elements_text(coalesce(p_engine_ids, '[]'::jsonb))
  loop
    select status into v_status from engines
    where id = v_engine_id and deleted_at is null
    for update;

    if v_status is null then
      raise exception 'Engine % not found', v_engine_id;
    end if;
    if v_status <> 'in_master' then
      raise exception 'Engine % is not in master stock (status: %)', v_engine_id, v_status;
    end if;

    update engines set status = 'in_transit', shop_id = p_shop_id
    where id = v_engine_id;

    insert into delivery_lines (delivery_id, engine_id, qty)
    values (v_delivery_id, v_engine_id, 1);

    insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
    values ('delivery', v_engine_id, -1, null, auth.uid(), v_delivery_id, p_note);

    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Delivery must contain at least one line';
  end if;

  select name into v_shop_name from shops where id = p_shop_id;
  perform public.fn_notify(
    'shop', p_shop_id, 'delivery_incoming',
    'Stock is on the way',
    v_count || ' item(s) sent from master — confirm what actually arrives.',
    'deliveries', v_delivery_id);

  return v_delivery_id;
end $$;

revoke all on function public.fn_deliver_stock(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.fn_deliver_stock(uuid, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Confirm: the shop counts what physically arrived. One-shot.
--   p_lines: [{line_id, qty_received, shop_note}]
-- Engines are 1-per-line, so a serial is confirmed with qty_received 1 or 0.
-- ---------------------------------------------------------------------------
create or replace function public.fn_confirm_delivery(
  p_delivery_id uuid,
  p_lines jsonb,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_del record;
  r record;
  v_line record;
  v_expected int;
  v_provided int;
  v_short int := 0;
  v_landed int := 0;
  v_shop_name text;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop staff can confirm a delivery';
  end if;

  select * into v_del from deliveries
  where id = p_delivery_id and deleted_at is null
  for update;
  if not found then
    raise exception 'Delivery not found';
  end if;
  if v_del.shop_id is distinct from v_shop then
    raise exception 'That delivery is not addressed to your shop';
  end if;
  if v_del.status <> 'in_transit' then
    raise exception 'This delivery was already confirmed (status: %)', v_del.status;
  end if;

  select count(*) into v_expected from delivery_lines where delivery_id = p_delivery_id;
  select count(*) into v_provided from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb));
  if v_provided <> v_expected then
    raise exception 'Count every line before confirming (% of % provided)', v_provided, v_expected;
  end if;

  for r in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(line_id uuid, qty_received int, shop_note text)
  loop
    select * into v_line from delivery_lines
    where id = r.line_id and delivery_id = p_delivery_id
    for update;
    if not found then
      raise exception 'That line is not part of this delivery';
    end if;
    if r.qty_received is null or r.qty_received < 0 then
      raise exception 'Received quantity cannot be negative';
    end if;
    -- a shop can NEVER confirm more than was sent
    if r.qty_received > v_line.qty then
      raise exception 'Cannot receive more than was sent (sent %, entered %)',
        v_line.qty, r.qty_received;
    end if;

    update delivery_lines
    set qty_received = r.qty_received,
        shop_note = nullif(trim(coalesce(r.shop_note, '')), '')
    where id = r.line_id;

    if r.qty_received > 0 then
      if v_line.part_id is not null then
        -- in-transit → shop
        insert into stock_levels (part_id, shop_id, qty)
        values (v_line.part_id, v_shop, r.qty_received)
        on conflict (part_id, shop_id)
        do update set qty = stock_levels.qty + excluded.qty;

        insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
        values ('delivery', v_line.part_id, r.qty_received, v_shop, auth.uid(), p_delivery_id,
                coalesce(p_note, 'Confirmed on arrival'));
      else
        update engines set status = 'delivered' where id = v_line.engine_id;

        insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
        values ('delivery', v_line.engine_id, 1, v_shop, auth.uid(), p_delivery_id,
                coalesce(p_note, 'Confirmed on arrival'));
      end if;
      v_landed := v_landed + r.qty_received;
    end if;

    v_short := v_short + (v_line.qty - r.qty_received);
  end loop;

  -- Anything short simply STAYS in transit (qty_outstanding > 0) — the shop
  -- has no say in where it goes.
  update deliveries
  set status = case when v_short > 0 then 'discrepancy' else 'confirmed' end,
      confirmed_at = now(),
      confirmed_by = auth.uid()
  where id = p_delivery_id;

  select name into v_shop_name from shops where id = v_shop;
  if v_short > 0 then
    perform public.fn_notify(
      'owner', v_shop, 'delivery_discrepancy',
      coalesce(v_shop_name, 'A shop') || ': ' || v_short || ' item(s) unaccounted for',
      'Confirmed ' || v_landed || ', ' || v_short || ' missing in transit — needs your decision.',
      'deliveries', p_delivery_id);
  else
    perform public.fn_notify(
      'owner', v_shop, 'delivery_confirmed',
      coalesce(v_shop_name, 'A shop') || ' confirmed a delivery in full',
      v_landed || ' item(s) received.',
      'deliveries', p_delivery_id);
  end if;

  return jsonb_build_object('landed', v_landed, 'short', v_short,
                            'status', case when v_short > 0 then 'discrepancy' else 'confirmed' end);
end $$;

revoke all on function public.fn_confirm_delivery(uuid, jsonb, text) from public, anon;
grant execute on function public.fn_confirm_delivery(uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Resolve a shortfall — OWNER ONLY. The stock is currently in transit; it goes
-- back to master, or it is written off as a transit loss (distinct from a shop
-- loss and from a return, so reports can tell them apart).
-- ---------------------------------------------------------------------------
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
begin
  if not public.is_owner() then
    raise exception 'Only the owner can resolve a delivery discrepancy';
  end if;
  if p_resolution not in ('returned_to_master','written_off') then
    raise exception 'Unknown resolution: %', p_resolution;
  end if;

  select * into v_line from delivery_lines where id = p_delivery_line_id for update;
  if not found then
    raise exception 'Delivery line not found';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantity must be positive';
  end if;
  if p_qty > v_line.qty_outstanding then
    raise exception 'Only % outstanding on that line', v_line.qty_outstanding;
  end if;

  select * into v_del from deliveries where id = v_line.delivery_id for update;

  if v_line.part_id is not null then
    if p_resolution = 'returned_to_master' then
      -- transit → master
      insert into stock_levels (part_id, shop_id, qty)
      values (v_line.part_id, null, p_qty)
      on conflict (part_id, shop_id)
      do update set qty = stock_levels.qty + excluded.qty;

      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.part_id, p_qty, null, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Recovered from transit'));
    else
      -- gone: it already left master and never landed. Record the loss only.
      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_writeoff', v_line.part_id, -p_qty, null, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Lost in transit'));
    end if;
  else
    if p_qty <> 1 then
      raise exception 'Engines are resolved one serial at a time';
    end if;
    if p_resolution = 'returned_to_master' then
      update engines set status = 'in_master', shop_id = null where id = v_line.engine_id;
      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.engine_id, 1, null, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Recovered from transit'));
    else
      update engines set deleted_at = now() where id = v_line.engine_id;
      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_writeoff', v_line.engine_id, -1, null, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Lost in transit'));
    end if;
  end if;

  insert into delivery_discrepancies
    (delivery_line_id, qty, resolution, reason, resolved_by)
  values
    (p_delivery_line_id, p_qty, p_resolution,
     nullif(trim(coalesce(p_reason, '')), ''), auth.uid());

  update delivery_lines
  set qty_resolved = qty_resolved + p_qty
  where id = p_delivery_line_id;

  -- nothing outstanding anywhere on this delivery → it's settled
  select coalesce(sum(qty_outstanding), 0) into v_left
  from delivery_lines where delivery_id = v_line.delivery_id;

  if v_left = 0 then
    update deliveries
    set status = 'resolved', resolved_at = now(), resolved_by = auth.uid()
    where id = v_line.delivery_id;
  end if;
end $$;

revoke all on function public.fn_resolve_delivery_discrepancy(uuid, int, text, text) from public, anon;
grant execute on function public.fn_resolve_delivery_discrepancy(uuid, int, text, text) to authenticated;
