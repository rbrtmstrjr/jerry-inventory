-- ============================================================================
-- 0007_line_descriptions.sql — item-name snapshots on submission lines.
-- Employees cannot read the parts table (costs live there), so sale/loss rows
-- carry a denormalized description captured at record time. This also keeps
-- history readable if an item is later renamed or deleted.
-- ============================================================================

alter table public.sale_lines add column if not exists description text;
alter table public.losses add column if not exists description text;

-- fn_record_sale: now snapshots descriptions
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
  v_part record;
  v_total bigint := 0;
  v_count int := 0;
  v_eng record;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record sales';
  end if;

  if v_customer_id is null and p_customer is not null
     and coalesce(trim(p_customer->>'name'), '') <> '' then
    insert into customers (name, phone, address)
    values (trim(p_customer->>'name'),
            nullif(trim(coalesce(p_customer->>'phone','')), ''),
            nullif(trim(coalesce(p_customer->>'address','')), ''))
    returning id into v_customer_id;
  end if;

  if jsonb_array_length(coalesce(p_engine_ids, '[]'::jsonb)) > 0
     and v_customer_id is null then
    raise exception 'Engine sales require a customer (for the warranty)';
  end if;

  insert into sales (shop_id, recorded_by, customer_id, status)
  values (v_shop, auth.uid(), v_customer_id, 'pending')
  returning id into v_sale_id;

  for r in
    select * from jsonb_to_recordset(coalesce(p_part_lines, '[]'::jsonb))
      as x(part_id uuid, qty int)
  loop
    if r.part_id is null or r.qty is null or r.qty <= 0 then
      raise exception 'Invalid sale line';
    end if;

    if not exists (
      select 1 from stock_levels
      where part_id = r.part_id and shop_id = v_shop
    ) then
      raise exception 'That item has not been delivered to your shop';
    end if;

    select name, unit, price_centavos into v_part from parts
    where id = r.part_id and deleted_at is null;
    if v_part is null then
      raise exception 'Item not found in catalog';
    end if;

    insert into sale_lines (sale_id, part_id, qty, unit_price_centavos, line_total_centavos, description)
    values (v_sale_id, r.part_id, r.qty, v_part.price_centavos,
            v_part.price_centavos * r.qty, v_part.name);

    v_total := v_total + v_part.price_centavos * r.qty;
    v_count := v_count + 1;
  end loop;

  for v_engine_id in
    select value::uuid from jsonb_array_elements_text(coalesce(p_engine_ids, '[]'::jsonb))
  loop
    select e.status, e.shop_id, e.price_centavos, e.serial_number,
           em.brand, em.model
      into v_eng
    from engines e
    join engine_models em on em.id = e.engine_model_id
    where e.id = v_engine_id and e.deleted_at is null;

    if v_eng is null or v_eng.price_centavos is null then
      raise exception 'Engine not found';
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_shop then
      raise exception 'That engine is not at your shop';
    end if;

    if exists (
      select 1 from sale_lines sl
      join sales s on s.id = sl.sale_id
      where sl.engine_id = v_engine_id
        and s.status in ('pending','questioned')
        and s.deleted_at is null
    ) then
      raise exception 'That engine is already in a pending sale';
    end if;

    insert into sale_lines (sale_id, engine_id, qty, unit_price_centavos, line_total_centavos, description)
    values (v_sale_id, v_engine_id, 1, v_eng.price_centavos, v_eng.price_centavos,
            v_eng.brand || ' ' || v_eng.model || ' — SN ' || v_eng.serial_number);

    v_total := v_total + v_eng.price_centavos;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'A sale needs at least one line';
  end if;

  update sales set total_centavos = v_total where id = v_sale_id;
  return v_sale_id;
end $$;

-- fn_record_loss: now snapshots a description
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
  v_desc text;
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
    select name into v_desc from parts where id = p_part_id;
  else
    select e.status, e.shop_id, e.serial_number, em.brand, em.model into v_eng
    from engines e
    join engine_models em on em.id = e.engine_model_id
    where e.id = p_engine_id and e.deleted_at is null;
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
    v_desc := v_eng.brand || ' ' || v_eng.model || ' — SN ' || v_eng.serial_number;
  end if;

  insert into losses (shop_id, recorded_by, part_id, engine_id, qty, reason, note, status, description)
  values (v_shop, auth.uid(), p_part_id, p_engine_id, p_qty, p_reason, p_note, 'pending', v_desc)
  returning id into v_loss_id;

  return v_loss_id;
end $$;
