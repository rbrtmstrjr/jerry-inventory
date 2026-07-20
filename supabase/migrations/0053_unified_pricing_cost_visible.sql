-- ============================================================================
-- 0053 — Simplify pricing: drop engine margin tiers, unify parts + engines,
-- make cost shop-visible.
--
-- Jerry asked for one model for every product: ONE selling price, editable at
-- sale time (tawad happens every sale), floored at COST — server-enforced so
-- every sale keeps at least ₱0.01 of margin. Parts become negotiable exactly
-- like engines. The 3-tier engine margins (0020/0021) are retired entirely.
--
-- NARROWS a core invariant ON PURPOSE. Cost was hidden from shops everywhere.
-- Now a shop sees the unit COST of its OWN on-hand stock (so the cashier knows
-- the floor during a tawad) — and NOTHING ELSE about cost changes. Cost is
-- exposed only by adding the column to the two security_barrier safe views
-- (shop_stock, shop_engines), which already scope rows to the caller's own
-- shop. Suppliers, quotes, price comparison, payables, receiving_lines,
-- sale_line_costs, other shops' stock, and master cost all stay owner-only —
-- the safe view is the boundary (base-table grants never change).
--
-- No hard table CHECK on price>cost (it would reject existing live rows priced
-- at/under cost); the floor is enforced in fn_record_sale + the edit actions.
-- A product priced at/under cost simply can't be sold until the owner fixes
-- it — safe, not silent.
-- ============================================================================

-- ── 1. retire the engine tier system ────────────────────────────────────────
drop trigger if exists trg_engines_sync_tier_prices on public.engines;
drop function if exists public.engines_sync_tier_prices();
drop function if exists public.fn_compute_tier_price(bigint, numeric);

-- shop_engines references the tier columns, so it must go before the columns.
drop view if exists public.shop_engines;

alter table public.engines
  drop column if exists margin_floor_pct,
  drop column if exists margin_mid_pct,
  drop column if exists margin_asking_pct,
  drop column if exists price_floor_centavos,
  drop column if exists price_mid_centavos,
  drop column if exists price_asking_centavos;
-- engines.price_centavos (held the asking tier → now the single selling price)
-- and engines.cost_centavos are kept.

-- ── 2. expose cost on the two safe views (own-shop scope preserved) ─────────
-- shop_stock: add cost at the end (create-or-replace keeps dependents valid).
create or replace view public.shop_stock
with (security_barrier = true) as
select
  sl.shop_id,
  p.id as part_id,
  p.name,
  pc.name as category,
  p.sku,
  p.barcode,
  p.unit,
  p.price_centavos,
  p.reorder_level,
  p.image_path,
  sl.qty,
  p.cost_centavos            -- 0053: own-shop cost, read-only (the tawad floor)
from public.stock_levels sl
join public.parts p on p.id = sl.part_id and p.deleted_at is null
left join public.product_categories pc on pc.id = p.category_id
where sl.shop_id is not null
  and (public.is_owner() or sl.shop_id = public.auth_shop_id());

revoke all on public.shop_stock from anon;
grant select on public.shop_stock to authenticated;

-- shop_engines: one selling price + cost, no tiers. Same delivered-at-own-shop
-- scope + security_barrier.
create view public.shop_engines
with (security_barrier = true) as
select
  e.id as engine_id,
  e.serial_number,
  em.brand,
  em.model,
  em.horsepower,
  em.stroke,
  e.condition,
  e.price_centavos,
  e.cost_centavos,          -- 0053: own-shop cost, read-only
  e.status,
  e.shop_id,
  e.image_path
from public.engines e
join public.engine_models em on em.id = e.engine_model_id
where e.deleted_at is null and e.status = 'delivered' and e.shop_id is not null
  and (public.is_owner() or e.shop_id = public.auth_shop_id());

revoke all on public.shop_engines from anon;
grant select on public.shop_engines to authenticated;

-- ── 3. fn_record_sale — unified negotiable pricing, floor = COST (strict) ────
-- Parts are now negotiable exactly like engines: every line carries an
-- optional agreed unit price that must be STRICTLY greater than the server's
-- cost reference (at-cost rejected, +1 centavo accepted). Omitted price →
-- the catalog price_centavos (which the owner keeps above cost). The legacy
-- p_engine_ids param is gone.
drop function if exists public.fn_record_sale(uuid, jsonb, jsonb, jsonb, jsonb, text, bigint);

create or replace function public.fn_record_sale(
  p_customer_id uuid default null,
  p_customer jsonb default null,
  p_part_lines jsonb default '[]'::jsonb,
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
  v_unit bigint;
  v_agreed bigint;
  v_total bigint := 0;
  v_count int := 0;
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

  if jsonb_array_length(coalesce(p_engine_lines, '[]'::jsonb)) > 0
     and v_customer_id is null then
    raise exception 'Engine sales require a customer (for the warranty)';
  end if;

  if p_payment_type not in ('full','partial') then
    raise exception 'Invalid payment type: %', p_payment_type;
  end if;
  if p_payment_type = 'partial' and v_customer_id is null then
    raise exception 'Partial payment requires a customer — record who owes the balance';
  end if;

  insert into sales (shop_id, recorded_by, customer_id, status)
  values (v_shop, auth.uid(), v_customer_id, 'recorded')
  returning id into v_sale_id;

  -- ── parts: negotiable, floored at cost ──
  for r in
    select * from jsonb_to_recordset(coalesce(p_part_lines, '[]'::jsonb))
      as x(part_id uuid, qty int, unit_price_centavos bigint)
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

    select name, unit, price_centavos, cost_centavos into v_part from parts
    where id = r.part_id and deleted_at is null;
    if v_part is null then
      raise exception 'Item not found in catalog';
    end if;

    -- omitted price → catalog price; cost read server-side (never trusted)
    v_unit := coalesce(r.unit_price_centavos, v_part.price_centavos);
    if v_unit <= v_part.cost_centavos then
      raise exception '₱% is at or below cost ₱% for % — enter a higher price',
        to_char(v_unit/100.0, 'FM999,999,990.00'),
        to_char(v_part.cost_centavos/100.0, 'FM999,999,990.00'),
        v_part.name;
    end if;

    insert into sale_lines
      (sale_id, part_id, qty, unit_price_centavos, line_total_centavos, description,
       agreed_price_centavos, list_reference_centavos, discount_centavos)
    values
      (v_sale_id, r.part_id, r.qty, v_unit, v_unit * r.qty, v_part.name,
       v_unit, v_part.price_centavos, greatest(0, v_part.price_centavos - v_unit));

    v_total := v_total + v_unit * r.qty;
    v_count := v_count + 1;
  end loop;

  -- ── engines: negotiable, floored at cost ──
  for r in
    select (x->>'engine_id')::uuid as engine_id,
           nullif(x->>'agreed_price_centavos','')::bigint as agreed
    from jsonb_array_elements(coalesce(p_engine_lines, '[]'::jsonb)) as x
  loop
    v_engine_id := r.engine_id;
    if v_engine_id is null then
      raise exception 'Invalid engine line';
    end if;

    select e.status, e.shop_id, e.serial_number, e.price_centavos, e.cost_centavos,
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

    v_agreed := coalesce(r.agreed, v_eng.price_centavos);
    if v_agreed <= v_eng.cost_centavos then
      raise exception '₱% is at or below cost ₱% for % — enter a higher price',
        to_char(v_agreed/100.0, 'FM999,999,990.00'),
        to_char(v_eng.cost_centavos/100.0, 'FM999,999,990.00'),
        v_eng.serial_number;
    end if;

    insert into sale_lines
      (sale_id, engine_id, qty, unit_price_centavos, line_total_centavos, description,
       agreed_price_centavos, list_reference_centavos, discount_centavos)
    values
      (v_sale_id, v_engine_id, 1, v_agreed, v_agreed,
       v_eng.brand || ' ' || v_eng.model || ' — SN ' || v_eng.serial_number,
       v_agreed, v_eng.price_centavos, greatest(0, v_eng.price_centavos - v_agreed));

    v_total := v_total + v_agreed;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'A sale needs at least one line';
  end if;

  if p_payment_type = 'partial' then
    v_amount_paid := coalesce(p_amount_paid_centavos, 0);
    if v_amount_paid < 0 then
      raise exception 'Amount paid cannot be negative';
    end if;
    if v_amount_paid > v_total then
      raise exception 'Amount paid cannot exceed the sale total';
    end if;
  else
    v_amount_paid := v_total;
  end if;
  v_balance := v_total - v_amount_paid;

  update sales
  set total_centavos = v_total,
      payment_type = p_payment_type,
      amount_paid_centavos = v_amount_paid,
      balance_due_centavos = v_balance,
      settled_at = case when v_balance = 0 then now() else null end,
      receipt_no = 'OR-' || lpad(nextval('public.receipt_no_seq')::text, 6, '0'),
      receipt_generated_at = now()
  where id = v_sale_id;

  return v_sale_id;
end $$;

revoke all on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, text, bigint) from public, anon;
grant execute on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, text, bigint) to authenticated;

-- ── 4. fn_receive_stock — no engine margins; optional selling price > cost ──
-- 0052 body verbatim EXCEPT: the engine recordset/insert no longer carry the
-- three margin_*_pct columns (dropped above; price comes straight from the
-- line now that the trigger is gone), and a provided selling price must be
-- above cost (part or engine). Everything else — SKU/barcode reuse, payment,
-- limit override, due date — is unchanged.
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
  if p_supplier_id is null then
    v_paid := v_total;
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
