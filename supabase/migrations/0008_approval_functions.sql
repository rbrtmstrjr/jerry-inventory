-- ============================================================================
-- 0008_approval_functions.sql — The approval engine.
-- Stock ONLY moves when Jerry approves. Approving an engine sale marks the
-- serial sold and auto-creates the warranty. Approvals that would drive shop
-- stock negative are blocked with a clear error.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Approve a sale: deduct shop stock, mark engines sold, create warranties.
-- ---------------------------------------------------------------------------
create or replace function public.fn_approve_sale(
  p_sale_id uuid,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sale record;
  l record;
  v_qty int;
  v_eng record;
  v_months int;
  v_sold_on date;
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
    end if;
  end loop;

  update sales
  set status = 'approved',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      owner_note = coalesce(p_note, owner_note)
  where id = p_sale_id;
end $$;

revoke all on function public.fn_approve_sale(uuid, text) from public, anon;
grant execute on function public.fn_approve_sale(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Approve a loss: deduct stock as a reason-coded write-off (valued at cost).
-- Engine losses write the serial off (soft delete) — it leaves the shop view
-- but stays searchable in history.
-- ---------------------------------------------------------------------------
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
  v_qty int;
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

    select cost_centavos * v_loss.qty into v_value from parts where id = v_loss.part_id;

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

revoke all on function public.fn_approve_loss(uuid, text) from public, anon;
grant execute on function public.fn_approve_loss(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Question / reject (no stock movement; just status + the owner's note)
-- ---------------------------------------------------------------------------
create or replace function public.fn_review_submission(
  p_kind text,          -- 'sale' | 'loss'
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
  else
    raise exception 'Unknown kind %', p_kind;
  end if;
end $$;

revoke all on function public.fn_review_submission(text, uuid, text, text) from public, anon;
grant execute on function public.fn_review_submission(text, uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: push sales/losses changes to the owner's approval queue
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.sales;
exception when duplicate_object then null; end $$;

do $$ begin
  alter publication supabase_realtime add table public.losses;
exception when duplicate_object then null; end $$;
