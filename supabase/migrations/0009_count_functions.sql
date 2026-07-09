-- ============================================================================
-- 0009_count_functions.sql — Monthly physical count.
-- Snapshot freezes expected quantities; shortages flow into the NORMAL
-- loss-approval queue (no separate reconciliation subsystem).
-- ============================================================================

-- Track which count line already produced a loss (idempotency)
alter table public.count_snapshot_lines
  add column if not exists shortage_loss_id uuid references public.losses(id);

-- ---------------------------------------------------------------------------
-- Create a snapshot: freeze every part-stock row of the shop as expected_qty.
-- ---------------------------------------------------------------------------
create or replace function public.fn_create_count_snapshot(
  p_shop_id uuid,
  p_note text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot_id uuid;
  v_lines int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can create count sheets';
  end if;
  if not exists (select 1 from shops where id = p_shop_id and deleted_at is null) then
    raise exception 'Shop not found';
  end if;

  insert into count_snapshots (shop_id, note, created_by)
  values (p_shop_id, p_note, auth.uid())
  returning id into v_snapshot_id;

  insert into count_snapshot_lines (snapshot_id, part_id, expected_qty)
  select v_snapshot_id, sl.part_id, sl.qty
  from stock_levels sl
  join parts p on p.id = sl.part_id and p.deleted_at is null
  where sl.shop_id = p_shop_id;

  get diagnostics v_lines = row_count;
  if v_lines = 0 then
    raise exception 'This shop has no stock records to count';
  end if;

  return v_snapshot_id;
end $$;

revoke all on function public.fn_create_count_snapshot(uuid, text) from public, anon;
grant execute on function public.fn_create_count_snapshot(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Save counted quantities (bulk, atomic). null clears a count.
--   p_lines: [{line_id, counted_qty}]
-- ---------------------------------------------------------------------------
create or replace function public.fn_save_count(
  p_snapshot_id uuid,
  p_lines jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can enter counts';
  end if;
  if not exists (
    select 1 from count_snapshots where id = p_snapshot_id and deleted_at is null
  ) then
    raise exception 'Count sheet not found';
  end if;

  for r in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(line_id uuid, counted_qty int)
  loop
    if r.counted_qty is not null and r.counted_qty < 0 then
      raise exception 'Counted quantity cannot be negative';
    end if;
    update count_snapshot_lines
    set counted_qty = r.counted_qty
    where id = r.line_id and snapshot_id = p_snapshot_id;
    if not found then
      raise exception 'Line % does not belong to this count sheet', r.line_id;
    end if;
  end loop;
end $$;

revoke all on function public.fn_save_count(uuid, jsonb) from public, anon;
grant execute on function public.fn_save_count(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Turn counted shortages into reason-coded PENDING losses — the same queue
-- and approval flow as any shop-recorded loss. Idempotent per line.
--   p_lines: [{line_id, reason}]   (reason: nasira|nawala|expired|correction)
-- Returns number of losses created.
-- ---------------------------------------------------------------------------
create or replace function public.fn_record_count_shortages(
  p_snapshot_id uuid,
  p_lines jsonb
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snap record;
  r record;
  l record;
  v_shortage int;
  v_loss_id uuid;
  v_created int := 0;
  v_name text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can post count shortages';
  end if;

  select * into v_snap from count_snapshots
  where id = p_snapshot_id and deleted_at is null;
  if v_snap is null then
    raise exception 'Count sheet not found';
  end if;

  for r in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(line_id uuid, reason public.loss_reason)
  loop
    select * into l from count_snapshot_lines
    where id = r.line_id and snapshot_id = p_snapshot_id
    for update;

    if l is null then
      raise exception 'Line % does not belong to this count sheet', r.line_id;
    end if;
    if l.counted_qty is null then
      raise exception 'Enter the counted quantity first';
    end if;
    if l.shortage_loss_id is not null then
      continue; -- already sent to the queue
    end if;

    v_shortage := l.expected_qty - l.counted_qty;
    if v_shortage <= 0 then
      continue; -- no shortage on this line
    end if;

    select name into v_name from parts where id = l.part_id;

    insert into losses (shop_id, recorded_by, part_id, qty, reason, note, status, description)
    values (
      v_snap.shop_id, auth.uid(), l.part_id, v_shortage,
      coalesce(r.reason, 'nawala'),
      'Month-end count ' || to_char(v_snap.snapshot_date, 'YYYY-MM-DD')
        || ': expected ' || l.expected_qty || ', counted ' || l.counted_qty,
      'pending', v_name
    )
    returning id into v_loss_id;

    update count_snapshot_lines set shortage_loss_id = v_loss_id
    where id = l.id;

    v_created := v_created + 1;
  end loop;

  return v_created;
end $$;

revoke all on function public.fn_record_count_shortages(uuid, jsonb) from public, anon;
grant execute on function public.fn_record_count_shortages(uuid, jsonb) to authenticated;
