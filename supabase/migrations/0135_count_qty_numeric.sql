-- ---------------------------------------------------------------------------
-- 0135 — fn_save_count's jsonb_to_recordset cast, missed by both the 0116
-- widening and the 0117-0121/0124 accumulator sweep.
--
-- WHY: 0134 widened count_snapshot_lines.counted_qty to numeric(12,2), and
-- app/(owner)/counts/actions.ts validates the input with qtySchema — a shop
-- can now count "10.25" on the sheet. But fn_save_count still parses the
-- incoming JSON as `as x(line_id uuid, counted_qty int)`. jsonb_to_recordset
-- CASTS to that column type, and Postgres does not raise on a numeric-to-int
-- cast, it rounds — silently. 10.25 is stored as 10. fn_record_shortages then
-- computes expected − counted on the now-wrong 10 and posts a PENDING loss for
-- a shortage that was never real, and the owner approves shrinkage that never
-- happened. The count sheet redisplays the correct 10.25 (the UPDATE wrote the
-- row, the round only happens on the cast in), so nothing at the counter looks
-- wrong — the same "invisible until you drive the UI" shape as 0119/0124/0125.
--
-- WHY A SEPARATE MIGRATION: 0134 is already applied to staging and is frozen
-- (its own header says so, and its `add constraint` statements have no
-- `if not exists` — it is not safe to re-run). This function was simply not
-- among the ones 0134 touched.
--
-- SCOPE: only the jsonb_to_recordset column type changes, from `int` to
-- `numeric`. No local variable in this function is declared int/bigint (the
-- only variable is `r record`, which takes its shape from the recordset), and
-- the function does no arithmetic on counted_qty — it only range-checks and
-- stores it — so there is nothing else here for the 0117-0121 failure mode to
-- hide in. fn_save_count does NOT call fn_assert_qty (it never did, before or
-- after this migration) — it validates only "not negative", the same as the
-- body below. Body is 0009's `fn_save_count`, byte-for-byte, apart from that
-- one word.
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
      as x(line_id uuid, counted_qty numeric)
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
