-- ============================================================================
-- 0021_engine_pricing_functions.sql — wire the tier model into the RPCs.
--  • fn_receive_stock: accept optional per-engine margins (trigger computes
--    the stored tier prices).
--  • fn_record_sale: engine lines carry a negotiated agreed price, enforced
--    server-side against the HARD FLOOR (derived from hidden cost, never trust
--    a client floor). Adds optional partial payment + generates a receipt no.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- fn_receive_stock — engines may include margin_{floor,mid,asking}_pct.
-- ---------------------------------------------------------------------------
create or replace function public.fn_receive_stock(
  p_supplier_id uuid,
  p_note text,
  p_parts jsonb default '[]'::jsonb,
  p_engines jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receiving_id uuid;
  r record;
  v_engine_id uuid;
  v_count int := 0;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can receive stock';
  end if;

  insert into receivings (supplier_id, note, created_by)
  values (p_supplier_id, p_note, auth.uid())
  returning id into v_receiving_id;

  for r in
    select * from jsonb_to_recordset(coalesce(p_parts, '[]'::jsonb))
      as x(part_id uuid, qty int, unit_cost_centavos bigint)
  loop
    if r.part_id is null then
      raise exception 'Part line missing part_id';
    end if;
    if r.qty is null or r.qty <= 0 then
      raise exception 'Part line qty must be positive';
    end if;

    insert into receiving_lines (receiving_id, part_id, qty, unit_cost_centavos)
    values (v_receiving_id, r.part_id, r.qty, coalesce(r.unit_cost_centavos, 0));

    insert into stock_levels (part_id, shop_id, qty)
    values (r.part_id, null, r.qty)
    on conflict (part_id, shop_id)
    do update set qty = stock_levels.qty + excluded.qty;

    insert into stock_movements
      (movement_type, part_id, qty_change, shop_id, actor, receiving_id, note)
    values
      ('received', r.part_id, r.qty, null, auth.uid(), v_receiving_id, p_note);

    v_count := v_count + 1;
  end loop;

  for r in
    select * from jsonb_to_recordset(coalesce(p_engines, '[]'::jsonb))
      as x(serial_number text, engine_model_id uuid, condition text,
           cost_centavos bigint, price_centavos bigint, warranty_months int,
           margin_floor_pct numeric, margin_mid_pct numeric, margin_asking_pct numeric)
  loop
    if r.serial_number is null or length(trim(r.serial_number)) = 0 then
      raise exception 'Engine line missing serial_number';
    end if;
    if r.engine_model_id is null then
      raise exception 'Engine line missing engine_model_id';
    end if;

    -- The BEFORE trigger recomputes tier prices (and price_centavos = asking)
    -- when all three margins are present.
    insert into engines
      (serial_number, engine_model_id, condition, cost_centavos,
       price_centavos, warranty_months, status,
       margin_floor_pct, margin_mid_pct, margin_asking_pct)
    values
      (trim(r.serial_number), r.engine_model_id,
       coalesce(r.condition, 'brand_new'),
       coalesce(r.cost_centavos, 0), coalesce(r.price_centavos, 0),
       r.warranty_months, 'in_master',
       r.margin_floor_pct, r.margin_mid_pct, r.margin_asking_pct)
    returning id into v_engine_id;

    insert into receiving_lines (receiving_id, engine_id, qty, unit_cost_centavos)
    values (v_receiving_id, v_engine_id, 1, coalesce(r.cost_centavos, 0));

    insert into stock_movements
      (movement_type, engine_id, qty_change, shop_id, actor, receiving_id, note)
    values
      ('received', v_engine_id, 1, null, auth.uid(), v_receiving_id, p_note);

    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Receiving must contain at least one line';
  end if;

  return v_receiving_id;
end $$;

revoke all on function public.fn_receive_stock(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.fn_receive_stock(uuid, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_record_sale — engine lines with a negotiated agreed price + hard floor,
-- optional partial payment, receipt number. Saves as 'recorded'.
--   p_engine_lines: [{engine_id, agreed_price_centavos}]  (preferred)
--   p_engine_ids:   [uuid]  (legacy — sells at the asking price)
-- ---------------------------------------------------------------------------
drop function if exists public.fn_record_sale(uuid, jsonb, jsonb, jsonb);

create or replace function public.fn_record_sale(
  p_customer_id uuid default null,
  p_customer jsonb default null,
  p_part_lines jsonb default '[]'::jsonb,
  p_engine_ids jsonb default '[]'::jsonb,
  p_engine_lines jsonb default '[]'::jsonb,
  p_payment_type text default 'full',
  p_amount_paid_centavos bigint default null
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
  v_part record;
  v_eng record;
  v_engine_id uuid;
  v_agreed bigint;
  v_total bigint := 0;
  v_count int := 0;
  v_has_engine boolean := false;
  v_amount_paid bigint;
  v_balance bigint;
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

  if (jsonb_array_length(coalesce(p_engine_ids, '[]'::jsonb)) > 0
      or jsonb_array_length(coalesce(p_engine_lines, '[]'::jsonb)) > 0)
     and v_customer_id is null then
    raise exception 'Engine sales require a customer (for the warranty)';
  end if;

  if p_payment_type not in ('full','partial') then
    raise exception 'Invalid payment type: %', p_payment_type;
  end if;

  insert into sales (shop_id, recorded_by, customer_id, status)
  values (v_shop, auth.uid(), v_customer_id, 'recorded')
  returning id into v_sale_id;

  -- Parts (catalog-authoritative price)
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

  -- Engines: unify the negotiated (p_engine_lines) and legacy (p_engine_ids)
  -- inputs; legacy sells at the asking price.
  for r in
    select engine_id, agreed from (
      select (x->>'engine_id')::uuid as engine_id,
             nullif(x->>'agreed_price_centavos','')::bigint as agreed
      from jsonb_array_elements(coalesce(p_engine_lines, '[]'::jsonb)) as x
      union all
      select value::uuid as engine_id, null::bigint as agreed
      from jsonb_array_elements_text(coalesce(p_engine_ids, '[]'::jsonb))
    ) q
  loop
    v_engine_id := r.engine_id;
    if v_engine_id is null then
      raise exception 'Invalid engine line';
    end if;

    select e.status, e.shop_id, e.serial_number,
           coalesce(e.price_floor_centavos,  e.price_centavos) as floor_c,
           coalesce(e.price_asking_centavos, e.price_centavos) as asking_c,
           em.brand, em.model
      into v_eng
    from engines e
    join engine_models em on em.id = e.engine_model_id
    where e.id = v_engine_id and e.deleted_at is null;
    if not found then
      raise exception 'Engine not found';
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_shop then
      raise exception 'That engine is not at your shop';
    end if;

    if exists (
      select 1 from sale_lines sl
      join sales s on s.id = sl.sale_id
      where sl.engine_id = v_engine_id
        and s.status in ('recorded','pending','questioned')
        and s.deleted_at is null
    ) then
      raise exception 'That engine is already in an open sale';
    end if;

    -- Negotiated price with the HARD FLOOR (floor derives from hidden cost).
    v_agreed := coalesce(r.agreed, v_eng.asking_c);
    if v_agreed <= 0 then
      raise exception 'Agreed price must be greater than zero';
    end if;
    if v_agreed < v_eng.floor_c then
      raise exception 'Agreed price ₱%  is below the floor ₱% for %',
        to_char(v_agreed/100.0, 'FM999999990.00'),
        to_char(v_eng.floor_c/100.0, 'FM999999990.00'),
        v_eng.serial_number;
    end if;

    insert into sale_lines
      (sale_id, engine_id, qty, unit_price_centavos, line_total_centavos, description,
       agreed_price_centavos, list_reference_centavos, discount_centavos)
    values
      (v_sale_id, v_engine_id, 1, v_agreed, v_agreed,
       v_eng.brand || ' ' || v_eng.model || ' — SN ' || v_eng.serial_number,
       v_agreed, v_eng.asking_c, v_eng.asking_c - v_agreed);

    v_total := v_total + v_agreed;
    v_count := v_count + 1;
    v_has_engine := true;
  end loop;

  if v_count = 0 then
    raise exception 'A sale needs at least one line';
  end if;

  -- Payment split
  if p_payment_type = 'partial' then
    v_amount_paid := coalesce(p_amount_paid_centavos, 0);
    if v_amount_paid < 0 then
      raise exception 'Amount paid cannot be negative';
    end if;
    if v_amount_paid > v_total then
      raise exception 'Amount paid cannot exceed the sale total';
    end if;
  else
    v_amount_paid := v_total;  -- paid in full
  end if;
  v_balance := v_total - v_amount_paid;

  update sales
  set total_centavos = v_total,
      payment_type = p_payment_type,
      amount_paid_centavos = v_amount_paid,
      balance_due_centavos = v_balance,
      receipt_no = 'OR-' || lpad(nextval('public.receipt_no_seq')::text, 6, '0'),
      receipt_generated_at = now()
  where id = v_sale_id;

  return v_sale_id;
end $$;

revoke all on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, jsonb, text, bigint) from public, anon;
grant execute on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, jsonb, text, bigint) to authenticated;
