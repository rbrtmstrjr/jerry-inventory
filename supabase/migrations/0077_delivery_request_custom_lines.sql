-- ---------------------------------------------------------------------------
-- 0077 — custom (not-yet-in-catalog) delivery-request lines.
--
-- A customer asks a shop for a product the shop doesn't carry and that isn't in
-- the catalog yet. The employee should be able to request it FROM ADMIN in the
-- same delivery request as its low-stock items — one request, not a phone call.
--
-- Such a line names the product as FREE TEXT: it has no part_id and no
-- engine_model_id (there is no catalog row to point at). The admin sees it on
-- the request, then creates the product via Receiving before delivering. This
-- never mints a catalog row on its own — the 0049 lockdown stands: creation
-- still only happens inside fn_receive_stock.
-- ---------------------------------------------------------------------------

alter table public.delivery_request_lines
  add column if not exists custom_name text;

-- A line now carries EXACTLY ONE identity: an existing part, an existing engine
-- model, OR a free-text custom product. Widens the old part-XOR-engine check.
-- The RPC below stores custom_name as non-empty-or-NULL, so a plain not-null
-- count is a correct "exactly one" test.
alter table public.delivery_request_lines
  drop constraint if exists delivery_request_line_item;
alter table public.delivery_request_lines
  add constraint delivery_request_line_item check (
    (part_id is not null)::int
    + (engine_model_id is not null)::int
    + (custom_name is not null)::int = 1
  );

-- ---------------------------------------------------------------------------
-- Rewrite fn_create_delivery_request to accept a custom_name per line. Same
-- signature (jsonb, text) → grants/guard unchanged (still employee-only).
--   p_lines: [{part_id?, engine_model_id?, custom_name?, qty_requested, note?}]
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
  v_custom text;
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
      as x(part_id uuid, engine_model_id uuid, qty_requested int, note text,
           custom_name text)
  loop
    v_custom := nullif(trim(coalesce(r.custom_name, '')), '');
    -- exactly one identity: existing part, existing engine model, or free text
    if ((r.part_id is not null)::int + (r.engine_model_id is not null)::int
        + (v_custom is not null)::int) <> 1 then
      raise exception 'Each request line needs exactly one product';
    end if;
    if r.qty_requested is null or r.qty_requested <= 0 then
      raise exception 'Requested quantity must be positive';
    end if;

    insert into delivery_request_lines
      (delivery_request_id, part_id, engine_model_id, qty_requested, note,
       custom_name)
    values (v_id, r.part_id, r.engine_model_id, r.qty_requested,
            nullif(trim(coalesce(r.note, '')), ''), v_custom);
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
