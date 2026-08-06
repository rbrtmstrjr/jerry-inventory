-- ---------------------------------------------------------------------------
-- 0119 — fix five int accumulators 0118 left behind. Re-issues
--        fn_confirm_delivery and fn_resolve_delivery_discrepancy.
--
-- 0118's transform retyped every identifier CONTAINING "qty". These five do not
-- contain it, but they RECEIVE quantities — and PL/pgSQL rounds silently on
-- assignment to int. The columns were numeric, the parameters were numeric, and
-- the arithmetic still collapsed to whole numbers in the middle.
--
--     v_damaged_line   <- r.qty_damaged
--     v_landed         <- r.qty_received          (accumulated)
--     v_damaged        <- v_damaged_line          (accumulated)
--     v_short          <- v_line.qty - r.qty_received
--     v_left           <- sum(qty_outstanding)
--
-- WHY THIS MATTERED, not just a tidy-up:
--
--   * v_short decides `status = case when v_short > 0 then 'discrepancy' else
--     'confirmed' end`. A 0.4 kg shortfall rounds to 0, so the delivery is
--     marked CONFIRMED, the missing stock is never resolved, no discrepancy is
--     raised — and `Σ movements = stock_levels` (CLAUDE.md, test-movements)
--     quietly stops holding.
--
--   * v_left decides when a discrepancy is fully resolved. 0.4 outstanding
--     rounds to 0, so the delivery closes with stock still in transit.
--
-- Both failures are SILENT. Nothing raises, nothing logs, and the first symptom
-- is a stock count that will not reconcile weeks later.
--
-- The lesson for 0120 and anything after: retyping by NAME is not enough. Every
-- local that a quantity flows INTO has to be checked, whatever it is called.
-- 0117 was re-audited and is clean — its ints are line counters (v_count),
-- percentages (v_part_pct) and warranty months (v_months), none of which ever
-- receive a quantity.
--
-- Bodies are 0118's, regenerated from the same sources with the accumulators
-- retyped and the fn_assert_qty calls preserved. Nothing else differs.
-- ---------------------------------------------------------------------------

create or replace function public.fn_confirm_delivery(
  p_delivery_id uuid,
  p_lines jsonb,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_del record;
  r record;
  v_line record;
  v_expected int;
  v_provided int;
  v_damaged_line numeric;
  v_short numeric := 0;      -- outstanding = damaged + missing
  v_damaged numeric := 0;
  v_landed numeric := 0;
  v_shop_name text;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop staff can confirm a delivery';
  end if;

  select * into v_del from deliveries
  where id = p_delivery_id and deleted_at is null
  for update;
  if not found then
    raise exception 'Delivery not found';
  end if;
  if v_del.shop_id is distinct from v_shop then
    raise exception 'That delivery is not addressed to your shop';
  end if;
  if v_del.status <> 'in_transit' then
    raise exception 'This delivery was already confirmed (status: %)', v_del.status;
  end if;

  select count(*) into v_expected from delivery_lines where delivery_id = p_delivery_id;
  select count(*) into v_provided from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb));
  if v_provided <> v_expected then
    raise exception 'Count every line before confirming (% of % provided)', v_provided, v_expected;
  end if;

  for r in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(line_id uuid, qty_received numeric, qty_damaged numeric, shop_note text, damage_photo_path text)
  loop
    select * into v_line from delivery_lines
    where id = r.line_id and delivery_id = p_delivery_id
    for update;
    if not found then
      raise exception 'That line is not part of this delivery';
    end if;

    v_damaged_line := coalesce(r.qty_damaged, 0);
    if r.qty_received is null or r.qty_received < 0 then
      raise exception 'Received quantity cannot be negative';
    end if;

    perform public.fn_assert_qty(v_line.part_id, r.qty_received, true);
    perform public.fn_assert_qty(v_line.part_id, v_damaged_line, true);
    if v_damaged_line < 0 then
      raise exception 'Damaged quantity cannot be negative';
    end if;
    -- good + damaged can NEVER exceed what was sent
    if r.qty_received + v_damaged_line > v_line.qty then
      raise exception 'Good + damaged cannot exceed what was sent (sent %, entered % good + % damaged)',
        v_line.qty, r.qty_received, v_damaged_line;
    end if;
    -- a damage photo must live under the confirming shop's own prefix
    if r.damage_photo_path is not null and length(trim(r.damage_photo_path)) > 0
       and r.damage_photo_path not like 'shop-' || v_shop::text || '/%' then
      raise exception 'Damage photo must be stored under your own shop folder';
    end if;

    update delivery_lines
    set qty_received = r.qty_received,
        qty_damaged = v_damaged_line,
        shop_note = nullif(trim(coalesce(r.shop_note, '')), ''),
        damage_photo_path = nullif(trim(coalesce(r.damage_photo_path, '')), '')
    where id = r.line_id;

    -- Only the GOOD units land. Damaged + missing stay outstanding.
    if r.qty_received > 0 then
      if v_line.part_id is not null then
        insert into stock_levels (part_id, shop_id, qty)
        values (v_line.part_id, v_shop, r.qty_received)
        on conflict (part_id, shop_id)
        do update set qty = stock_levels.qty + excluded.qty;

        insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
        values ('delivery', v_line.part_id, r.qty_received, v_shop, auth.uid(), p_delivery_id,
                coalesce(p_note, 'Confirmed on arrival'));
      else
        update engines set status = 'delivered' where id = v_line.engine_id;

        insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
        values ('delivery', v_line.engine_id, 1, v_shop, auth.uid(), p_delivery_id,
                coalesce(p_note, 'Confirmed on arrival'));
      end if;
      v_landed := v_landed + r.qty_received;
    end if;

    v_damaged := v_damaged + v_damaged_line;
    v_short := v_short + (v_line.qty - r.qty_received);  -- damaged + missing
  end loop;

  -- Any shortfall (damaged OR missing) → discrepancy for the owner to resolve.
  update deliveries
  set status = case when v_short > 0 then 'discrepancy' else 'confirmed' end,
      confirmed_at = now(),
      confirmed_by = auth.uid()
  where id = p_delivery_id;

  select name into v_shop_name from shops where id = v_shop;
  if v_short > 0 then
    perform public.fn_notify(
      'owner', v_shop, 'delivery_discrepancy',
      coalesce(v_shop_name, 'A shop') || ': ' || v_short || ' item(s) need your decision',
      'Received ' || v_landed || ' good · ' || v_damaged || ' damaged · '
        || (v_short - v_damaged) || ' missing — resolve the damaged & missing.',
      'deliveries', p_delivery_id);
  else
    perform public.fn_notify(
      'owner', v_shop, 'delivery_confirmed',
      coalesce(v_shop_name, 'A shop') || ' confirmed a delivery in full',
      v_landed || ' item(s) received.',
      'deliveries', p_delivery_id);
  end if;

  return jsonb_build_object(
    'landed', v_landed,
    'damaged', v_damaged,
    'missing', v_short - v_damaged,
    'short', v_short,
    'status', case when v_short > 0 then 'discrepancy' else 'confirmed' end);
end $$;

create or replace function public.fn_resolve_delivery_discrepancy(
  p_delivery_line_id uuid,
  p_qty numeric,
  p_resolution text,
  p_reason text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_line record;
  v_del record;
  v_left numeric;
  v_writeoff_shop uuid;   -- NULL for master delivery, source shop for a transfer
begin
  if not public.is_owner() then
    raise exception 'Only the owner can resolve a delivery discrepancy';
  end if;
  if p_resolution not in ('returned_to_master','returned_to_source','written_off') then
    raise exception 'Unknown resolution: %', p_resolution;
  end if;

  select * into v_line from delivery_lines where id = p_delivery_line_id for update;
  if not found then raise exception 'Delivery line not found'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity must be positive'; end if;
  if p_qty > v_line.qty_outstanding then
    raise exception 'Only % outstanding on that line', v_line.qty_outstanding;
  end if;

  select * into v_del from deliveries where id = v_line.delivery_id for update;
  v_writeoff_shop := v_del.from_shop_id;  -- where the units were debited

  -- resolution must match the delivery type
  if v_del.from_shop_id is null and p_resolution = 'returned_to_source' then
    raise exception 'A master delivery returns to master, not to a source shop';
  end if;
  if v_del.from_shop_id is not null and p_resolution = 'returned_to_master' then
    raise exception 'A transfer returns to the source shop, not to master';
  end if;

  if v_line.part_id is not null then
    if p_resolution = 'returned_to_master' then
      insert into stock_levels (part_id, shop_id, qty)
      values (v_line.part_id, null, p_qty)
      on conflict (part_id, shop_id) do update set qty = stock_levels.qty + excluded.qty;
      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.part_id, p_qty, null, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Recovered from transit'));

    elsif p_resolution = 'returned_to_source' then
      insert into stock_levels (part_id, shop_id, qty)
      values (v_line.part_id, v_del.from_shop_id, p_qty)
      on conflict (part_id, shop_id) do update set qty = stock_levels.qty + excluded.qty;
      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.part_id, p_qty, v_del.from_shop_id, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Returned to source shop'));

    else -- written_off: it left the source and never landed. No stock write.
      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_writeoff', v_line.part_id, -p_qty, v_writeoff_shop, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Lost in transit'));
    end if;
  else
    if p_qty <> 1 then raise exception 'Engines are resolved one serial at a time'; end if;
    if p_resolution = 'returned_to_master' then
      update engines set status = 'in_master', shop_id = null where id = v_line.engine_id;
      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.engine_id, 1, null, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Recovered from transit'));

    elsif p_resolution = 'returned_to_source' then
      update engines set status = 'delivered', shop_id = v_del.from_shop_id where id = v_line.engine_id;
      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_return', v_line.engine_id, 1, v_del.from_shop_id, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Returned to source shop'));

    else
      update engines set deleted_at = now() where id = v_line.engine_id;
      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, delivery_id, note)
      values ('transit_writeoff', v_line.engine_id, -1, v_writeoff_shop, auth.uid(), v_line.delivery_id,
              coalesce(p_reason, 'Lost in transit'));
    end if;
  end if;

  insert into delivery_discrepancies (delivery_line_id, qty, resolution, reason, resolved_by)
  values (p_delivery_line_id, p_qty, p_resolution, nullif(trim(coalesce(p_reason, '')), ''), auth.uid());

  update delivery_lines set qty_resolved = qty_resolved + p_qty where id = p_delivery_line_id;

  select coalesce(sum(qty_outstanding), 0) into v_left
  from delivery_lines where delivery_id = v_line.delivery_id;
  if v_left = 0 then
    update deliveries set status = 'resolved', resolved_at = now(), resolved_by = auth.uid()
    where id = v_line.delivery_id;
  end if;
end $$;

