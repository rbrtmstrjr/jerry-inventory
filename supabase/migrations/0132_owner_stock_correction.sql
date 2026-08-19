-- 0132 — Owner stock correction (master, parts).
--
-- An admin mis-encodes a quantity at receiving and master is wrong. Until now
-- the only remedy was hand-run SQL: fn_record_count_shortages posts a `loss`,
-- which books shrinkage in the P&L, and that is a lie when the stock never
-- existed. This writes the delta as `correction` instead, which lib/pnl.ts
-- ignores, so the number is fixed and the profit figures do not move.
--
-- Gerry alone (is_primary_owner), matching 0100/0101/0102/0105. The admin who
-- makes the errors must not be able to erase them. stock_movements keeps its
-- append-only property — no write policy is added for anyone.

create or replace function public.fn_correct_master_stock(
  p_part_id uuid,
  p_new_qty numeric,
  p_reason  text
) returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old   numeric;
  v_delta numeric;
  v_name  text;
begin
  if not public.is_primary_owner() then
    raise exception 'Only the owner can correct stock';
  end if;
  if coalesce(trim(p_reason), '') = '' then
    raise exception 'Give a reason for the correction';
  end if;

  select name into v_name from parts
   where id = p_part_id and deleted_at is null and merged_into is null;
  if not found then
    raise exception 'Product not found';
  end if;

  -- tenths + the unit rule, from the one authority that already owns them
  perform public.fn_assert_qty(p_part_id, p_new_qty, true);

  -- lock: fn_deliver_stock decrements this same row
  select qty into v_old from stock_levels
   where part_id = p_part_id and shop_id is null
   for update;
  if not found then
    insert into stock_levels (part_id, shop_id, qty) values (p_part_id, null, 0);
    v_old := 0;
  end if;

  v_delta := p_new_qty - v_old;
  if v_delta = 0 then
    raise exception '% is already %', v_name, public.fmt_qty(p_new_qty);
  end if;

  -- shelf FIRST: the low-stock hook (AFTER INSERT on stock_movements) reads
  -- stock_levels, so it must see the corrected qty, not the stale one.
  update stock_levels set qty = p_new_qty, updated_at = now()
   where part_id = p_part_id and shop_id is null;

  insert into stock_movements
    (movement_type, part_id, qty_change, shop_id, actor, note)
  values
    ('correction', p_part_id, v_delta, null, auth.uid(),
     'Stock correction: ' || public.fmt_qty(v_old) || ' -> '
     || public.fmt_qty(p_new_qty) || ' (' || trim(p_reason) || ')');

  return v_delta;
end $$;

revoke all on function public.fn_correct_master_stock(uuid, numeric, text)
  from public, anon;
grant execute on function public.fn_correct_master_stock(uuid, numeric, text)
  to authenticated;
