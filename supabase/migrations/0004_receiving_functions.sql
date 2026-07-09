-- ============================================================================
-- 0004_receiving_functions.sql — Atomic receiving + internal barcodes
-- All multi-write stock operations happen inside SECURITY DEFINER functions
-- so stock, lines, and the ledger can never partially update.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Receive stock into MASTER (from a supplier, or manual/initial entry when
-- supplier is null). Parts by qty, engines by serial (created here).
--   p_parts:   [{part_id, qty, unit_cost_centavos}]
--   p_engines: [{serial_number, engine_model_id, condition,
--                cost_centavos, price_centavos, warranty_months}]
-- Returns the receiving id.
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

  -- Parts (quantity items)
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

  -- Engines (serialized: each row IS the unit)
  for r in
    select * from jsonb_to_recordset(coalesce(p_engines, '[]'::jsonb))
      as x(serial_number text, engine_model_id uuid, condition text,
           cost_centavos bigint, price_centavos bigint, warranty_months int)
  loop
    if r.serial_number is null or length(trim(r.serial_number)) = 0 then
      raise exception 'Engine line missing serial_number';
    end if;
    if r.engine_model_id is null then
      raise exception 'Engine line missing engine_model_id';
    end if;

    insert into engines
      (serial_number, engine_model_id, condition, cost_centavos,
       price_centavos, warranty_months, status)
    values
      (trim(r.serial_number), r.engine_model_id,
       coalesce(r.condition, 'brand_new'),
       coalesce(r.cost_centavos, 0), coalesce(r.price_centavos, 0),
       r.warranty_months, 'in_master')
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
-- Internal Code128 barcode for unbranded/repacked goods: JM00000042
-- Idempotent per part: returns the existing barcode if one is already set.
-- ---------------------------------------------------------------------------
create sequence if not exists public.internal_barcode_seq;

create or replace function public.fn_generate_internal_barcode(p_part_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing text;
  v_code text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can generate barcodes';
  end if;

  select barcode into v_existing from parts where id = p_part_id;
  if v_existing is not null and length(v_existing) > 0 then
    return v_existing;
  end if;

  v_code := 'JM' || lpad(nextval('public.internal_barcode_seq')::text, 8, '0');
  update parts set barcode = v_code where id = p_part_id;
  return v_code;
end $$;

revoke all on function public.fn_generate_internal_barcode(uuid) from public, anon;
grant execute on function public.fn_generate_internal_barcode(uuid) to authenticated;
