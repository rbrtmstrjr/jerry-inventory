-- ---------------------------------------------------------------------------
-- 0048 — Receiving is the single entry point for stock
--
-- A product enters the system because a supplier delivered it. Until now that
-- truth was split across two screens: Bulk Add created products with no
-- supplier and no stock (its initial-qty receiving was hardcoded
-- p_supplier_id NULL — no debt, no last-paid history), and Receiving could
-- only stock products that already existed. A brand-new part arriving from a
-- supplier forced two screens in the right order.
--
-- fn_receive_stock now accepts NEW products inline, atomically:
--   • a part line may carry `new_part` instead of part_id
--       {name*, category_id, sku, unit, barcode, generate_barcode,
--        price_centavos, reorder_level, preferred_supplier_id, notes}
--     The part's catalog cost starts at this line's unit_cost_centavos (the
--     first purchase IS the cost), preferred_supplier defaults to the
--     receiving's supplier, and generate_barcode mints the same JM-sequence
--     Code128 as fn_generate_internal_barcode.
--   • an engine line may carry `new_model` instead of engine_model_id
--       {brand*, model*, horsepower, stroke, default_warranty_months,
--        preferred_supplier_id}
--     An existing live (brand, model) is REUSED, never duplicated — which is
--     also how two serial lines of one new model share the row the first line
--     created.
--
-- Everything else — payment status, amount paid, due date, credit-limit
-- warn+override+audit, alerts — is byte-identical to 0034. Same signature,
-- so CREATE OR REPLACE; no caller changes.
--
-- The whole receiving is ONE transaction: if any line fails (missing serial,
-- duplicate barcode), no product exists, no stock moves, no debt is created.
-- ---------------------------------------------------------------------------

create or replace function public.fn_receive_stock(
  p_supplier_id uuid,
  p_note text,
  p_parts jsonb default '[]'::jsonb,
  p_engines jsonb default '[]'::jsonb,
  p_payment_status text default 'paid',
  p_amount_paid bigint default null,
  p_due_date date default null,
  p_override boolean default false,
  p_override_reason text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receiving_id uuid;
  r record;
  v_part_id uuid;
  v_model_id uuid;
  v_engine_id uuid;
  v_np jsonb;
  v_barcode text;
  v_count int := 0;
  v_total bigint := 0;
  v_paid bigint;
  v_status text;
  v_unpaid bigint;
  v_out_before bigint := 0;
  v_limit bigint;
  v_terms int;
  v_due date;
  v_name text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can receive stock';
  end if;
  if p_payment_status not in ('unpaid','partial','paid') then
    raise exception 'Invalid payment status: %', p_payment_status;
  end if;

  -- capture BEFORE we insert anything, so the projection excludes this receiving
  if p_supplier_id is not null then
    select credit_limit, payment_terms_days, name
      into v_limit, v_terms, v_name
    from suppliers where id = p_supplier_id and deleted_at is null;
    v_out_before := public.fn_supplier_outstanding(p_supplier_id);
  end if;

  insert into receivings (supplier_id, note, created_by)
  values (p_supplier_id, p_note, auth.uid())
  returning id into v_receiving_id;

  for r in
    select * from jsonb_to_recordset(coalesce(p_parts, '[]'::jsonb))
      as x(part_id uuid, qty int, unit_cost_centavos bigint, new_part jsonb)
  loop
    v_part_id := r.part_id;

    if v_part_id is null and r.new_part is not null then
      v_np := r.new_part;
      if coalesce(trim(v_np->>'name'), '') = '' then
        raise exception 'New product line missing name';
      end if;

      v_barcode := nullif(trim(coalesce(v_np->>'barcode', '')), '');
      if v_barcode is null
         and coalesce((v_np->>'generate_barcode')::boolean, false) then
        v_barcode := 'JM' || lpad(nextval('public.internal_barcode_seq')::text, 8, '0');
      end if;

      begin
        insert into parts
          (name, category_id, sku, barcode, unit,
           cost_centavos, price_centavos, reorder_level,
           preferred_supplier_id, notes)
        values
          (trim(v_np->>'name'),
           (v_np->>'category_id')::uuid,
           nullif(trim(coalesce(v_np->>'sku', '')), ''),
           v_barcode,
           coalesce(nullif(trim(coalesce(v_np->>'unit', '')), ''), 'pc'),
           coalesce(r.unit_cost_centavos, 0),
           coalesce((v_np->>'price_centavos')::bigint, 0),
           coalesce((v_np->>'reorder_level')::int, 0),
           coalesce((v_np->>'preferred_supplier_id')::uuid, p_supplier_id),
           nullif(trim(coalesce(v_np->>'notes', '')), ''))
        returning id into v_part_id;
      exception when unique_violation then
        raise exception 'Barcode % is already in use', v_barcode;
      end;
    end if;

    if v_part_id is null then
      raise exception 'Part line missing part_id';
    end if;
    if r.qty is null or r.qty <= 0 then
      raise exception 'Part line qty must be positive';
    end if;

    insert into receiving_lines (receiving_id, part_id, qty, unit_cost_centavos)
    values (v_receiving_id, v_part_id, r.qty, coalesce(r.unit_cost_centavos, 0));

    insert into stock_levels (part_id, shop_id, qty)
    values (v_part_id, null, r.qty)
    on conflict (part_id, shop_id)
    do update set qty = stock_levels.qty + excluded.qty;

    insert into stock_movements
      (movement_type, part_id, qty_change, shop_id, actor, receiving_id, note)
    values
      ('received', v_part_id, r.qty, null, auth.uid(), v_receiving_id, p_note);

    v_total := v_total + (coalesce(r.unit_cost_centavos, 0) * r.qty);
    v_count := v_count + 1;
  end loop;

  for r in
    select * from jsonb_to_recordset(coalesce(p_engines, '[]'::jsonb))
      as x(serial_number text, engine_model_id uuid, condition text,
           cost_centavos bigint, price_centavos bigint, warranty_months int,
           margin_floor_pct numeric, margin_mid_pct numeric, margin_asking_pct numeric,
           new_model jsonb)
  loop
    if r.serial_number is null or length(trim(r.serial_number)) = 0 then
      raise exception 'Engine line missing serial_number';
    end if;

    v_model_id := r.engine_model_id;

    if v_model_id is null and r.new_model is not null then
      v_np := r.new_model;
      if coalesce(trim(v_np->>'brand'), '') = ''
         or coalesce(trim(v_np->>'model'), '') = '' then
        raise exception 'New engine model line missing brand/model';
      end if;

      -- reuse a live (brand, model) rather than duplicating it — also how two
      -- serial lines of one new model share the row the first line created
      select id into v_model_id
      from engine_models
      where lower(brand) = lower(trim(v_np->>'brand'))
        and lower(model) = lower(trim(v_np->>'model'))
        and deleted_at is null;

      if v_model_id is null then
        insert into engine_models
          (brand, model, horsepower, stroke, default_warranty_months,
           preferred_supplier_id)
        values
          (trim(v_np->>'brand'),
           trim(v_np->>'model'),
           (v_np->>'horsepower')::numeric,
           nullif(trim(coalesce(v_np->>'stroke', '')), ''),
           coalesce((v_np->>'default_warranty_months')::int, 12),
           coalesce((v_np->>'preferred_supplier_id')::uuid, p_supplier_id))
        returning id into v_model_id;
      end if;
    end if;

    if v_model_id is null then
      raise exception 'Engine line missing engine_model_id';
    end if;

    begin
      insert into engines
        (serial_number, engine_model_id, condition, cost_centavos,
         price_centavos, warranty_months, status,
         margin_floor_pct, margin_mid_pct, margin_asking_pct)
      values
        (trim(r.serial_number), v_model_id,
         coalesce(r.condition, 'brand_new'),
         coalesce(r.cost_centavos, 0), coalesce(r.price_centavos, 0),
         r.warranty_months, 'in_master',
         r.margin_floor_pct, r.margin_mid_pct, r.margin_asking_pct)
      returning id into v_engine_id;
    exception when unique_violation then
      raise exception 'Serial % already exists', trim(r.serial_number);
    end;

    insert into receiving_lines (receiving_id, engine_id, qty, unit_cost_centavos)
    values (v_receiving_id, v_engine_id, 1, coalesce(r.cost_centavos, 0));

    insert into stock_movements
      (movement_type, engine_id, qty_change, shop_id, actor, receiving_id, note)
    values
      ('received', v_engine_id, 1, null, auth.uid(), v_receiving_id, p_note);

    v_total := v_total + coalesce(r.cost_centavos, 0);
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Receiving must contain at least one line';
  end if;

  -- ── payment state ──
  if p_amount_paid is null then
    v_paid := case p_payment_status when 'paid' then v_total else 0 end;
  else
    v_paid := p_amount_paid;
  end if;
  if v_paid < 0 then
    raise exception 'Amount paid cannot be negative';
  end if;
  if v_paid > v_total then
    raise exception 'Amount paid (₱%) cannot exceed the receiving total (₱%)',
      to_char(v_paid / 100.0, 'FM999,999,990.00'),
      to_char(v_total / 100.0, 'FM999,999,990.00');
  end if;
  -- no supplier = nobody to owe
  if p_supplier_id is null then
    v_paid := v_total;
  end if;

  v_status := case
    when v_paid >= v_total then 'paid'
    when v_paid = 0 then 'unpaid'
    else 'partial'
  end;
  v_unpaid := v_total - v_paid;

  -- ── credit limit: warn + explicit override, never a silent block ──
  if v_unpaid > 0 and v_limit is not null and v_limit > 0
     and (v_out_before + v_unpaid) > v_limit then
    if not coalesce(p_override, false) then
      raise exception
        'CREDIT_LIMIT_EXCEEDED: this puts % at ₱% against a ₱% limit. Confirm with an override reason to proceed.',
        coalesce(v_name, 'this supplier'),
        to_char((v_out_before + v_unpaid) / 100.0, 'FM999,999,990.00'),
        to_char(v_limit / 100.0, 'FM999,999,990.00');
    end if;
    if coalesce(trim(p_override_reason), '') = '' then
      raise exception 'Going over the credit limit needs a reason';
    end if;
  end if;

  -- ── due date: from the supplier's terms unless told otherwise ──
  if v_unpaid > 0 then
    v_due := coalesce(
      p_due_date,
      case when v_terms is not null then public.ph_today() + v_terms else null end
    );
  else
    v_due := null;  -- nothing owed, nothing due
  end if;

  update receivings
  set total_amount = v_total,
      amount_paid = v_paid,
      payment_status = v_status,
      due_date = v_due,
      settled_at = case when v_unpaid = 0 then now() else null end,
      limit_override = coalesce(p_override, false) and v_unpaid > 0
                       and v_limit is not null and (v_out_before + v_unpaid) > v_limit,
      limit_override_reason = case
        when coalesce(p_override, false) and v_unpaid > 0
             and v_limit is not null and (v_out_before + v_unpaid) > v_limit
        then nullif(trim(coalesce(p_override_reason, '')), '') end,
      limit_override_by = case
        when coalesce(p_override, false) and v_unpaid > 0
             and v_limit is not null and (v_out_before + v_unpaid) > v_limit
        then auth.uid() end,
      limit_override_at = case
        when coalesce(p_override, false) and v_unpaid > 0
             and v_limit is not null and (v_out_before + v_unpaid) > v_limit
        then now() end
  where id = v_receiving_id;

  if p_supplier_id is not null then
    perform public.fn_check_supplier_limit_alerts(p_supplier_id);
  end if;

  return v_receiving_id;
end $$;

revoke all on function public.fn_receive_stock(uuid, text, jsonb, jsonb, text, bigint, date, boolean, text) from public, anon;
grant execute on function public.fn_receive_stock(uuid, text, jsonb, jsonb, text, bigint, date, boolean, text) to authenticated;
