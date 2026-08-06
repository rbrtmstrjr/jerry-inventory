-- ---------------------------------------------------------------------------
-- 0118 — stock IN and OUT accept fractional quantities.
--
-- Follows 0117 (the counter). Same method: each function's exact current
-- definition, transformed — not retyped.
--     fn_receive_stock · fn_deliver_stock · fn_confirm_delivery
--     fn_resolve_delivery_discrepancy
--
-- MONEY: exactly one live site, `fn_receive_stock`'s running total, now
-- round()ed per line before summing.
--
-- Receiving needed nothing else, and it is worth saying why rather than leaving
-- it to be rediscovered: `fn_receiving_balance` reads the STORED
-- `receivings.total_amount` and subtracts payments — it never multiplies qty by
-- cost at read time. (The one `sum(qty * unit_cost)` in 0033 is a one-time
-- backfill that has already run.) So there is no second place for the rounding
-- to disagree with itself, and no view to rebuild here.
--
-- THE HELPER GAINS A THIRD ARGUMENT. `fn_confirm_delivery` records what
-- physically arrived, and ZERO is a legitimate answer — the whole discrepancy
-- flow exists for that case. The 2-arg validator from 0117 rejects `qty <= 0`,
-- so it would refuse a delivery that simply did not turn up. p_allow_zero fixes
-- that without weakening the rule anywhere else.
--
-- The 2-arg form is dropped first: leaving both would make
-- `fn_assert_qty(uuid, numeric)` ambiguous against the 3-arg version's default,
-- and Postgres would refuse the call at runtime with "function is not unique".
-- 0117's callers resolve to the new signature via the default — nothing there
-- needs editing.
-- ---------------------------------------------------------------------------

drop function if exists public.fn_assert_qty(uuid, numeric);

create or replace function public.fn_assert_qty(
  p_part_id    uuid,
  p_qty        numeric,
  p_allow_zero boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_name text;
  v_unit text;
  v_frac boolean;
begin
  if p_qty is null then
    raise exception 'Quantity is required';
  end if;

  -- Confirming a delivery may legitimately report zero received.
  if p_qty < 0 or (p_qty = 0 and not p_allow_zero) then
    raise exception 'Quantity must be more than zero';
  end if;

  -- Tenths only. numeric(12,1) would silently ROUND 0.12 to 0.1; Gerry asked
  -- for it to be refused, and a silent round on a weighed sale is a wrong
  -- receipt nobody notices.
  if p_qty <> round(p_qty, 1) then
    raise exception
      'Quantity % has too many decimals — one only, e.g. 0.5 or 2.3', p_qty;
  end if;

  -- Engines pass part_id null and are fixed at 1 by their own CHECK.
  if p_part_id is null then
    return;
  end if;

  select p.name, p.unit, coalesce(u.allows_fractional, false)
    into v_name, v_unit, v_frac
    from public.parts p
    left join public.units u on u.code = p.unit
   where p.id = p_part_id;

  -- The unit decides. Nails are sold by the kilo; spark plugs are not sold in
  -- halves. This is the rule 0114/0115 exist to make trustworthy.
  if not v_frac and p_qty <> round(p_qty, 0) then
    raise exception '% is measured in %, so whole numbers only (you entered %)',
      coalesce(v_name, 'That item'), coalesce(v_unit, 'pieces'), p_qty;
  end if;
end
$fn$;

revoke all on function public.fn_assert_qty(uuid, numeric, boolean) from public, anon, authenticated;

create or replace function public.fn_receive_stock(
  p_supplier_id uuid,
  p_note text,
  p_parts jsonb default '[]'::jsonb,
  p_engines jsonb default '[]'::jsonb,
  p_payment_status text default 'paid',
  p_amount_paid bigint default null,
  p_due_date date default null,
  p_override boolean default false,
  p_override_reason text default null,
  p_payment_method text default null,
  p_reference_no text default null
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
  v_sku text;
  v_np_price bigint;
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
  if p_payment_method is not null
     and p_payment_method not in ('cash','bank','gcash','check','other') then
    raise exception 'Invalid payment method: %', p_payment_method;
  end if;

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
      as x(part_id uuid, qty numeric, unit_cost_centavos bigint, new_part jsonb)
  loop
    v_part_id := r.part_id;

    if v_part_id is null and r.new_part is not null then
      v_np := r.new_part;
      if coalesce(trim(v_np->>'name'), '') = '' then
        raise exception 'New product line missing name';
      end if;

      v_np_price := coalesce((v_np->>'price_centavos')::bigint, 0);
      if v_np_price > 0 and v_np_price <= coalesce(r.unit_cost_centavos, 0) then
        raise exception 'Selling price ₱% must be above cost ₱% for %',
          to_char(v_np_price/100.0, 'FM999,999,990.00'),
          to_char(coalesce(r.unit_cost_centavos,0)/100.0, 'FM999,999,990.00'),
          trim(v_np->>'name');
      end if;

      v_barcode := nullif(trim(coalesce(v_np->>'barcode', '')), '');
      v_sku := nullif(trim(coalesce(v_np->>'sku', '')), '');

      if v_barcode is not null then
        select id into v_part_id from parts
        where barcode = v_barcode and deleted_at is null and merged_into is null
        limit 1;
      end if;
      if v_part_id is null and v_sku is not null then
        select id into v_part_id from parts
        where lower(sku) = lower(v_sku) and deleted_at is null and merged_into is null
        limit 1;
      end if;

      if v_part_id is null then
        if v_barcode is null
           and coalesce((v_np->>'generate_barcode')::boolean, false) then
          v_barcode := 'GT' || lpad(nextval('public.internal_barcode_seq')::text, 8, '0');
        end if;
        begin
          insert into parts
            (name, category_id, sku, barcode, unit,
             cost_centavos, price_centavos, reorder_level,
             preferred_supplier_id, notes)
          values
            (trim(v_np->>'name'),
             (v_np->>'category_id')::uuid,
             v_sku,
             v_barcode,
             coalesce(nullif(trim(coalesce(v_np->>'unit', '')), ''), 'pc'),
             coalesce(r.unit_cost_centavos, 0),
             v_np_price,
             coalesce((v_np->>'reorder_level')::int, 0),
             coalesce((v_np->>'preferred_supplier_id')::uuid, p_supplier_id),
             nullif(trim(coalesce(v_np->>'notes', '')), ''))
          returning id into v_part_id;
        exception when unique_violation then
          raise exception 'Barcode % is already in use', v_barcode;
        end;
      end if;
    end if;

    if v_part_id is null then
      raise exception 'Part line missing part_id';
    end if;
    -- qty 0 is allowed (Add product with no opening stock): it registers the
    -- catalog row only — no receiving_line (its CHECK is qty > 0), no stock,
    -- no movement. Negative is still rejected.
    if r.qty is null or r.qty < 0 then
      raise exception 'Part line qty cannot be negative';
    end if;

    if r.qty > 0 then
      perform public.fn_assert_qty(v_part_id, r.qty);

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

      v_total := v_total + round(coalesce(r.unit_cost_centavos, 0) * r.qty);
    end if;
    v_count := v_count + 1;
  end loop;

  for r in
    select * from jsonb_to_recordset(coalesce(p_engines, '[]'::jsonb))
      as x(serial_number text, engine_model_id uuid, condition text,
           cost_centavos bigint, price_centavos bigint, warranty_months int,
           new_model jsonb)
  loop
    if r.serial_number is null or length(trim(r.serial_number)) = 0 then
      raise exception 'Engine line missing serial_number';
    end if;
    if coalesce(r.price_centavos, 0) > 0
       and coalesce(r.price_centavos, 0) <= coalesce(r.cost_centavos, 0) then
      raise exception 'Selling price ₱% must be above cost ₱% for serial %',
        to_char(r.price_centavos/100.0, 'FM999,999,990.00'),
        to_char(coalesce(r.cost_centavos,0)/100.0, 'FM999,999,990.00'),
        trim(r.serial_number);
    end if;

    v_model_id := r.engine_model_id;

    if v_model_id is null and r.new_model is not null then
      v_np := r.new_model;
      if coalesce(trim(v_np->>'brand'), '') = ''
         or coalesce(trim(v_np->>'model'), '') = '' then
        raise exception 'New engine model line missing brand/model';
      end if;

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
         price_centavos, warranty_months, status)
      values
        (trim(r.serial_number), v_model_id,
         coalesce(r.condition, 'brand_new'),
         coalesce(r.cost_centavos, 0), coalesce(r.price_centavos, 0),
         r.warranty_months, 'in_master')
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

  -- ── Supplier-less "Add product / Add engine": no invoice, no debt ──────────
  -- Stock + received movements + line costs are booked above; the header is a
  -- settled, zero-value receiving. Skip ALL supplier/debt/limit/alert logic.
  -- payment_method/reference_no stay null — no money moved.
  if p_supplier_id is null then
    update receivings
    set total_amount = 0,
        amount_paid = 0,
        payment_status = 'paid',
        due_date = null,
        settled_at = now()
    where id = v_receiving_id;
    return v_receiving_id;
  end if;

  -- ── Supplier present: debt resolution (unchanged from 0053) ───────────────
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

  v_status := case
    when v_paid >= v_total then 'paid'
    when v_paid = 0 then 'unpaid'
    else 'partial'
  end;
  v_unpaid := v_total - v_paid;

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

  if v_unpaid > 0 then
    v_due := coalesce(
      p_due_date,
      case when v_terms is not null then public.ph_today() + v_terms else null end
    );
  else
    v_due := null;
  end if;

  update receivings
  set total_amount = v_total,
      amount_paid = v_paid,
      payment_status = v_status,
      due_date = v_due,
      -- how the up-front money moved (only when money actually moved)
      payment_method = case when v_paid > 0 then coalesce(p_payment_method, 'cash') end,
      reference_no = case when v_paid > 0
        then nullif(trim(coalesce(p_reference_no, '')), '') end,
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

  perform public.fn_check_supplier_limit_alerts(p_supplier_id);

  return v_receiving_id;
end $$;

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
  v_master_qty numeric;
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
      as x(part_id uuid, qty numeric)
  loop
    if r.part_id is null or r.qty is null or r.qty <= 0 then
      raise exception 'Invalid part line';
    end if;

    perform public.fn_assert_qty(r.part_id, r.qty);

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
  v_damaged_line int;
  v_short int := 0;      -- outstanding = damaged + missing
  v_damaged int := 0;
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
      as x(line_id uuid, qty_received numeric, qty_damaged numeric, shop_note text, damage_photo_path text)
  loop
    select * into v_line from delivery_lines
    where id = r.line_id and delivery_id = p_delivery_id
    for update;
    if not found then
      raise exception 'That line is not part of this delivery';
    end if;

    v_damaged_line := coalesce(r.qty_damaged, 0);
    if r.qty_received is null or r.qty_received < 0 then
      raise exception 'Received quantity cannot be negative';
    end if;

    perform public.fn_assert_qty(v_line.part_id, r.qty_received, true);
    perform public.fn_assert_qty(v_line.part_id, v_damaged_line, true);
    if v_damaged_line < 0 then
      raise exception 'Damaged quantity cannot be negative';
    end if;
    -- good + damaged can NEVER exceed what was sent
    if r.qty_received + v_damaged_line > v_line.qty then
      raise exception 'Good + damaged cannot exceed what was sent (sent %, entered % good + % damaged)',
        v_line.qty, r.qty_received, v_damaged_line;
    end if;
    -- a damage photo must live under the confirming shop's own prefix
    if r.damage_photo_path is not null and length(trim(r.damage_photo_path)) > 0
       and r.damage_photo_path not like 'shop-' || v_shop::text || '/%' then
      raise exception 'Damage photo must be stored under your own shop folder';
    end if;

    update delivery_lines
    set qty_received = r.qty_received,
        qty_damaged = v_damaged_line,
        shop_note = nullif(trim(coalesce(r.shop_note, '')), ''),
        damage_photo_path = nullif(trim(coalesce(r.damage_photo_path, '')), '')
    where id = r.line_id;

    -- Only the GOOD units land. Damaged + missing stay outstanding.
    if r.qty_received > 0 then
      if v_line.part_id is not null then
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

    v_damaged := v_damaged + v_damaged_line;
    v_short := v_short + (v_line.qty - r.qty_received);  -- damaged + missing
  end loop;

  -- Any shortfall (damaged OR missing) → discrepancy for the owner to resolve.
  update deliveries
  set status = case when v_short > 0 then 'discrepancy' else 'confirmed' end,
      confirmed_at = now(),
      confirmed_by = auth.uid()
  where id = p_delivery_id;

  select name into v_shop_name from shops where id = v_shop;
  if v_short > 0 then
    perform public.fn_notify(
      'owner', v_shop, 'delivery_discrepancy',
      coalesce(v_shop_name, 'A shop') || ': ' || v_short || ' item(s) need your decision',
      'Received ' || v_landed || ' good · ' || v_damaged || ' damaged · '
        || (v_short - v_damaged) || ' missing — resolve the damaged & missing.',
      'deliveries', p_delivery_id);
  else
    perform public.fn_notify(
      'owner', v_shop, 'delivery_confirmed',
      coalesce(v_shop_name, 'A shop') || ' confirmed a delivery in full',
      v_landed || ' item(s) received.',
      'deliveries', p_delivery_id);
  end if;

  return jsonb_build_object(
    'landed', v_landed,
    'damaged', v_damaged,
    'missing', v_short - v_damaged,
    'short', v_short,
    'status', case when v_short > 0 then 'discrepancy' else 'confirmed' end);
end $$;

create or replace function public.fn_resolve_delivery_discrepancy(
  p_delivery_line_id uuid,
  p_qty numeric,
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

