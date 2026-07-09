-- ============================================================================
-- 0005_delivery_functions.sql — Deliveries (Jerry → shop, auto-land) and
-- Returns (shop → Jerry). Atomic: stock on both sides + ledger, or nothing.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Deliver stock from MASTER to a shop. Auto-lands (no shop confirmation).
--   p_parts:      [{part_id, qty}]
--   p_engine_ids: ["uuid", ...]  (engines must be in_master)
-- Returns the delivery id.
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
begin
  if not public.is_owner() then
    raise exception 'Only the owner can deliver stock';
  end if;

  if not exists (select 1 from shops where id = p_shop_id and active and deleted_at is null) then
    raise exception 'Shop not found or inactive';
  end if;

  insert into deliveries (shop_id, note, created_by)
  values (p_shop_id, p_note, auth.uid())
  returning id into v_delivery_id;

  -- Parts: master − / shop +
  for r in
    select * from jsonb_to_recordset(coalesce(p_parts, '[]'::jsonb))
      as x(part_id uuid, qty int)
  loop
    if r.part_id is null or r.qty is null or r.qty <= 0 then
      raise exception 'Invalid part line';
    end if;

    -- lock the master row and check availability
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

    insert into stock_levels (part_id, shop_id, qty)
    values (r.part_id, p_shop_id, r.qty)
    on conflict (part_id, shop_id)
    do update set qty = stock_levels.qty + excluded.qty;

    insert into delivery_lines (delivery_id, part_id, qty)
    values (v_delivery_id, r.part_id, r.qty);

    insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
    values ('delivery', r.part_id, -r.qty, null,      auth.uid(), v_delivery_id, p_note),
           ('delivery', r.part_id,  r.qty, p_shop_id, auth.uid(), v_delivery_id, p_note);

    v_count := v_count + 1;
  end loop;

  -- Engines: in_master → delivered @ shop
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

    update engines set status = 'delivered', shop_id = p_shop_id
    where id = v_engine_id;

    insert into delivery_lines (delivery_id, engine_id, qty)
    values (v_delivery_id, v_engine_id, 1);

    insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
    values ('delivery', v_engine_id, -1, null,      auth.uid(), v_delivery_id, p_note),
           ('delivery', v_engine_id,  1, p_shop_id, auth.uid(), v_delivery_id, p_note);

    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Delivery must contain at least one line';
  end if;

  return v_delivery_id;
end $$;

revoke all on function public.fn_deliver_stock(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.fn_deliver_stock(uuid, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Return stock from a shop back to MASTER (slow-movers, redistribution,
-- damaged-for-return). Engines go back to in_master and can be redelivered.
-- ---------------------------------------------------------------------------
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
  v_engine_id uuid;
  v_shop_qty int;
  v_eng record;
  v_count int := 0;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can process returns';
  end if;

  insert into returns (shop_id, reason, created_by)
  values (p_shop_id, p_reason, auth.uid())
  returning id into v_return_id;

  -- Parts: shop − / master +
  for r in
    select * from jsonb_to_recordset(coalesce(p_parts, '[]'::jsonb))
      as x(part_id uuid, qty int)
  loop
    if r.part_id is null or r.qty is null or r.qty <= 0 then
      raise exception 'Invalid part line';
    end if;

    select qty into v_shop_qty
    from stock_levels
    where part_id = r.part_id and shop_id = p_shop_id
    for update;

    if v_shop_qty is null or v_shop_qty < r.qty then
      raise exception 'Shop does not have enough stock of part % (have %, need %)',
        r.part_id, coalesce(v_shop_qty, 0), r.qty;
    end if;

    update stock_levels set qty = qty - r.qty
    where part_id = r.part_id and shop_id = p_shop_id;

    insert into stock_levels (part_id, shop_id, qty)
    values (r.part_id, null, r.qty)
    on conflict (part_id, shop_id)
    do update set qty = stock_levels.qty + excluded.qty;

    insert into return_lines (return_id, part_id, qty)
    values (v_return_id, r.part_id, r.qty);

    insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, return_id, note)
    values ('return', r.part_id, -r.qty, p_shop_id, auth.uid(), v_return_id, p_reason),
           ('return', r.part_id,  r.qty, null,      auth.uid(), v_return_id, p_reason);

    v_count := v_count + 1;
  end loop;

  -- Engines: delivered @ this shop → back to in_master
  for v_engine_id in
    select value::uuid from jsonb_array_elements_text(coalesce(p_engine_ids, '[]'::jsonb))
  loop
    select status, shop_id into v_eng from engines
    where id = v_engine_id and deleted_at is null
    for update;

    if v_eng is null then
      raise exception 'Engine % not found', v_engine_id;
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from p_shop_id then
      raise exception 'Engine % is not at this shop', v_engine_id;
    end if;

    update engines set status = 'in_master', shop_id = null
    where id = v_engine_id;

    insert into return_lines (return_id, engine_id, qty)
    values (v_return_id, v_engine_id, 1);

    insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, return_id, note)
    values ('return', v_engine_id, -1, p_shop_id, auth.uid(), v_return_id, p_reason),
           ('return', v_engine_id,  1, null,      auth.uid(), v_return_id, p_reason);

    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Return must contain at least one line';
  end if;

  return v_return_id;
end $$;

revoke all on function public.fn_return_stock(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.fn_return_stock(uuid, text, jsonb, jsonb) to authenticated;
