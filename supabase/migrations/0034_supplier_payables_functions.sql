-- ============================================================================
-- 0034_supplier_payables_functions.sql — payables RPCs. Owner-only.
--
-- The credit limit WARNS; the owner DECIDES. Exceeding it is never blocked —
-- it requires an explicit override + reason, which is recorded on the
-- receiving so it stays auditable.
--
-- Note: these functions compute balances from the BASE TABLES, not from the
-- receiving_balances / supplier_payables views. Those views carry an
-- is_owner() guard, and the daily cron runs with no JWT — reading them there
-- would silently return nothing.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- What a supplier currently owes us across all open receivings.
-- ---------------------------------------------------------------------------
create or replace function public.fn_supplier_outstanding(p_supplier_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(b.bal), 0)
  from (
    select r.total_amount - r.amount_paid
         - coalesce((select sum(sp.amount) from supplier_payments sp
                     where sp.receiving_id = r.id and sp.deleted_at is null), 0) as bal
    from receivings r
    where r.supplier_id = p_supplier_id and r.deleted_at is null
  ) b
  where b.bal > 0;
$$;

revoke all on function public.fn_supplier_outstanding(uuid) from public, anon;
grant execute on function public.fn_supplier_outstanding(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Live limit feedback for the receiving screen: "you're at X, this pushes you
-- to Y against a limit of Z". Called as the owner builds the receiving.
-- ---------------------------------------------------------------------------
create or replace function public.fn_supplier_limit_check(
  p_supplier_id uuid,
  p_additional bigint default 0
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit bigint;
  v_out bigint;
  v_proj bigint;
  v_warn int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can check supplier limits';
  end if;

  select credit_limit into v_limit from suppliers
  where id = p_supplier_id and deleted_at is null;

  v_out := public.fn_supplier_outstanding(p_supplier_id);
  v_proj := v_out + greatest(coalesce(p_additional, 0), 0);
  select supplier_limit_warn_pct into v_warn from settings where id = 1;
  v_warn := coalesce(v_warn, 80);

  return jsonb_build_object(
    'supplier_id', p_supplier_id,
    'credit_limit', v_limit,
    'outstanding', v_out,
    'projected', v_proj,
    'warn_pct', v_warn,
    'would_exceed', (v_limit is not null and v_limit > 0 and v_proj > v_limit),
    'near_limit', (v_limit is not null and v_limit > 0
                   and v_proj * 100 >= v_limit * v_warn and v_proj <= v_limit),
    'utilization_pct', case when v_limit is null or v_limit = 0 then null
                            else round(v_proj::numeric * 100 / v_limit, 1) end
  );
end $$;

revoke all on function public.fn_supplier_limit_check(uuid, bigint) from public, anon;
grant execute on function public.fn_supplier_limit_check(uuid, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- Limit alerts. Fires on receiving/payment events. Dedupe is free from
-- fn_notify (one unread per supplier per type); paying back down CLEARS the
-- open alert so it doesn't linger once the condition has passed.
-- ---------------------------------------------------------------------------
create or replace function public.fn_check_supplier_limit_alerts(p_supplier_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_limit bigint;
  v_out bigint;
  v_warn int;
  v_name text;
  v_pct numeric;
begin
  select credit_limit, name into v_limit, v_name from suppliers
  where id = p_supplier_id and deleted_at is null;
  if v_limit is null or v_limit = 0 then return; end if;

  v_out := public.fn_supplier_outstanding(p_supplier_id);
  select coalesce(supplier_limit_warn_pct, 80) into v_warn from settings where id = 1;
  v_pct := round(v_out::numeric * 100 / v_limit, 1);

  if v_out >= v_limit then
    perform public.fn_notify(
      'owner', null, 'supplier_limit_reached',
      v_name || ' is at its credit limit',
      'Owed ₱' || to_char(v_out / 100.0, 'FM999,999,990.00')
        || ' of a ₱' || to_char(v_limit / 100.0, 'FM999,999,990.00')
        || ' limit (' || v_pct || '%).',
      'suppliers', p_supplier_id);
  elsif v_out * 100 >= v_limit * v_warn then
    perform public.fn_notify(
      'owner', null, 'supplier_limit_warning',
      v_name || ' is at ' || v_pct || '% of its credit limit',
      'Owed ₱' || to_char(v_out / 100.0, 'FM999,999,990.00')
        || ' of ₱' || to_char(v_limit / 100.0, 'FM999,999,990.00') || '.',
      'suppliers', p_supplier_id);
  else
    -- back under the threshold → clear any open limit alert
    update notifications
    set read_at = now()
    where recipient_role = 'owner'
      and type in ('supplier_limit_warning','supplier_limit_reached')
      and ref_table = 'suppliers' and ref_id = p_supplier_id
      and read_at is null and deleted_at is null;
  end if;
end $$;

revoke all on function public.fn_check_supplier_limit_alerts(uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- fn_receive_stock — now records what the stock COST and what was PAID, sets
-- the due date from the supplier's terms, and enforces the credit limit with
-- an explicit, audited override.
--
-- p_payment_status defaults to 'paid' so existing callers create no debt; the
-- receiving UI always sends it explicitly.
-- ---------------------------------------------------------------------------
drop function if exists public.fn_receive_stock(uuid, text, jsonb, jsonb);

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
  v_engine_id uuid;
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

    v_total := v_total + (coalesce(r.unit_cost_centavos, 0) * r.qty);
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

-- ---------------------------------------------------------------------------
-- Record a payment to a supplier.
--   • targeted   → p_receiving_id given, one ledger row
--   • unallocated→ FIFO across that supplier's oldest open receivings; the
--     payment is SPLIT into one row per receiving, sharing a payment_group_id
--     so the UI can still show it as a single payment.
-- Can never exceed what's outstanding. Reaching zero settles the receiving.
-- ---------------------------------------------------------------------------
create or replace function public.fn_record_supplier_payment(
  p_supplier_id uuid,
  p_amount bigint,
  p_receiving_id uuid default null,
  p_paid_at date default null,
  p_method text default 'cash',
  p_reference_no text default null,
  p_note text default null,
  p_receipt_image_path text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group uuid := gen_random_uuid();
  v_left bigint;
  v_bal bigint;
  v_out bigint;
  r record;
  v_take bigint;
  v_allocs jsonb := '[]'::jsonb;
  v_paid_at date;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can record supplier payments';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'Payment must be greater than zero';
  end if;
  if p_method not in ('cash','bank','gcash','check','other') then
    raise exception 'Invalid payment method: %', p_method;
  end if;
  if not exists (select 1 from suppliers where id = p_supplier_id and deleted_at is null) then
    raise exception 'Supplier not found';
  end if;

  v_paid_at := coalesce(p_paid_at, public.ph_today());
  v_left := p_amount;

  if p_receiving_id is not null then
    -- targeted at one receiving
    if not exists (
      select 1 from receivings
      where id = p_receiving_id and supplier_id = p_supplier_id and deleted_at is null
    ) then
      raise exception 'That receiving does not belong to this supplier';
    end if;

    v_bal := public.fn_receiving_balance(p_receiving_id);
    if p_amount > v_bal then
      raise exception 'Payment ₱% exceeds the ₱% still owed on that receiving',
        to_char(p_amount / 100.0, 'FM999,999,990.00'),
        to_char(greatest(v_bal, 0) / 100.0, 'FM999,999,990.00');
    end if;

    insert into supplier_payments
      (payment_group_id, supplier_id, receiving_id, amount, paid_at, method,
       reference_no, note, receipt_image_path, created_by)
    values
      (v_group, p_supplier_id, p_receiving_id, p_amount, v_paid_at, p_method,
       nullif(trim(coalesce(p_reference_no, '')), ''),
       nullif(trim(coalesce(p_note, '')), ''),
       p_receipt_image_path, auth.uid());

    v_allocs := v_allocs || jsonb_build_object('receiving_id', p_receiving_id, 'amount', p_amount);
    v_left := 0;
  else
    -- unallocated → FIFO over the oldest open balances
    v_out := public.fn_supplier_outstanding(p_supplier_id);
    if p_amount > v_out then
      raise exception 'Payment ₱% exceeds the ₱% this supplier is owed',
        to_char(p_amount / 100.0, 'FM999,999,990.00'),
        to_char(greatest(v_out, 0) / 100.0, 'FM999,999,990.00');
    end if;

    for r in
      select r2.id,
             (r2.total_amount - r2.amount_paid
              - coalesce((select sum(sp.amount) from supplier_payments sp
                          where sp.receiving_id = r2.id and sp.deleted_at is null), 0)) as bal
      from receivings r2
      where r2.supplier_id = p_supplier_id and r2.deleted_at is null
      -- FIFO = oldest DEBT first, i.e. when it was incurred. Deliberately not
      -- ordered by due_date: a receiving with a far-future due date is still
      -- the older debt and must be cleared first.
      order by r2.received_at, r2.id
    loop
      exit when v_left <= 0;
      if r.bal <= 0 then continue; end if;

      v_take := least(v_left, r.bal);
      insert into supplier_payments
        (payment_group_id, supplier_id, receiving_id, amount, paid_at, method,
         reference_no, note, receipt_image_path, created_by)
      values
        (v_group, p_supplier_id, r.id, v_take, v_paid_at, p_method,
         nullif(trim(coalesce(p_reference_no, '')), ''),
         nullif(trim(coalesce(p_note, '')), ''),
         p_receipt_image_path, auth.uid());

      v_allocs := v_allocs || jsonb_build_object('receiving_id', r.id, 'amount', v_take);
      v_left := v_left - v_take;
    end loop;
  end if;

  -- Settle anything that reached zero.
  -- NOTE: deliberately NOT aliased. `r` is a declared record variable in this
  -- function, so `update receivings r ... where r.supplier_id` would resolve
  -- `r` to the variable, not the table ("record r is not assigned yet").
  update receivings
  set settled_at = now(), payment_status = 'paid'
  where supplier_id = p_supplier_id
    and deleted_at is null
    and settled_at is null
    and public.fn_receiving_balance(id) = 0;

  perform public.fn_check_supplier_limit_alerts(p_supplier_id);

  return jsonb_build_object(
    'payment_group_id', v_group,
    'allocations', v_allocs,
    'outstanding', public.fn_supplier_outstanding(p_supplier_id)
  );
end $$;

revoke all on function public.fn_record_supplier_payment(uuid, bigint, uuid, date, text, text, text, text) from public, anon;
grant execute on function public.fn_record_supplier_payment(uuid, bigint, uuid, date, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Daily overdue sweep (PH date). One alert per overdue receiving, deduped.
-- ---------------------------------------------------------------------------
create or replace function public.fn_check_supplier_overdue()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_n int := 0;
begin
  for r in
    select r2.id, r2.due_date, s.name as supplier_name,
           (public.ph_today() - r2.due_date) as days_over,
           (r2.total_amount - r2.amount_paid
            - coalesce((select sum(sp.amount) from supplier_payments sp
                        where sp.receiving_id = r2.id and sp.deleted_at is null), 0)) as bal
    from receivings r2
    join suppliers s on s.id = r2.supplier_id
    where r2.deleted_at is null
      and r2.due_date is not null
      and r2.due_date < public.ph_today()
  loop
    continue when r.bal <= 0;

    perform public.fn_notify(
      'owner', null, 'supplier_payment_overdue',
      'Overdue: ₱' || to_char(r.bal / 100.0, 'FM999,999,990.00') || ' to ' || r.supplier_name,
      r.days_over || ' day(s) past due (' || to_char(r.due_date, 'Mon DD, YYYY') || ').',
      'receivings', r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

revoke all on function public.fn_check_supplier_overdue() from public, anon, authenticated;
grant execute on function public.fn_check_supplier_overdue() to service_role;
