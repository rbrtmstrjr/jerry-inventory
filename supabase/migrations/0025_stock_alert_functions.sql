-- ============================================================================
-- 0025_stock_alert_functions.sql — notification dispatcher, low-stock hooks,
-- and the delivery-request lifecycle.
--
-- Dispatcher: fn_notify() writes ONE channel-independent notification row and
-- fans out a notification_dispatches row per ENABLED channel. 'in_app' is
-- satisfied by the row itself (marked sent); any other channel is left
-- 'pending' for a worker. Adding SMS later = flip notification_channels.enabled
-- and drain pending dispatches. NO SMS is implemented here.
--
-- Low-stock detection stays query-based (the views); this only decides WHEN to
-- raise a notification, hooked to stock_movements — the single append-only
-- ledger every stock path already writes to (receiving, delivery, return,
-- sale approval, loss approval). One hook, every path covered.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Dispatcher. Dedupe: at most ONE unread notification per
-- (recipient_role, type, ref, shop scope) — a still-low item never re-spams.
-- Returns the new id, or null when deduped.
-- ---------------------------------------------------------------------------
create or replace function public.fn_notify(
  p_recipient_role text,
  p_shop_id uuid,
  p_type text,
  p_title text,
  p_body text default null,
  p_ref_table text default null,
  p_ref_id uuid default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  r record;
begin
  if exists (
    select 1 from notifications
    where recipient_role = p_recipient_role
      and type = p_type
      and coalesce(ref_table, '') = coalesce(p_ref_table, '')
      and ref_id is not distinct from p_ref_id
      and shop_id is not distinct from p_shop_id
      and read_at is null
      and deleted_at is null
  ) then
    return null;  -- already flagged and still unread
  end if;

  insert into notifications
    (recipient_role, shop_id, type, title, body, ref_table, ref_id)
  values
    (p_recipient_role, p_shop_id, p_type, p_title, p_body, p_ref_table, p_ref_id)
  returning id into v_id;

  for r in select code from notification_channels where enabled loop
    insert into notification_dispatches (notification_id, channel, status, sent_at)
    values (
      v_id,
      r.code,
      case when r.code = 'in_app' then 'sent' else 'pending' end,
      case when r.code = 'in_app' then now() else null end
    );
  end loop;

  return v_id;
end $$;

revoke all on function public.fn_notify(text, uuid, text, text, text, text, uuid) from public, anon;

-- ---------------------------------------------------------------------------
-- Check one product's levels and raise alerts. Master low → owner ("buy from
-- supplier"). Shop low → that shop ("request a delivery") + the owner
-- (early warning across branches).
-- ---------------------------------------------------------------------------
create or replace function public.fn_check_stock_alerts(
  p_part_id uuid,
  p_engine_id uuid,
  p_shop_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_model uuid;
  v_name text;
  v_qty int;
  v_thr int;
  v_shop_name text;
begin
  if p_shop_id is not null then
    select name into v_shop_name from shops where id = p_shop_id;
  end if;

  -- ------------------------------- PARTS -------------------------------
  if p_part_id is not null then
    select name, reorder_level into v_name, v_thr
    from parts where id = p_part_id and deleted_at is null;

    if v_name is not null and coalesce(v_thr, 0) > 0 then
      select coalesce(qty, 0) into v_qty
      from stock_levels where part_id = p_part_id and shop_id is null;
      v_qty := coalesce(v_qty, 0);
      if v_qty <= v_thr then
        perform public.fn_notify(
          'owner', null, 'master_low_stock',
          v_name || ' is low in master',
          'On hand ' || v_qty || ' · reorder at ' || v_thr || ' — order from your supplier.',
          'parts', p_part_id);
      end if;
    end if;

    if p_shop_id is not null then
      select coalesce(sro.reorder_level, p.reorder_level), p.name
        into v_thr, v_name
      from parts p
      left join shop_reorder_levels sro
        on sro.shop_id = p_shop_id and sro.part_id = p.id and sro.deleted_at is null
      where p.id = p_part_id and p.deleted_at is null;

      select coalesce(qty, 0) into v_qty
      from stock_levels where part_id = p_part_id and shop_id = p_shop_id;
      v_qty := coalesce(v_qty, 0);

      if v_name is not null and coalesce(v_thr, 0) > 0 and v_qty <= v_thr then
        perform public.fn_notify(
          'shop', p_shop_id, 'shop_low_stock',
          v_name || ' is low',
          'On hand ' || v_qty || ' · reorder at ' || v_thr || ' — request a delivery from Maccky.',
          'parts', p_part_id);
        perform public.fn_notify(
          'owner', p_shop_id, 'shop_low_stock',
          v_name || ' is low at ' || coalesce(v_shop_name, 'a shop'),
          'On hand ' || v_qty || ' · reorder at ' || v_thr,
          'parts', p_part_id);
      end if;
    end if;
  end if;

  -- ------------------------- ENGINES (by MODEL) -------------------------
  if p_engine_id is not null then
    select engine_model_id into v_model from engines where id = p_engine_id;
    if v_model is null then return; end if;

    select em.brand || ' ' || em.model, em.reorder_level into v_name, v_thr
    from engine_models em where em.id = v_model and em.deleted_at is null;

    if v_name is not null and coalesce(v_thr, 0) > 0 then
      select count(*)::int into v_qty from engines
      where engine_model_id = v_model and status = 'in_master' and deleted_at is null;
      if v_qty <= v_thr then
        perform public.fn_notify(
          'owner', null, 'master_low_stock',
          v_name || ' is low in master',
          'In master ' || v_qty || ' unit(s) · reorder at ' || v_thr || ' — order from your supplier.',
          'engine_models', v_model);
      end if;
    end if;

    if p_shop_id is not null then
      select coalesce(sro.reorder_level, em.reorder_level), em.brand || ' ' || em.model
        into v_thr, v_name
      from engine_models em
      left join shop_reorder_levels sro
        on sro.shop_id = p_shop_id and sro.engine_model_id = em.id and sro.deleted_at is null
      where em.id = v_model and em.deleted_at is null;

      select count(*)::int into v_qty from engines
      where engine_model_id = v_model and shop_id = p_shop_id
        and status = 'delivered' and deleted_at is null;

      if v_name is not null and coalesce(v_thr, 0) > 0 and v_qty <= v_thr then
        perform public.fn_notify(
          'shop', p_shop_id, 'shop_low_stock',
          v_name || ' is low',
          'On hand ' || v_qty || ' unit(s) · reorder at ' || v_thr || ' — request a delivery from Maccky.',
          'engine_models', v_model);
        perform public.fn_notify(
          'owner', p_shop_id, 'shop_low_stock',
          v_name || ' is low at ' || coalesce(v_shop_name, 'a shop'),
          'On hand ' || v_qty || ' unit(s) · reorder at ' || v_thr,
          'engine_models', v_model);
      end if;
    end if;
  end if;
end $$;

revoke all on function public.fn_check_stock_alerts(uuid, uuid, uuid) from public, anon;

-- One hook on the ledger covers every stock path. Never let an alert failure
-- roll back real stock movement.
create or replace function public.stock_movements_alert_hook()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform public.fn_check_stock_alerts(new.part_id, new.engine_id, new.shop_id);
  exception when others then
    null;  -- alerting must never break a stock write
  end;
  return null;
end $$;

drop trigger if exists trg_stock_movements_alerts on public.stock_movements;
create trigger trg_stock_movements_alerts
  after insert on public.stock_movements
  for each row execute function public.stock_movements_alert_hook();

-- ---------------------------------------------------------------------------
-- Delivery requests — shop asks the owner for stock. Never touches stock.
--   p_lines: [{part_id?, engine_model_id?, qty_requested, note?}]
-- ---------------------------------------------------------------------------
create or replace function public.fn_create_delivery_request(
  p_lines jsonb,
  p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_id uuid;
  r record;
  v_count int := 0;
  v_shop_name text;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can request a delivery';
  end if;

  insert into delivery_requests (shop_id, requested_by, note)
  values (v_shop, auth.uid(), nullif(trim(coalesce(p_note, '')), ''))
  returning id into v_id;

  for r in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(part_id uuid, engine_model_id uuid, qty_requested int, note text)
  loop
    if (r.part_id is null) = (r.engine_model_id is null) then
      raise exception 'Each request line needs exactly one product';
    end if;
    if r.qty_requested is null or r.qty_requested <= 0 then
      raise exception 'Requested quantity must be positive';
    end if;

    insert into delivery_request_lines
      (delivery_request_id, part_id, engine_model_id, qty_requested, note)
    values (v_id, r.part_id, r.engine_model_id, r.qty_requested,
            nullif(trim(coalesce(r.note, '')), ''));
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Add at least one item to the request';
  end if;

  select name into v_shop_name from shops where id = v_shop;
  perform public.fn_notify(
    'owner', v_shop, 'delivery_request',
    'Delivery request from ' || coalesce(v_shop_name, 'a shop'),
    v_count || ' item(s) requested' || coalesce(' — ' || nullif(trim(coalesce(p_note,'')), ''), ''),
    'delivery_requests', v_id);

  return v_id;
end $$;

revoke all on function public.fn_create_delivery_request(jsonb, text) from public, anon;
grant execute on function public.fn_create_delivery_request(jsonb, text) to authenticated;

-- Link a request to a delivery the owner just made through the EXISTING flow.
create or replace function public.fn_fulfill_delivery_request(
  p_request_id uuid,
  p_delivery_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_req record;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can fulfil a delivery request';
  end if;

  select * into v_req from delivery_requests
  where id = p_request_id and deleted_at is null for update;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'open' then
    raise exception 'Request already % ', v_req.status;
  end if;
  if not exists (select 1 from deliveries where id = p_delivery_id and deleted_at is null) then
    raise exception 'Delivery not found';
  end if;

  update delivery_requests
  set status = 'fulfilled', fulfilled_delivery_id = p_delivery_id, fulfilled_at = now()
  where id = p_request_id;

  perform public.fn_notify(
    'shop', v_req.shop_id, 'delivery_request_fulfilled',
    'Your delivery request is on the way',
    'Maccky delivered the items you requested.',
    'delivery_requests', p_request_id);
end $$;

revoke all on function public.fn_fulfill_delivery_request(uuid, uuid) from public, anon;
grant execute on function public.fn_fulfill_delivery_request(uuid, uuid) to authenticated;

create or replace function public.fn_dismiss_delivery_request(
  p_request_id uuid,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_req record;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can dismiss a delivery request';
  end if;

  select * into v_req from delivery_requests
  where id = p_request_id and deleted_at is null for update;
  if not found then raise exception 'Request not found'; end if;
  if v_req.status <> 'open' then
    raise exception 'Request already %', v_req.status;
  end if;

  update delivery_requests
  set status = 'dismissed', owner_note = nullif(trim(coalesce(p_reason, '')), '')
  where id = p_request_id;

  perform public.fn_notify(
    'shop', v_req.shop_id, 'delivery_request_dismissed',
    'Delivery request dismissed',
    coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Maccky dismissed your request.'),
    'delivery_requests', p_request_id);
end $$;

revoke all on function public.fn_dismiss_delivery_request(uuid, text) from public, anon;
grant execute on function public.fn_dismiss_delivery_request(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Notification read state — scoped to the caller.
-- ---------------------------------------------------------------------------
create or replace function public.fn_mark_notification_read(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_shop uuid;
begin
  v_shop := public.auth_shop_id();
  update notifications
  set read_at = now()
  where id = p_id
    and read_at is null
    and (
      (recipient_role = 'owner' and public.is_owner())
      or (recipient_role = 'shop' and shop_id = v_shop)
    );
end $$;

revoke all on function public.fn_mark_notification_read(uuid) from public, anon;
grant execute on function public.fn_mark_notification_read(uuid) to authenticated;

create or replace function public.fn_mark_all_notifications_read()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare v_shop uuid; v_n int;
begin
  v_shop := public.auth_shop_id();
  update notifications
  set read_at = now()
  where read_at is null
    and deleted_at is null
    and (
      (recipient_role = 'owner' and public.is_owner())
      or (recipient_role = 'shop' and shop_id = v_shop)
    );
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.fn_mark_all_notifications_read() from public, anon;
grant execute on function public.fn_mark_all_notifications_read() to authenticated;
