-- 0068 — payer details on an utang payment
--
-- Gerry's ask: when a shop records a balance (utang) payment, capture HOW it was
-- paid (method) and WHO physically paid — a name (required) + optional contact.
-- The debtor and the person handing over the cash aren't always the same (a
-- relative pays, someone sends via GCash), so this is an audit detail on the
-- payment, kept in the payment history alongside the amount.
--
-- Descriptive only: the balance math is unchanged (still total − amount_paid −
-- Σ approved payments). Same four-value method vocabulary as sales + expenses.

alter table public.utang_payments
  add column if not exists method text not null default 'cash'
    check (method in ('cash', 'gcash', 'bank', 'other')),
  add column if not exists payer_name text,
  add column if not exists payer_contact text;
-- existing rows: method defaults to 'cash'; payer left null (never captured before).

-- Recreate the recorder with the new params. Drop the old 3-arg signature first
-- so PostgREST doesn't see two overloads.
drop function if exists public.fn_record_utang_payment(uuid, bigint, text);

create or replace function public.fn_record_utang_payment(
  p_sale_id uuid,
  p_amount_centavos bigint,
  p_note text default null,
  p_method text default 'cash',
  p_payer_name text default null,
  p_payer_contact text default null
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
  v_method text := lower(coalesce(nullif(trim(p_method), ''), 'cash'));
  v_payer text := nullif(trim(coalesce(p_payer_name, '')), '');
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record payments';
  end if;

  if v_method not in ('cash', 'gcash', 'bank', 'other') then
    raise exception 'Invalid payment method';
  end if;
  if v_payer is null then
    raise exception 'The payer''s name is required';
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

  insert into utang_payments
    (sale_id, customer_id, shop_id, amount_centavos, status, note, recorded_by,
     reviewed_at, method, payer_name, payer_contact)
  values
    (p_sale_id, v_sale.customer_id, v_shop, p_amount_centavos, 'approved',
     nullif(trim(coalesce(p_note, '')), ''), auth.uid(), now(),
     v_method, v_payer, nullif(trim(coalesce(p_payer_contact, '')), ''))
  returning id into v_id;

  v_after := public.fn_sale_balance(p_sale_id);
  if v_after = 0 then
    update sales set settled_at = now() where id = p_sale_id and settled_at is null;
  end if;

  select name into v_shop_name from shops where id = v_shop;
  perform public.fn_notify(
    'owner', v_shop, 'utang_payment',
    '₱' || to_char(p_amount_centavos / 100.0, 'FM999,999,990.00')
      || ' utang payment from ' || v_payer,
    coalesce(v_shop_name, 'A shop') || ' collected a balance payment · remaining ₱'
      || to_char(v_after / 100.0, 'FM999,999,990.00'),
    'utang_payments', v_id);

  return v_id;
end $$;

revoke all on function public.fn_record_utang_payment(uuid, bigint, text, text, text, text) from public, anon;
grant execute on function public.fn_record_utang_payment(uuid, bigint, text, text, text, text) to authenticated;
