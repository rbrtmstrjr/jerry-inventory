-- 0058_receipt_damage.sql — record DAMAGE & LOSS on receipt.
-- ============================================================================
-- Two inspection points gain a "damaged" outcome, distinct from "missing":
--
--   • Delivery confirm (shop): per line, how many arrived GOOD / DAMAGED /
--     MISSING (+ an optional damage photo). Good lands in sellable stock;
--     damaged does NOT land — it stays in transit (part of qty_outstanding,
--     exactly like missing) until the OWNER decides its fate. The shop still
--     only RECORDS; it can write nothing off. Works for transfers unchanged.
--
--   • Return (owner): per line, GOOD vs DAMAGED. Good re-enters master (existing
--     return legs); damaged is removed from the shop as an owner-created,
--     already-APPROVED loss (the existing shrinkage path), valued at cost.
--
-- NO new movement types. A damaged delivery unit is resolved through the
-- existing discrepancy queue (transit_writeoff = shrinkage / transit_return =
-- send back to master → supplier), tagged with a reason (damaged vs
-- lost_in_transit) the owner passes. A damaged return unit is an approved loss
-- (movement_type 'loss'). Both are already business-level shrinkage and already
-- excluded from any shop's Net Contribution — so P&L totals are unchanged.
--
-- fn_resolve_delivery_discrepancy is UNCHANGED: it already takes p_reason,
-- stores it on delivery_discrepancies.reason AND in the movement note, and
-- already supports written_off / returned_to_master / returned_to_source. The
-- UI simply passes 'damaged' or 'lost_in_transit' as the reason.
--
-- Backward compatible: the new columns default 0/NULL (zero behavior change for
-- existing rows, same discipline as the 0028 backfill), and the RPCs coalesce
-- the new fields so old-shaped callers keep working.
--
-- Reconciliation is preserved: qty_outstanding stays the generated formula
-- (qty − received − resolved); qty_damaged is a confirm-time ANNOTATION within
-- the outstanding (it flags/pre-fills the reason, it does not change the math).
-- ============================================================================

-- 1. Damaged annotation + evidence photo on both line tables.
--    The received+damaged<=sent (delivery) and good+damaged<=on-hand (return)
--    bounds are enforced in the RPC, NOT a table CHECK, to avoid touching
--    legacy rows.
alter table public.delivery_lines
  add column if not exists qty_damaged int not null default 0 check (qty_damaged >= 0),
  add column if not exists damage_photo_path text;

alter table public.return_lines
  add column if not exists qty_damaged int not null default 0 check (qty_damaged >= 0),
  add column if not exists damage_photo_path text;

-- ---------------------------------------------------------------------------
-- 2. fn_confirm_delivery — the shop counts good / damaged / missing on arrival.
--   p_lines: [{line_id, qty_received, qty_damaged, shop_note, damage_photo_path}]
--   • qty_received (good) lands in shop stock as before.
--   • qty_damaged is RECORDED (does not land); it stays outstanding with the
--     missing units for the owner to resolve.
--   • damage_photo_path, when given, must sit under the caller's OWN
--     shop-<id>/ prefix (matches the receipts bucket shop policy).
--   Old-shaped callers (no qty_damaged / photo) keep working via coalesce.
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
  v_damaged_line int;
  v_short int := 0;      -- outstanding = damaged + missing
  v_damaged int := 0;
  v_landed int := 0;
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
      as x(line_id uuid, qty_received int, qty_damaged int, shop_note text, damage_photo_path text)
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

revoke all on function public.fn_confirm_delivery(uuid, jsonb, text) from public, anon;
grant execute on function public.fn_confirm_delivery(uuid, jsonb, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. fn_return_stock — OWNER inspects on return: GOOD vs DAMAGED per line.
--   p_parts:      [{part_id, qty_good, qty_damaged, note, photo_path}]
--                 (old shape {part_id, qty} still works: qty_good = qty)
--   p_engine_ids: [{engine_id, condition:'good'|'damaged', note, photo_path}]
--   • good  → shop − / master +   (existing return legs; engine → in_master)
--   • damaged → removed from the shop as an owner-created APPROVED loss
--     (reason 'nasira', valued at cost, movement 'loss' −@shop; engine
--     soft-deleted) — business shrinkage, never master sellable stock.
--   One atomic owner action.
-- ---------------------------------------------------------------------------
create or replace function public.fn_return_stock(
  p_shop_id uuid,
  p_reason text,
  p_parts jsonb default '[]'::jsonb,
  p_engine_ids jsonb default '[]'::jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_return_id uuid;
  r record;
  e record;
  v_shop_qty int;
  v_good int;
  v_damaged int;
  v_pname text;
  v_cost bigint;
  v_loss_id uuid;
  v_eng record;
  v_count int := 0;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can process returns';
  end if;

  insert into returns (shop_id, reason, created_by)
  values (p_shop_id, p_reason, auth.uid())
  returning id into v_return_id;

  -- Parts: good → master, damaged → approved loss @shop.
  for r in
    select * from jsonb_to_recordset(coalesce(p_parts, '[]'::jsonb))
      as x(part_id uuid, qty int, qty_good int, qty_damaged int, note text, photo_path text)
  loop
    v_good := coalesce(r.qty_good, r.qty, 0);   -- accept the legacy {part_id, qty}
    v_damaged := coalesce(r.qty_damaged, 0);
    if r.part_id is null then
      raise exception 'Invalid part line';
    end if;
    if v_good < 0 or v_damaged < 0 then
      raise exception 'Quantities cannot be negative';
    end if;
    if v_good + v_damaged <= 0 then
      raise exception 'Each part line needs at least one good or damaged unit';
    end if;

    select qty into v_shop_qty from stock_levels
    where part_id = r.part_id and shop_id = p_shop_id
    for update;
    if v_shop_qty is null or v_shop_qty < v_good + v_damaged then
      raise exception 'Shop does not have enough stock of part % (have %, need %)',
        r.part_id, coalesce(v_shop_qty, 0), v_good + v_damaged;
    end if;

    -- pull everything inspected off the shop shelf
    update stock_levels set qty = qty - (v_good + v_damaged)
    where part_id = r.part_id and shop_id = p_shop_id;

    insert into return_lines (return_id, part_id, qty, qty_damaged, damage_photo_path)
    values (v_return_id, r.part_id, v_good + v_damaged, v_damaged,
            nullif(trim(coalesce(r.photo_path, '')), ''));

    if v_good > 0 then
      insert into stock_levels (part_id, shop_id, qty)
      values (r.part_id, null, v_good)
      on conflict (part_id, shop_id) do update set qty = stock_levels.qty + excluded.qty;

      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, return_id, note)
      values ('return', r.part_id, -v_good, p_shop_id, auth.uid(), v_return_id, p_reason),
             ('return', r.part_id,  v_good, null,      auth.uid(), v_return_id, p_reason);
    end if;

    if v_damaged > 0 then
      select name, cost_centavos into v_pname, v_cost from parts where id = r.part_id;
      insert into losses (shop_id, recorded_by, part_id, qty, reason, note, description,
                          status, value_centavos, reviewed_by, reviewed_at)
      values (p_shop_id, auth.uid(), r.part_id, v_damaged, 'nasira',
              nullif(trim(coalesce(r.note, '')), ''), v_pname,
              'approved', coalesce(v_cost, 0) * v_damaged, auth.uid(), now())
      returning id into v_loss_id;

      insert into stock_movements (movement_type, part_id, qty_change, shop_id, actor, loss_id, note)
      values ('loss', r.part_id, -v_damaged, p_shop_id, auth.uid(), v_loss_id,
              'nasira: damaged on return' || coalesce(' — ' || nullif(trim(coalesce(r.note,'')),''), ''));
    end if;

    v_count := v_count + 1;
  end loop;

  -- Engines: good → in_master, damaged → soft-deleted + approved loss.
  for e in
    select * from jsonb_to_recordset(coalesce(p_engine_ids, '[]'::jsonb))
      as x(engine_id uuid, condition text, note text, photo_path text)
  loop
    if e.engine_id is null then
      raise exception 'Invalid engine line';
    end if;
    if coalesce(e.condition, 'good') not in ('good', 'damaged') then
      raise exception 'Engine condition must be good or damaged';
    end if;

    select id, status, shop_id, cost_centavos, serial_number into v_eng from engines
    where id = e.engine_id and deleted_at is null
    for update;
    if v_eng.id is null then
      raise exception 'Engine % not found', e.engine_id;
    end if;
    if v_eng.status <> 'delivered' or v_eng.shop_id is distinct from p_shop_id then
      raise exception 'Engine % is not at this shop', e.engine_id;
    end if;

    if coalesce(e.condition, 'good') = 'good' then
      update engines set status = 'in_master', shop_id = null where id = e.engine_id;

      insert into return_lines (return_id, engine_id, qty, qty_damaged)
      values (v_return_id, e.engine_id, 1, 0);

      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, return_id, note)
      values ('return', e.engine_id, -1, p_shop_id, auth.uid(), v_return_id, p_reason),
             ('return', e.engine_id,  1, null,      auth.uid(), v_return_id, p_reason);
    else
      update engines set deleted_at = now() where id = e.engine_id;

      insert into return_lines (return_id, engine_id, qty, qty_damaged, damage_photo_path)
      values (v_return_id, e.engine_id, 1, 1, nullif(trim(coalesce(e.photo_path, '')), ''));

      insert into losses (shop_id, recorded_by, engine_id, qty, reason, note, description,
                          status, value_centavos, reviewed_by, reviewed_at)
      values (p_shop_id, auth.uid(), e.engine_id, 1, 'nasira',
              nullif(trim(coalesce(e.note, '')), ''), 'Engine ' || v_eng.serial_number,
              'approved', coalesce(v_eng.cost_centavos, 0), auth.uid(), now())
      returning id into v_loss_id;

      insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, loss_id, note)
      values ('loss', e.engine_id, -1, p_shop_id, auth.uid(), v_loss_id,
              'nasira: damaged on return' || coalesce(' — ' || nullif(trim(coalesce(e.note,'')),''), ''));
    end if;

    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Return must contain at least one line';
  end if;

  return v_return_id;
end $$;

revoke all on function public.fn_return_stock(uuid, text, jsonb, jsonb) from public, anon;
grant execute on function public.fn_return_stock(uuid, text, jsonb, jsonb) to authenticated;
