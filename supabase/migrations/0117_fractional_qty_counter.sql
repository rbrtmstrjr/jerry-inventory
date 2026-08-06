-- ---------------------------------------------------------------------------
-- 0117 — the counter path accepts fractional quantities.
--
-- 0116 made the COLUMNS numeric(12,1). This makes the FUNCTIONS agree. Until
-- both are done a sale of 0.5 kg would still be truncated to 0 on its way in,
-- because these functions parse their JSON lines with `qty int` — the column
-- type alone does not save you.
--
-- Scope: the four functions the shop counter actually uses.
--     fn_record_sale · fn_approve_sale · fn_record_loss · fn_approve_loss
-- Receiving, deliveries, transfers and returns follow in 0118–0120. Splitting
-- is safe because NOTHING BEHAVES DIFFERENTLY until Gerry sets a product's unit
-- to Kilogram — no product is fractional yet, so a half-applied series is
-- invisible rather than broken.
--
-- HOW THESE BODIES WERE PRODUCED: mechanically, by transforming each function's
-- exact current definition (fn_record_sale from 0072, fn_approve_sale from
-- 0038, fn_record_loss from 0017, fn_approve_loss from 0008). They were NOT
-- retyped. These are long, dense, correct functions and the change is narrow;
-- a transcription slip in a live financial system is the kind of bug that
-- surfaces weeks later in the P&L. What changed, and nothing else:
--
--   * `qty int` / `v_qty int` / `p_qty int`  ->  numeric
--   * every `price * qty` wrapped in round()  (see MONEY below)
--   * a call to fn_assert_qty() on the two entry points
--
-- MONEY — the part that decides whether the books tie out.
-- 0.1 kg x P75.92 = 759.2 centavos, and money is integer centavos by contract.
-- So each LINE is rounded once and stored; totals are the sum of already
-- rounded lines. Never sum unrounded products and round at the end — the two
-- differ, and that difference is what makes a receipt disagree with a report.
--
--   fn_record_sale   line_total_centavos = round(v_unit * qty)
--                    v_total accumulates the SAME rounded value, so the sale
--                    total always equals the sum of its own lines
--                    suki card_discount_centavos likewise
--   fn_approve_sale  line_cost_centavos = round(cost * qty)   <- frozen COGS,
--                    feeds every P&L from here on
--   fn_approve_loss  value_centavos = round(cost * qty)       <- shrinkage
--
-- Rounding is per line and stored once, so it cannot accumulate: the maximum
-- error on any line is half a centavo, and it never compounds.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The one validator, called by every entry point that accepts a quantity.
-- Seventeen functions will eventually need this rule; it lives in one place.
--
-- INTERNAL ONLY. Execute is revoked from anon/authenticated/public below: it is
-- SECURITY DEFINER (it must read `parts`, which is owner-only under RLS, and a
-- shop employee legitimately cannot), so leaving it callable would make it a
-- definer function without a caller guard — exactly what test-definer-guards
-- exists to catch. Nothing outside the other definer functions calls it.
-- ---------------------------------------------------------------------------
create or replace function public.fn_assert_qty(p_part_id uuid, p_qty numeric)
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
  if p_qty is null or p_qty <= 0 then
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
    raise exception '% is sold by the % — whole numbers only (you entered %)',
      coalesce(v_name, 'That item'), coalesce(v_unit, 'piece'), p_qty;
  end if;
end
$fn$;

revoke all on function public.fn_assert_qty(uuid, numeric) from public, anon, authenticated;

create or replace function public.fn_record_sale(
  p_customer_id uuid default null,
  p_customer jsonb default null,
  p_part_lines jsonb default '[]'::jsonb,
  p_engine_lines jsonb default '[]'::jsonb,
  p_payment_type text default 'full',
  p_amount_paid_centavos bigint default null,
  p_payment_method text default 'cash',
  p_discount_card_id uuid default null
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
  -- suki card
  v_card record;
  v_engine_pct int := 0;
  v_part_pct int := 0;
  v_card_price bigint;
  v_card_discount bigint := 0;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record sales';
  end if;

  -- Resolve the suki card FIRST: the card is the customer, so the inline
  -- customer-creation below is skipped naturally (v_customer_id is set).
  if p_discount_card_id is not null then
    select dc.id, dc.customer_id into v_card
    from discount_cards dc
    where dc.id = p_discount_card_id
      and dc.status = 'active' and dc.deleted_at is null;
    if v_card is null then
      raise exception 'That suki card is not active — record the sale without it';
    end if;
    select suki_engine_discount_pct, suki_part_discount_pct
      into v_engine_pct, v_part_pct
    from settings where id = 1;
    v_customer_id := v_card.customer_id;
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

  -- ── parts: negotiable, floored at cost; suki card clamps to its price ──
  for r in
    select * from jsonb_to_recordset(coalesce(p_part_lines, '[]'::jsonb))
      as x(part_id uuid, qty numeric, unit_price_centavos bigint)
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

    -- tenths only, and whole numbers unless the unit allows otherwise
    perform public.fn_assert_qty(r.part_id, r.qty);

    if p_discount_card_id is not null then
      -- card price: pct off catalog, never at/below cost (cap at cost+1)
      v_card_price := greatest(
        round(v_part.price_centavos * (100 - v_part_pct) / 100.0)::bigint,
        v_part.cost_centavos + 1);
      -- guaranteed minimum: the cashier may go lower, never higher
      v_unit := least(coalesce(r.unit_price_centavos, v_card_price), v_card_price);
      v_card_discount := v_card_discount
        + round(greatest(0, v_part.price_centavos - v_card_price) * r.qty);
    else
      -- omitted price → catalog price; cost read server-side (never trusted)
      v_unit := coalesce(r.unit_price_centavos, v_part.price_centavos);
    end if;

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
      (v_sale_id, r.part_id, r.qty, v_unit, round(v_unit * r.qty), v_part.name,
       v_unit, v_part.price_centavos, greatest(0, v_part.price_centavos - v_unit));

    v_total := v_total + round(v_unit * r.qty);
    v_count := v_count + 1;
  end loop;

  -- ── engines: negotiable, floored at cost; suki card clamps to its price ──
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

    if p_discount_card_id is not null then
      v_card_price := greatest(
        round(v_eng.price_centavos * (100 - v_engine_pct) / 100.0)::bigint,
        v_eng.cost_centavos + 1);
      v_agreed := least(coalesce(r.agreed, v_card_price), v_card_price);
      v_card_discount := v_card_discount
        + greatest(0, v_eng.price_centavos - v_card_price);
    else
      v_agreed := coalesce(r.agreed, v_eng.price_centavos);
    end if;

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
      receipt_generated_at = now(),
      discount_card_id = p_discount_card_id,
      card_discount_centavos = v_card_discount
  where id = v_sale_id;

  return v_sale_id;
end $$;

create or replace function public.fn_approve_sale(p_sale_id uuid, p_note text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sale record;
  l record;
  v_qty numeric;
  v_eng record;
  v_months int;
  v_sold_on date;
  v_cost bigint;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve sales';
  end if;

  select * into v_sale from sales
  where id = p_sale_id and deleted_at is null
  for update;

  if v_sale is null then
    raise exception 'Sale not found';
  end if;
  if v_sale.status not in ('pending','questioned') then
    raise exception 'Sale already reviewed (status: %)', v_sale.status;
  end if;

  for l in
    select * from sale_lines where sale_id = p_sale_id
  loop
    if l.part_id is not null then
      select qty into v_qty from stock_levels
      where part_id = l.part_id and shop_id = v_sale.shop_id
      for update;

      if v_qty is null or v_qty < l.qty then
        raise exception 'Cannot approve: % would drive shop stock negative (on hand: %, selling: %)',
          coalesce(l.description, 'item'), coalesce(v_qty, 0), l.qty;
      end if;

      update stock_levels set qty = qty - l.qty
      where part_id = l.part_id and shop_id = v_sale.shop_id;

      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, sale_id, note)
      values ('sale', l.part_id, -l.qty, v_sale.shop_id, auth.uid(), p_sale_id, l.description);

      select cost_centavos into v_cost from parts where id = l.part_id;

    else
      select e.*, em.default_warranty_months into v_eng
      from engines e
      join engine_models em on em.id = e.engine_model_id
      where e.id = l.engine_id and e.deleted_at is null
      for update of e;

      if v_eng is null then
        raise exception 'Engine on this sale no longer exists';
      end if;
      if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_sale.shop_id then
        raise exception 'Cannot approve: engine % is not at this shop anymore (status: %)',
          v_eng.serial_number, v_eng.status;
      end if;
      if v_sale.customer_id is null then
        raise exception 'Engine sales need a customer before approval';
      end if;

      update engines
      set status = 'sold', customer_id = v_sale.customer_id, sold_at = now()
      where id = l.engine_id;

      -- auto-create the warranty: engine override → model default → settings
      v_months := coalesce(
        v_eng.warranty_months,
        v_eng.default_warranty_months,
        (select default_warranty_months from settings where id = 1),
        12
      );
      v_sold_on := public.ph_today();

      insert into warranties (engine_id, sale_id, customer_id, sold_on, months, expires_on)
      values (l.engine_id, p_sale_id, v_sale.customer_id, v_sold_on, v_months,
              (v_sold_on + (v_months || ' months')::interval)::date)
      on conflict (engine_id) do update
        set sale_id = excluded.sale_id,
            customer_id = excluded.customer_id,
            sold_on = excluded.sold_on,
            months = excluded.months,
            expires_on = excluded.expires_on,
            deleted_at = null;

      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, sale_id, note)
      values ('sale', l.engine_id, -1, v_sale.shop_id, auth.uid(), p_sale_id, l.description);

      -- this exact serial's own cost
      v_cost := v_eng.cost_centavos;
    end if;

    -- Freeze the COGS basis. parts.cost_centavos is mutable, so reading it at
    -- report time would let an edit silently rewrite past profit.
    insert into sale_line_costs (sale_line_id, sale_id, unit_cost_centavos, line_cost_centavos)
    values (l.id, p_sale_id, coalesce(v_cost, 0), round(coalesce(v_cost, 0) * l.qty))
    on conflict (sale_line_id) do update
      set unit_cost_centavos = excluded.unit_cost_centavos,
          line_cost_centavos = excluded.line_cost_centavos;
  end loop;

  update sales
  set status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      owner_note = coalesce(p_note, owner_note)
  where id = p_sale_id;
end $function$;

create or replace function public.fn_record_loss(
  p_part_id uuid default null,
  p_engine_id uuid default null,
  p_qty numeric default 1,
  p_reason public.loss_reason default 'nasira',
  p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_loss_id uuid;
  v_eng record;
  v_desc text;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record losses';
  end if;

  if (p_part_id is null) = (p_engine_id is null) then
    raise exception 'Provide exactly one of part or engine';
  end if;
  if p_qty is null or p_qty <= 0 then
    raise exception 'Quantity must be positive';
  end if;

  if p_part_id is not null then
    if not exists (
      select 1 from stock_levels
      where part_id = p_part_id and shop_id = v_shop
    ) then
      raise exception 'That item has not been delivered to your shop';
    end if;
    select name into v_desc from parts where id = p_part_id;
  else
    select e.status, e.shop_id, e.serial_number, em.brand, em.model into v_eng
    from engines e
    join engine_models em on em.id = e.engine_model_id
    where e.id = p_engine_id and e.deleted_at is null;
    if v_eng is null then
      raise exception 'Engine not found';
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_shop then
      raise exception 'That engine is not at your shop';
    end if;
    if p_qty <> 1 then
      raise exception 'Engine losses are one serial at a time';
    end if;
    if exists (
      select 1 from losses
      where engine_id = p_engine_id
        and status in ('recorded','pending','questioned')
        and deleted_at is null
    ) then
      raise exception 'That engine already has an open loss report';
    end if;
    v_desc := v_eng.brand || ' ' || v_eng.model || ' — SN ' || v_eng.serial_number;
  end if;

  perform public.fn_assert_qty(p_part_id, p_qty);

  insert into losses (shop_id, recorded_by, part_id, engine_id, qty, reason, note, status, description)
  values (v_shop, auth.uid(), p_part_id, p_engine_id, p_qty, p_reason, p_note, 'recorded', v_desc)
  returning id into v_loss_id;

  return v_loss_id;
end $$;

create or replace function public.fn_approve_loss(
  p_loss_id uuid,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_loss record;
  v_qty numeric;
  v_eng record;
  v_value bigint;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve losses';
  end if;

  select * into v_loss from losses
  where id = p_loss_id and deleted_at is null
  for update;

  if v_loss is null then
    raise exception 'Loss not found';
  end if;
  if v_loss.status not in ('pending','questioned') then
    raise exception 'Loss already reviewed (status: %)', v_loss.status;
  end if;

  if v_loss.part_id is not null then
    select qty into v_qty from stock_levels
    where part_id = v_loss.part_id and shop_id = v_loss.shop_id
    for update;

    if v_qty is null or v_qty < v_loss.qty then
      raise exception 'Cannot approve: % would drive shop stock negative (on hand: %, writing off: %)',
        coalesce(v_loss.description, 'item'), coalesce(v_qty, 0), v_loss.qty;
    end if;

    update stock_levels set qty = qty - v_loss.qty
    where part_id = v_loss.part_id and shop_id = v_loss.shop_id;

    select round(cost_centavos * v_loss.qty) into v_value from parts where id = v_loss.part_id;

    insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, loss_id, note)
    values ('loss', v_loss.part_id, -v_loss.qty, v_loss.shop_id, auth.uid(), p_loss_id,
            v_loss.reason || coalesce(': ' || v_loss.note, ''));

  else
    select * into v_eng from engines
    where id = v_loss.engine_id and deleted_at is null
    for update;

    if v_eng is null then
      raise exception 'Engine on this loss no longer exists';
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from v_loss.shop_id then
      raise exception 'Cannot approve: engine % is not at this shop (status: %)',
        v_eng.serial_number, v_eng.status;
    end if;

    -- write the serial off
    update engines set deleted_at = now() where id = v_loss.engine_id;
    v_value := v_eng.cost_centavos;

    insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, loss_id, note)
    values ('loss', v_loss.engine_id, -1, v_loss.shop_id, auth.uid(), p_loss_id,
            v_loss.reason || coalesce(': ' || v_loss.note, ''));
  end if;

  update losses
  set status = 'approved',
      value_centavos = v_value,
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      owner_note = coalesce(p_note, owner_note)
  where id = p_loss_id;
end $$;

