-- ---------------------------------------------------------------------------
-- 0121 — fn_stock_card: the running balance is a QUANTITY, not money.
--
-- 0120 retyped this function's qty_in/qty_out to numeric but left two things
-- bigint, and the function has been broken since:
--
--     balance  bigint    (RETURNS TABLE column — the running balance)
--     v_open   bigint    (the opening balance, sum(qty_change))
--
-- Postgres does not tolerate that mismatch. The declared result type no longer
-- matched what the query produced, so EVERY call failed outright with
--
--     42804  structure of query does not match function result type
--
-- Loudly, at least — the Movements → Stock Card page and test-movements both
-- broke immediately rather than returning quietly wrong numbers.
--
-- WHY IT WAS MISSED, so the next person does better than I did: the audit that
-- caught v_good / v_damaged / v_transit in 0120 scanned for locals declared
-- `int`. `bigint` was not in the pattern, and neither were RETURNS TABLE
-- columns. Both are places a quantity can hide.
--
-- The rule that actually holds:
--     bigint  = MONEY (centavos, integer by contract)   -- keep
--     numeric = QUANTITY (tenths, since 0116)           -- convert
-- Every other bigint across 0117-0120 was re-checked against that rule and is
-- money: v_unit, v_total, v_cost, v_value, v_card_price, v_paid, v_limit and
-- the rest. This function was the only quantity in a bigint.
--
-- Dropped first: the RETURNS TABLE type is changing again, and `create or
-- replace` cannot change a return type.
-- ---------------------------------------------------------------------------

drop function if exists public.fn_stock_card(uuid, uuid, date, date);

create or replace function public.fn_stock_card(
  p_part_id uuid,
  p_shop_id uuid,
  p_from    date,
  p_to      date
)
returns table (
  kind         text,
  movement_id  uuid,
  created_at   timestamptz,
  movement_type text,
  reference    text,
  particulars  text,
  qty_in       numeric,
  qty_out      numeric,
  balance      numeric
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_open   numeric;
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can read a stock card';
  end if;

  v_from_ts := (p_from::timestamp) at time zone 'Asia/Manila';
  v_to_ts   := ((p_to + 1)::timestamp) at time zone 'Asia/Manila';

  select coalesce(sum(m.qty_change), 0) into v_open
  from public.stock_movements m
  where m.part_id = p_part_id
    and m.shop_id is not distinct from p_shop_id
    and m.movement_type::text <> 'transit_writeoff'
    and m.created_at < v_from_ts;

  return query
  select
    'opening'::text, null::uuid, v_from_ts, null::text, null::text,
    'Opening balance'::text, null::int, null::int, v_open

  union all

  select
    'movement'::text,
    r.id,
    r.created_at,
    r.movement_type,
    r.reference,
    r.particulars,
    r.qty_in,
    r.qty_out,
    v_open + sum(r.qty_change) over (order by r.created_at, r.id)
  from (
    select
      m.id,
      m.created_at,
      m.movement_type::text as movement_type,
      m.qty_change,
      greatest(m.qty_change, 0)  as qty_in,
      greatest(-m.qty_change, 0) as qty_out,
      case
        when m.receiving_id is not null then 'RCV-' || upper(left(m.receiving_id::text, 8))
        when m.delivery_id  is not null then 'DN-'  || upper(left(m.delivery_id::text, 8))
        when m.return_id    is not null then 'RET-' || upper(left(m.return_id::text, 8))
        when m.sale_id      is not null then coalesce(s.receipt_no, 'OR-' || upper(left(m.sale_id::text, 8)))
        when m.loss_id      is not null then 'LOS-' || upper(left(m.loss_id::text, 8))
        else null
      end as reference,
      case m.movement_type::text
        when 'received'       then 'Received from ' || coalesce(sup.name, 'supplier')
        -- sign-based so it is correct for master AND transfers:
        --   −qty is the outbound (send) leg; +qty is the inbound (arrive) leg
        when 'delivery'       then case
                                     when m.qty_change < 0 then 'Delivered to ' || coalesce(dsh.name, 'shop')
                                     else 'Received from ' || coalesce(fsh.name, 'Master')
                                   end
        when 'return'         then case
                                     when m.shop_id is null then 'Returned from ' || coalesce(rsh.name, 'shop')
                                     else 'Returned to Master'
                                   end
        when 'sale'           then 'Sold' || coalesce(' — ' || s.receipt_no, '')
        when 'loss'           then coalesce(initcap(l.reason::text), 'Loss')
                                   || coalesce(' — ' || nullif(l.note, ''), '')
        when 'transit_return' then 'Recovered from transit'
        when 'correction'     then 'Correction'
        else m.movement_type::text
      end as particulars
    from public.stock_movements m
    left join public.sales s      on s.id = m.sale_id
    left join public.losses l     on l.id = m.loss_id
    left join public.receivings rc on rc.id = m.receiving_id
    left join public.suppliers sup on sup.id = rc.supplier_id
    left join public.deliveries d  on d.id = m.delivery_id
    left join public.shops dsh     on dsh.id = d.shop_id
    left join public.shops fsh     on fsh.id = d.from_shop_id
    left join public.returns rt    on rt.id = m.return_id
    left join public.shops rsh     on rsh.id = rt.shop_id
    where m.part_id = p_part_id
      and m.shop_id is not distinct from p_shop_id
      and m.movement_type::text <> 'transit_writeoff'
      and m.created_at >= v_from_ts
      and m.created_at <  v_to_ts
  ) r
  order by 3, 2 nulls first;
end;
$$;
