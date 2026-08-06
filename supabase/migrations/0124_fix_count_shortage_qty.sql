-- ---------------------------------------------------------------------------
-- 0124 — fn_record_count_shortages: v_shortage is a QUANTITY.
--
-- 0123 fixed how the shortage READS ("expected 12, counted 9") and left how it
-- is CALCULATED wrong:
--
--     v_shortage int;
--     v_shortage := l.expected_qty - l.counted_qty;   -- both numeric since 0116
--
-- PL/pgSQL rounds on assignment, so a 0.5 kg shortage posts a loss for 1 (or 0)
-- while the note beside it correctly says "expected 10, counted 9.5". The
-- number a human reads and the number the ledger deducts disagree — and the
-- loss goes to the approval queue looking perfectly plausible.
--
-- Why it slipped: the accumulator audit ran over the 0120 targets.
-- fn_record_count_shortages was pulled in later, by 0123, for a display fix —
-- and a display fix did not feel like it needed an audit. It did. Any function
-- touched at all in this series needed the same check.
--
-- v_created stays int: it counts losses, not units.
--
-- This is the last of the quantity-in-an-integer defects; a full sweep of every
-- live function follows in the verification step, not in a migration.
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
  v_shortage numeric;
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
