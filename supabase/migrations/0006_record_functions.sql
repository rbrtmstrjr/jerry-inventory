-- ============================================================================
-- 0006_record_functions.sql — Employees RECORD; they never MOVE stock.
-- fn_record_sale / fn_record_loss create PENDING submissions atomically.
-- SECURITY DEFINER so selling prices come from the catalog (authoritative),
-- never from the client — but every call re-checks the caller's shop scope.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Record a sale (PENDING — does NOT deduct stock).
--   p_customer_id: existing customer, or null
--   p_customer:    {name, phone, address} to create inline, or null
--   p_part_lines:  [{part_id, qty}]           (prices resolved server-side)
--   p_engine_ids:  ["uuid", ...]              (must be delivered at this shop)
-- Returns the sale id.
-- ---------------------------------------------------------------------------
create or replace function public.fn_record_sale(
  p_customer_id uuid default null,
  p_customer jsonb default null,
  p_part_lines jsonb default '[]'::jsonb,
  p_engine_ids jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_sale_id uuid;
  v_customer_id uuid := p_customer_id;
  r record;
  v_engine_id uuid;
  v_price bigint;
  v_total bigint := 0;
  v_count int := 0;
  v_eng record;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record sales';
  end if;

  -- inline customer creation
  if v_customer_id is null and p_customer is not null
     and coalesce(trim(p_customer->>'name'), '') <> '' then
    insert into customers (name, phone, address)
    values (trim(p_customer->>'name'),
            nullif(trim(coalesce(p_customer->>'phone','')), ''),
            nullif(trim(coalesce(p_customer->>'address','')), ''))
    returning id into v_customer_id;
  end if;

  -- engine sales require a customer (warranty needs one)
  if jsonb_array_length(coalesce(p_engine_ids, '[]'::jsonb)) > 0
     and v_customer_id is null then
    raise exception 'Engine sales require a customer (for the warranty)';
  end if;

  insert into sales (shop_id, recorded_by, customer_id, status)
  values (v_shop, auth.uid(), v_customer_id, 'pending')
  returning id into v_sale_id;

  -- part lines: price from catalog
  for r in
    select * from jsonb_to_recordset(coalesce(p_part_lines, '[]'::jsonb))
      as x(part_id uuid, qty int)
  loop
    if r.part_id is null or r.qty is null or r.qty <= 0 then
      raise exception 'Invalid sale line';
    end if;

    -- the item must have been delivered to this shop at some point
    if not exists (
      select 1 from stock_levels
      where part_id = r.part_id and shop_id = v_shop
    ) then
      raise exception 'That item has not been delivered to your shop';
    end if;

    select price_centavos into v_price from parts
    where id = r.part_id and deleted_at is null;
    if v_price is null then
      raise exception 'Item not found in catalog';
    end if;

    insert into sale_lines (sale_id, part_id, qty, unit_price_centavos, line_total_centavos)
    values (v_sale_id, r.part_id, r.qty, v_price, v_price * r.qty);

    v_total := v_total + v_price * r.qty;
    v_count := v_count + 1;
  end loop;

  -- engine lines
  for v_engine_id in
    select value::uuid from jsonb_array_elements_text(coalesce(p_engine_ids, '[]'::jsonb))
  loop
    select status, shop_id, price_centavos into v_eng from engines
    where id = v_engine_id and deleted_at is null;

    if v_eng is null or v_eng.price_centavos is null then
      raise exception 'Engine not found';
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_shop then
      raise exception 'That engine is not at your shop';
    end if;

    -- prevent double-recording the same serial in another open submission
    if exists (
      select 1 from sale_lines sl
      join sales s on s.id = sl.sale_id
      where sl.engine_id = v_engine_id
        and s.status in ('pending','questioned')
        and s.deleted_at is null
    ) then
      raise exception 'That engine is already in a pending sale';
    end if;

    insert into sale_lines (sale_id, engine_id, qty, unit_price_centavos, line_total_centavos)
    values (v_sale_id, v_engine_id, 1, v_eng.price_centavos, v_eng.price_centavos);

    v_total := v_total + v_eng.price_centavos;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'A sale needs at least one line';
  end if;

  update sales set total_centavos = v_total where id = v_sale_id;
  return v_sale_id;
end $$;

revoke all on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb) from public, anon;
grant execute on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Record a loss/adjustment (PENDING — reason-coded write-off request).
-- One item per loss row: part (qty) or engine (serialized).
-- Returns the loss id.
-- ---------------------------------------------------------------------------
create or replace function public.fn_record_loss(
  p_part_id uuid default null,
  p_engine_id uuid default null,
  p_qty int default 1,
  p_reason public.loss_reason default 'nasira',
  p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_loss_id uuid;
  v_eng record;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record losses';
  end if;

  if (p_part_id is null) = (p_engine_id is null) then
    raise exception 'Provide exactly one of part or engine';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantity must be positive';
  end if;

  if p_part_id is not null then
    if not exists (
      select 1 from stock_levels
      where part_id = p_part_id and shop_id = v_shop
    ) then
      raise exception 'That item has not been delivered to your shop';
    end if;
  else
    select status, shop_id into v_eng from engines
    where id = p_engine_id and deleted_at is null;
    if v_eng is null then
      raise exception 'Engine not found';
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_shop then
      raise exception 'That engine is not at your shop';
    end if;
    if p_qty <> 1 then
      raise exception 'Engine losses are one serial at a time';
    end if;
    if exists (
      select 1 from losses
      where engine_id = p_engine_id
        and status in ('pending','questioned')
        and deleted_at is null
    ) then
      raise exception 'That engine already has a pending loss report';
    end if;
  end if;

  insert into losses (shop_id, recorded_by, part_id, engine_id, qty, reason, note, status)
  values (v_shop, auth.uid(), p_part_id, p_engine_id, p_qty, p_reason, p_note, 'pending')
  returning id into v_loss_id;

  return v_loss_id;
end $$;

revoke all on function public.fn_record_loss(uuid, uuid, int, public.loss_reason, text) from public, anon;
grant execute on function public.fn_record_loss(uuid, uuid, int, public.loss_reason, text) to authenticated;
