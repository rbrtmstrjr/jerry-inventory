-- 0061 — payment method on a sale (cash / gcash / bank / other)
--
-- A sale already stored HOW MUCH was paid (payment_type full|partial +
-- amount_paid). It never stored HOW — cash, GCash, bank transfer. The cashier
-- picks it at Record Sale; it prints on the customer's receipt and shows in the
-- owner's approval/reviewed detail. Same four values as a shop expense's
-- `payment_method`, so the vocabulary is one set across the app.
--
-- The method describes the money that actually changed hands at the sale: for a
-- full sale that's the whole amount; for a partial (utang) sale it's the
-- downpayment (the balance is a receivable, collected later with its own note).
--
-- Backfill: default 'cash' stamps every existing sale as cash — the only method
-- the shop had until now, and a non-sensitive field on a customer document.

alter table public.sales
  add column if not exists payment_method text not null default 'cash'
    check (payment_method in ('cash', 'gcash', 'bank', 'other'));

-- ── fn_record_sale — 0053 body verbatim + one param (p_payment_method) ──
-- Validated against the same set as the CHECK and stored in the final update.
-- Everything else (employee guard, per-line cost floor, partial-payment rules,
-- receipt-no minting) is unchanged from 0053.
drop function if exists public.fn_record_sale(uuid, jsonb, jsonb, jsonb, text, bigint);

create or replace function public.fn_record_sale(
  p_customer_id uuid default null,
  p_customer jsonb default null,
  p_part_lines jsonb default '[]'::jsonb,
  p_engine_lines jsonb default '[]'::jsonb,
  p_payment_type text default 'full',
  p_amount_paid_centavos bigint default null,
  p_payment_method text default 'cash'
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
  if p_payment_method not in ('cash','gcash','bank','other') then
    raise exception 'Invalid payment method: %', p_payment_method;
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
      payment_method = p_payment_method,
      amount_paid_centavos = v_amount_paid,
      balance_due_centavos = v_balance,
      settled_at = case when v_balance = 0 then now() else null end,
      receipt_no = 'OR-' || lpad(nextval('public.receipt_no_seq')::text, 6, '0'),
      receipt_generated_at = now()
  where id = v_sale_id;

  return v_sale_id;
end $$;

revoke all on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, text, bigint, text) from public, anon;
grant execute on function public.fn_record_sale(uuid, jsonb, jsonb, jsonb, text, bigint, text) to authenticated;
