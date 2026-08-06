-- ---------------------------------------------------------------------------
-- 0123 — quantities read as "12", not "12.0", in human-facing text.
--
-- Since 0116 a quantity is numeric(12,1), and Postgres renders that with its
-- scale: `12` becomes the string '12.0'. Anywhere a quantity is concatenated
-- into a sentence, the sentence now reads wrong to a shopkeeper who has never
-- sold anything by weight:
--
--     "Month-end count 2026-08-05: expected 12.0, counted 9.0"
--
-- 387 of Gerwin's 391 products are pieces. Almost every quantity anyone reads
-- is a whole number, and every one of them just grew a decimal.
--
-- fmt_qty() renders a whole number whole and keeps the tenth only when there is
-- one: 12 -> '12', 9.5 -> '9.5', 0.1 -> '0.1'. The app needs the same rule in
-- TypeScript for every screen that shows a quantity.
--
-- Caught by test-counts: "loss note carries expected/counted".
--
-- This is display only. No stored quantity, balance or total changes.
-- ---------------------------------------------------------------------------

create or replace function public.fmt_qty(p_qty numeric)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p_qty is null then ''
    -- whole number -> no decimal point at all
    when p_qty = round(p_qty) then trim(to_char(p_qty, 'FM9999999999990'))
    else trim(to_char(p_qty, 'FM9999999999990.0'))
  end;
$fn$;

comment on function public.fmt_qty(numeric) is
  'Render a quantity for humans: whole numbers without a decimal, tenths with '
  'one. Use anywhere a quantity is concatenated into displayed text.';

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
        || ': expected ' || public.fmt_qty(l.expected_qty)
        || ', counted ' || public.fmt_qty(l.counted_qty),
      'pending', v_name
    )
    returning id into v_loss_id;

    update count_snapshot_lines set shortage_loss_id = v_loss_id
    where id = l.id;

    v_created := v_created + 1;
  end loop;

  return v_created;
end $$;
