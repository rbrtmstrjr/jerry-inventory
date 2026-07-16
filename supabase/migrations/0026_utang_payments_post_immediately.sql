-- ============================================================================
-- 0026_utang_payments_post_immediately.sql — utang payments no longer queue.
--
-- CHANGE OF POLICY (supersedes 0023): collecting a balance is bookkeeping on
-- money the customer ALREADY owes — it is not a stock decision, so it does not
-- belong in the sales Approval Queue. A payment now POSTS IMMEDIATELY: the
-- balance drops on record, the owner is ALERTED, and the full payment history
-- (who recorded it, when, and any void) stays on the receivable.
--
-- Control moves from preventive (approve before it counts) to detective
-- (every payment is alerted + permanently in history, voids included).
--
-- Safe to apply as-is: there were no utang_payments rows yet.
-- ============================================================================

-- New alert types for the dispatcher.
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'master_low_stock','shop_low_stock','delivery_request',
  'delivery_request_fulfilled','delivery_request_dismissed',
  'utang_payment','utang_payment_voided'
));

-- ---------------------------------------------------------------------------
-- Record a payment — posts straight away.
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
  v_after bigint;
  v_id uuid;
  v_shop_name text;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record payments';
  end if;

  select s.id, s.shop_id, s.customer_id, s.payment_type, s.status,
         c.name as customer_name
    into v_sale
  from sales s
  left join customers c on c.id = s.customer_id
  where s.id = p_sale_id and s.deleted_at is null;
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

  v_balance := public.fn_sale_balance(p_sale_id);
  if p_amount_centavos > v_balance then
    raise exception 'Payment ₱% exceeds the outstanding balance ₱%',
      to_char(p_amount_centavos / 100.0, 'FM999,999,990.00'),
      to_char(greatest(v_balance, 0) / 100.0, 'FM999,999,990.00');
  end if;

  -- 'approved' == posted. reviewed_by stays NULL: nobody reviewed it, the
  -- shop posted it directly (see the policy note at the top of this file).
  insert into utang_payments
    (sale_id, customer_id, shop_id, amount_centavos, status, note, recorded_by, reviewed_at)
  values
    (p_sale_id, v_sale.customer_id, v_shop, p_amount_centavos, 'approved',
     nullif(trim(coalesce(p_note, '')), ''), auth.uid(), now())
  returning id into v_id;

  v_after := public.fn_sale_balance(p_sale_id);
  if v_after = 0 then
    update sales set settled_at = now() where id = p_sale_id and settled_at is null;
  end if;

  select name into v_shop_name from shops where id = v_shop;
  -- ref = the PAYMENT, so each collection alerts separately (dedupe is keyed
  -- on ref_id; using the sale would swallow the 2nd payment while unread).
  perform public.fn_notify(
    'owner', v_shop, 'utang_payment',
    '₱' || to_char(p_amount_centavos / 100.0, 'FM999,999,990.00')
      || ' utang payment from ' || coalesce(v_sale.customer_name, 'a customer'),
    coalesce(v_shop_name, 'A shop') || ' collected a balance payment · remaining ₱'
      || to_char(v_after / 100.0, 'FM999,999,990.00'),
    'utang_payments', v_id);

  return v_id;
end $$;

revoke all on function public.fn_record_utang_payment(uuid, bigint, text) from public, anon;
grant execute on function public.fn_record_utang_payment(uuid, bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Void a payment (mistake/typo). SOFT delete so the history keeps the record;
-- the balance goes straight back up. Owner, or the shop that recorded it.
-- ---------------------------------------------------------------------------
create or replace function public.fn_void_utang_payment(
  p_id uuid,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_p record;
  v_shop_name text;
begin
  select * into v_p from utang_payments
  where id = p_id and deleted_at is null
  for update;
  if not found then
    raise exception 'Payment not found';
  end if;

  if not (public.is_owner() or v_p.shop_id = public.auth_shop_id()) then
    raise exception 'You can only void your own shop''s payments';
  end if;

  update utang_payments
  set deleted_at = now(),
      owner_note = coalesce(nullif(trim(coalesce(p_reason, '')), ''), owner_note)
  where id = p_id;

  -- balance rose again → the sale is no longer settled
  if public.fn_sale_balance(v_p.sale_id) > 0 then
    update sales set settled_at = null
    where id = v_p.sale_id and settled_at is not null;
  end if;

  select name into v_shop_name from shops where id = v_p.shop_id;
  perform public.fn_notify(
    'owner', v_p.shop_id, 'utang_payment_voided',
    '₱' || to_char(v_p.amount_centavos / 100.0, 'FM999,999,990.00')
      || ' utang payment voided',
    coalesce(v_shop_name, 'A shop') || ' voided a payment · balance restored to ₱'
      || to_char(public.fn_sale_balance(v_p.sale_id) / 100.0, 'FM999,999,990.00'),
    'utang_payments', p_id);
end $$;

revoke all on function public.fn_void_utang_payment(uuid, text) from public, anon;
grant execute on function public.fn_void_utang_payment(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Payments leave the batch pipeline: submit + approve go back to sales+losses.
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

  if v_sales + v_losses = 0 then
    raise exception 'Nothing to submit — no recorded sales or losses';
  end if;

  return jsonb_build_object('batch_id', v_batch, 'sales', v_sales, 'losses', v_losses);
end $$;

revoke all on function public.fn_submit_shop_batch() from public, anon;
grant execute on function public.fn_submit_shop_batch() to authenticated;

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

  if v_sales + v_losses = 0 then
    raise exception 'Nothing pending in this batch — items were already reviewed or are questioned';
  end if;

  return jsonb_build_object('sales', v_sales, 'losses', v_losses);
end $$;

revoke all on function public.fn_approve_batch(uuid, text) from public, anon;
grant execute on function public.fn_approve_batch(uuid, text) to authenticated;

-- No longer part of the flow.
drop function if exists public.fn_approve_utang_payment(uuid, text);
