-- ---------------------------------------------------------------------------
-- 0036 — owner is referred to as "Admin", not "Maccky"
--
-- The owner's name was wrong: Maccky is a branch manager, not the owner (the
-- owner is Jerry). Shop-facing copy now says "Admin" for the role; the business
-- name ("Jerry's Marine") lives in settings.business_name, not in code.
--
-- Three functions bake the name into notification TEXT, so the app-side rename
-- can't reach them — they must be redefined here. Bodies are otherwise
-- unchanged from 0025 (fetched via pg_get_functiondef, text swapped).
-- Existing notification rows are back-filled too: they're what the shop reads.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_check_stock_alerts(p_part_id uuid, p_engine_id uuid, p_shop_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
          'On hand ' || v_qty || ' · reorder at ' || v_thr || ' — request a delivery from Admin.',
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
          'On hand ' || v_qty || ' unit(s) · reorder at ' || v_thr || ' — request a delivery from Admin.',
          'engine_models', v_model);
        perform public.fn_notify(
          'owner', p_shop_id, 'shop_low_stock',
          v_name || ' is low at ' || coalesce(v_shop_name, 'a shop'),
          'On hand ' || v_qty || ' unit(s) · reorder at ' || v_thr,
          'engine_models', v_model);
      end if;
    end if;
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.fn_dismiss_delivery_request(p_request_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    coalesce(nullif(trim(coalesce(p_reason, '')), ''), 'Admin dismissed your request.'),
    'delivery_requests', p_request_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.fn_fulfill_delivery_request(p_request_id uuid, p_delivery_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    'Admin delivered the items you requested.',
    'delivery_requests', p_request_id);
end $function$
;

-- Notifications already sent still say "Maccky" — rewrite them in place.
update notifications
   set title = replace(title, 'Maccky', 'Admin'),
       body  = replace(body,  'Maccky', 'Admin')
 where title like '%Maccky%' or body like '%Maccky%';

-- The business name the printed documents pull from.
update settings set business_name = 'Jerry''s Marine'
 where id = 1 and business_name = 'Maccky''s Marine';

-- The owner's display name in the app shell.
update profiles set full_name = 'Admin (Owner)'
 where role = 'owner' and full_name = 'Maccky (Owner)';
