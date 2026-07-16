-- ============================================================================
-- 0023_utang_payment_functions.sql — utang payments ride the SAME approval
-- pipeline as sales/losses.
--   record ('recorded', invisible to owner) → fn_submit_shop_batch ('pending')
--   → fn_approve_batch / fn_approve_utang_payment ('approved') → balance drops.
-- Nothing reduces a balance until the owner approves it.
-- Also: partial-payment sales now REQUIRE a customer (every utang has a name).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Current outstanding balance for a sale. Only APPROVED payments count.
-- ---------------------------------------------------------------------------
create or replace function public.fn_sale_balance(p_sale_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select s.total_centavos
       - coalesce(s.amount_paid_centavos, 0)
       - coalesce((
           select sum(up.amount_centavos)
           from utang_payments up
           where up.sale_id = s.id
             and up.status = 'approved'
             and up.deleted_at is null
         ), 0)
  from sales s
  where s.id = p_sale_id and s.deleted_at is null;
$$;

revoke all on function public.fn_sale_balance(uuid) from public, anon;
grant execute on function public.fn_sale_balance(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Record a balance payment — saves as 'recorded'. NO balance change yet.
-- ---------------------------------------------------------------------------
create or replace function public.fn_record_utang_payment(
  p_sale_id uuid,
  p_amount_centavos bigint,
  p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_sale record;
  v_balance bigint;
  v_open bigint;
  v_remaining bigint;
  v_id uuid;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record payments';
  end if;

  select id, shop_id, customer_id, payment_type, status into v_sale
  from sales where id = p_sale_id and deleted_at is null;
  if not found then
    raise exception 'Sale not found';
  end if;
  if v_sale.shop_id is distinct from v_shop then
    raise exception 'That sale belongs to another shop';
  end if;
  if v_sale.payment_type <> 'partial' then
    raise exception 'That sale has no balance to collect';
  end if;
  if v_sale.status = 'rejected' then
    raise exception 'That sale was rejected — there is no balance to collect';
  end if;
  if p_amount_centavos is null or p_amount_centavos <= 0 then
    raise exception 'Payment must be greater than zero';
  end if;

  -- Outstanding = approved-only balance, less anything already recorded or
  -- awaiting the owner (so the same peso can't be recorded twice).
  v_balance := public.fn_sale_balance(p_sale_id);
  v_open := coalesce((
    select sum(amount_centavos) from utang_payments
    where sale_id = p_sale_id
      and status in ('recorded','pending','questioned')
      and deleted_at is null
  ), 0);
  v_remaining := v_balance - v_open;

  if p_amount_centavos > v_remaining then
    raise exception 'Payment ₱% exceeds the remaining balance ₱%',
      to_char(p_amount_centavos / 100.0, 'FM999999990.00'),
      to_char(greatest(v_remaining, 0) / 100.0, 'FM999999990.00');
  end if;

  insert into utang_payments
    (sale_id, customer_id, shop_id, amount_centavos, status, note, recorded_by)
  values
    (p_sale_id, v_sale.customer_id, v_shop, p_amount_centavos, 'recorded',
     nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.fn_record_utang_payment(uuid, bigint, text) from public, anon;
grant execute on function public.fn_record_utang_payment(uuid, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Approve one payment: re-validates against the CURRENT balance (another
-- payment may have been approved first), then settles the sale at zero.
-- ---------------------------------------------------------------------------
create or replace function public.fn_approve_utang_payment(
  p_payment_id uuid,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_p record;
  v_balance bigint;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve payments';
  end if;

  select * into v_p from utang_payments
  where id = p_payment_id and deleted_at is null
  for update;
  if not found then
    raise exception 'Payment not found';
  end if;
  if v_p.status not in ('pending','questioned') then
    raise exception 'Payment already reviewed (status: %)', v_p.status;
  end if;

  v_balance := public.fn_sale_balance(v_p.sale_id);
  if v_p.amount_centavos > v_balance then
    raise exception 'Cannot approve: ₱% exceeds the remaining balance ₱%',
      to_char(v_p.amount_centavos / 100.0, 'FM999999990.00'),
      to_char(greatest(v_balance, 0) / 100.0, 'FM999999990.00');
  end if;

  update utang_payments
  set status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      owner_note = coalesce(p_note, owner_note)
  where id = p_payment_id;

  -- Fully paid? mark settled (and un-settle if it ever goes back up).
  if public.fn_sale_balance(v_p.sale_id) = 0 then
    update sales set settled_at = now()
    where id = v_p.sale_id and settled_at is null;
  else
    update sales set settled_at = null
    where id = v_p.sale_id and settled_at is not null;
  end if;
end $$;

revoke all on function public.fn_approve_utang_payment(uuid, text) from public, anon;
grant execute on function public.fn_approve_utang_payment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Submit: sales + losses + payments all flip recorded → pending in ONE batch.
-- ---------------------------------------------------------------------------
create or replace function public.fn_submit_shop_batch()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_batch uuid;
  v_sales int;
  v_losses int;
  v_payments int;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can submit the batch';
  end if;

  insert into submission_batches (shop_id, submitted_by)
  values (v_shop, auth.uid())
  returning id into v_batch;

  update sales set status = 'pending', batch_id = v_batch
  where shop_id = v_shop and status = 'recorded' and deleted_at is null;
  get diagnostics v_sales = row_count;

  update losses set status = 'pending', batch_id = v_batch
  where shop_id = v_shop and status = 'recorded' and deleted_at is null;
  get diagnostics v_losses = row_count;

  update utang_payments set status = 'pending', batch_id = v_batch
  where shop_id = v_shop and status = 'recorded' and deleted_at is null;
  get diagnostics v_payments = row_count;

  if v_sales + v_losses + v_payments = 0 then
    raise exception 'Nothing to submit — no recorded sales, losses or payments';
  end if;

  return jsonb_build_object(
    'batch_id', v_batch,
    'sales', v_sales,
    'losses', v_losses,
    'payments', v_payments
  );
end $$;

revoke all on function public.fn_submit_shop_batch() from public, anon;
grant execute on function public.fn_submit_shop_batch() to authenticated;

-- ---------------------------------------------------------------------------
-- Approve the whole batch — now including utang payments.
-- ---------------------------------------------------------------------------
create or replace function public.fn_approve_batch(
  p_batch_id uuid,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_sales int := 0;
  v_losses int := 0;
  v_payments int := 0;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve batches';
  end if;

  if not exists (
    select 1 from submission_batches where id = p_batch_id and deleted_at is null
  ) then
    raise exception 'Batch not found';
  end if;

  for r in
    select id from sales
    where batch_id = p_batch_id and status = 'pending' and deleted_at is null
    order by created_at
  loop
    perform public.fn_approve_sale(r.id, p_note);
    v_sales := v_sales + 1;
  end loop;

  for r in
    select id from losses
    where batch_id = p_batch_id and status = 'pending' and deleted_at is null
    order by created_at
  loop
    perform public.fn_approve_loss(r.id, p_note);
    v_losses := v_losses + 1;
  end loop;

  for r in
    select id from utang_payments
    where batch_id = p_batch_id and status = 'pending' and deleted_at is null
    order by created_at
  loop
    perform public.fn_approve_utang_payment(r.id, p_note);
    v_payments := v_payments + 1;
  end loop;

  if v_sales + v_losses + v_payments = 0 then
    raise exception 'Nothing pending in this batch — items were already reviewed or are questioned';
  end if;

  return jsonb_build_object('sales', v_sales, 'losses', v_losses, 'payments', v_payments);
end $$;

revoke all on function public.fn_approve_batch(uuid, text) from public, anon;
grant execute on function public.fn_approve_batch(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Question / reject — now also accepts p_kind = 'payment'.
-- ---------------------------------------------------------------------------
create or replace function public.fn_review_submission(
  p_kind text,          -- 'sale' | 'loss' | 'payment'
  p_id uuid,
  p_action text,        -- 'question' | 'reject'
  p_note text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.submission_status;
  v_new public.submission_status;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can review submissions';
  end if;
  if p_action not in ('question','reject') then
    raise exception 'Unknown action %', p_action;
  end if;
  if p_action = 'question' and coalesce(trim(p_note), '') = '' then
    raise exception 'A question needs a note for the employee';
  end if;

  v_new := case p_action when 'question' then 'questioned'::public.submission_status
                         else 'rejected'::public.submission_status end;

  if p_kind = 'sale' then
    select status into v_status from sales where id = p_id and deleted_at is null for update;
    if v_status is null then raise exception 'Sale not found'; end if;
    if v_status not in ('pending','questioned') then
      raise exception 'Sale already reviewed (status: %)', v_status;
    end if;
    update sales
    set status = v_new, owner_note = p_note,
        reviewed_by = case when p_action = 'reject' then auth.uid() else reviewed_by end,
        reviewed_at = case when p_action = 'reject' then now() else reviewed_at end
    where id = p_id;

  elsif p_kind = 'loss' then
    select status into v_status from losses where id = p_id and deleted_at is null for update;
    if v_status is null then raise exception 'Loss not found'; end if;
    if v_status not in ('pending','questioned') then
      raise exception 'Loss already reviewed (status: %)', v_status;
    end if;
    update losses
    set status = v_new, owner_note = p_note,
        reviewed_by = case when p_action = 'reject' then auth.uid() else reviewed_by end,
        reviewed_at = case when p_action = 'reject' then now() else reviewed_at end
    where id = p_id;

  elsif p_kind = 'payment' then
    select status into v_status from utang_payments where id = p_id and deleted_at is null for update;
    if v_status is null then raise exception 'Payment not found'; end if;
    if v_status not in ('pending','questioned') then
      raise exception 'Payment already reviewed (status: %)', v_status;
    end if;
    update utang_payments
    set status = v_new, owner_note = p_note,
        reviewed_by = case when p_action = 'reject' then auth.uid() else reviewed_by end,
        reviewed_at = case when p_action = 'reject' then now() else reviewed_at end
    where id = p_id;

  else
    raise exception 'Unknown kind %', p_kind;
  end if;
end $$;

revoke all on function public.fn_review_submission(text, uuid, text, text) from public, anon;
grant execute on function public.fn_review_submission(text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_record_sale — partial payment now REQUIRES a customer (every utang is
-- traceable to a person). Body otherwise unchanged from 0021.
-- ---------------------------------------------------------------------------
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

  -- Every utang must be traceable to a person.
  if p_payment_type = 'partial' and v_customer_id is null then
    raise exception 'Partial payment requires a customer — record who owes the balance';
  end if;

  insert into sales (shop_id, recorded_by, customer_id, status)
  values (v_shop, auth.uid(), v_customer_id, 'recorded')
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

revoke all on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, jsonb, text, bigint) from public, anon;
grant execute on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, jsonb, text, bigint) to authenticated;
