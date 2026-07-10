-- ============================================================================
-- 0017_batch_submissions.sql — shop batch flow.
-- fn_record_sale / fn_record_loss now save as 'recorded' (invisible to the
-- owner's queue); fn_submit_shop_batch flips everything recorded → pending
-- in one go, at the employee's chosen moment.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- fn_record_sale → status 'recorded'
-- ---------------------------------------------------------------------------
create or replace function public.fn_record_sale(
  p_customer_id uuid default null,
  p_customer jsonb default null,
  p_part_lines jsonb default '[]'::jsonb,
  p_engine_ids jsonb default '[]'::jsonb
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
  v_engine_id uuid;
  v_part record;
  v_total bigint := 0;
  v_count int := 0;
  v_eng record;
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

  if jsonb_array_length(coalesce(p_engine_ids, '[]'::jsonb)) > 0
     and v_customer_id is null then
    raise exception 'Engine sales require a customer (for the warranty)';
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

  for v_engine_id in
    select value::uuid from jsonb_array_elements_text(coalesce(p_engine_ids, '[]'::jsonb))
  loop
    select e.status, e.shop_id, e.price_centavos, e.serial_number,
           em.brand, em.model
      into v_eng
    from engines e
    join engine_models em on em.id = e.engine_model_id
    where e.id = v_engine_id and e.deleted_at is null;

    if v_eng is null or v_eng.price_centavos is null then
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

    insert into sale_lines (sale_id, engine_id, qty, unit_price_centavos, line_total_centavos, description)
    values (v_sale_id, v_engine_id, 1, v_eng.price_centavos, v_eng.price_centavos,
            v_eng.brand || ' ' || v_eng.model || ' — SN ' || v_eng.serial_number);

    v_total := v_total + v_eng.price_centavos;
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'A sale needs at least one line';
  end if;

  update sales set total_centavos = v_total where id = v_sale_id;
  return v_sale_id;
end $$;

-- ---------------------------------------------------------------------------
-- fn_record_loss → status 'recorded'
-- ---------------------------------------------------------------------------
create or replace function public.fn_record_loss(
  p_part_id uuid default null,
  p_engine_id uuid default null,
  p_qty int default 1,
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

  insert into losses (shop_id, recorded_by, part_id, engine_id, qty, reason, note, status, description)
  values (v_shop, auth.uid(), p_part_id, p_engine_id, p_qty, p_reason, p_note, 'recorded', v_desc)
  returning id into v_loss_id;

  return v_loss_id;
end $$;

-- ---------------------------------------------------------------------------
-- Submit the shop's batch: everything recorded → pending, in one shot.
-- Returns {sales, losses} counts.
-- ---------------------------------------------------------------------------
create or replace function public.fn_submit_shop_batch()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_sales int;
  v_losses int;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can submit the batch';
  end if;

  update sales set status = 'pending'
  where shop_id = v_shop and status = 'recorded' and deleted_at is null;
  get diagnostics v_sales = row_count;

  update losses set status = 'pending'
  where shop_id = v_shop and status = 'recorded' and deleted_at is null;
  get diagnostics v_losses = row_count;

  if v_sales + v_losses = 0 then
    raise exception 'Nothing to submit — no recorded sales or losses';
  end if;

  return jsonb_build_object('sales', v_sales, 'losses', v_losses);
end $$;

revoke all on function public.fn_submit_shop_batch() from public, anon;
grant execute on function public.fn_submit_shop_batch() to authenticated;

-- ---------------------------------------------------------------------------
-- RLS: employees manage their own RECORDED items too (edit/cancel before
-- submitting). Approval fns still only accept pending/questioned.
-- ---------------------------------------------------------------------------
drop policy if exists sales_insert on public.sales;
create policy sales_insert on public.sales for insert
  to authenticated with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'recorded')
  );

drop policy if exists sales_update on public.sales;
create policy sales_update on public.sales for update
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('recorded','pending','questioned'))
  ) with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('recorded','pending'))
  );

drop policy if exists sales_delete on public.sales;
create policy sales_delete on public.sales for delete
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('recorded','pending'))
  );

drop policy if exists sale_lines_insert on public.sale_lines;
create policy sale_lines_insert on public.sale_lines for insert
  to authenticated with check (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner()
                   or (s.shop_id = public.auth_shop_id()
                       and s.recorded_by = auth.uid()
                       and s.status in ('recorded','pending'))))
  );

drop policy if exists sale_lines_update on public.sale_lines;
create policy sale_lines_update on public.sale_lines for update
  to authenticated using (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner()
                   or (s.shop_id = public.auth_shop_id()
                       and s.recorded_by = auth.uid()
                       and s.status in ('recorded','pending'))))
  );

drop policy if exists sale_lines_delete on public.sale_lines;
create policy sale_lines_delete on public.sale_lines for delete
  to authenticated using (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner()
                   or (s.shop_id = public.auth_shop_id()
                       and s.recorded_by = auth.uid()
                       and s.status in ('recorded','pending'))))
  );

drop policy if exists losses_insert on public.losses;
create policy losses_insert on public.losses for insert
  to authenticated with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'recorded')
  );

drop policy if exists losses_update on public.losses;
create policy losses_update on public.losses for update
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('recorded','pending','questioned'))
  ) with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('recorded','pending'))
  );

drop policy if exists losses_delete on public.losses;
create policy losses_delete on public.losses for delete
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('recorded','pending'))
  );
