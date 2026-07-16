-- ---------------------------------------------------------------------------
-- 0045 — Movements as a BOOK: journal view, stock card, indexes
--
-- Presentation over the existing append-only ledger. No stock function changes,
-- no new movement types, nothing that can write stock.
--
-- ===========================================================================
-- THE BUG THIS FIXES: master's ledger double-debits a transit write-off
-- ===========================================================================
-- Measured, not theorised. Send 2 units toward a shop, shop confirms 0
-- arrived, owner writes them off:
--
--   fn_deliver_stock              → ('delivery', -2, shop_id NULL)  + stock_levels master -2
--   fn_resolve_delivery_discrepancy → ('transit_writeoff', -2, shop_id NULL)  + NO stock write
--                                     ("it already left master and never landed")
--
-- shop_id IS NULL reads as "master" everywhere else in this schema, so master's
-- ledger sums to -2 while master's actual stock is 0. A stock card built on that
-- prints a NEGATIVE running balance and a closing balance that doesn't match
-- live stock — the exact thing that makes an owner stop trusting the book.
--
-- The root cause is that the ledger has no IN-TRANSIT location: stock lost
-- between master and shop was in neither.
--
-- THE FIX (presentation only): `transit_writeoff` is reported at location
-- 'transit', not 'master'. It is the ONLY movement type that debits a bucket it
-- never occupied:
--   • transit_return    → the stock really does land back in master, and it
--                         really does credit stock_levels. Stays at master.
--   • transit_writeoff  → lands nowhere. Belongs to transit.
--
-- With that one row relocated, `Σ movements = stock_levels` holds exactly for
-- master and for every shop — asserted in scripts/test-movements.mjs.
--
-- Transit write-offs are therefore absent from any stock card, and that is
-- correct: a card is a bin card, and those units never reached a bin. They stay
-- visible in the Journal (under "In transit") and in the P&L's shrinkage line.
-- ---------------------------------------------------------------------------

-- ── Indexes ────────────────────────────────────────────────────────────────
-- 0001 gave single-column indexes on (created_at), (part_id), (engine_id).
-- These views filter by product AND location and then sort by (created_at, id),
-- so the composites are what actually get used. `id` is in the index because
-- the ordering is (created_at, id) — see the determinism note on fn_stock_card.
create index if not exists idx_movements_part_shop_time
  on public.stock_movements (part_id, shop_id, created_at, id)
  where part_id is not null;

create index if not exists idx_movements_engine_time
  on public.stock_movements (engine_id, created_at, id)
  where engine_id is not null;

create index if not exists idx_movements_type_time
  on public.stock_movements (movement_type, created_at);

-- ---------------------------------------------------------------------------
-- movement_journal — one readable row per movement.
--
-- OWNER-ONLY. Guarded by `public.is_owner()` in the WHERE clause, the same way
-- master_low_stock and reviewed_items are: this is a view, so it has no RLS of
-- its own, and it reads owner-only base tables. security_barrier stops a
-- user-supplied function in a caller's WHERE being pushed down ahead of the
-- guard.
--
-- Read-only by construction. `stock_movements` has no INSERT/UPDATE/DELETE
-- policy for anyone (0002 grants SELECT only), so the ledger can only ever be
-- appended to by SECURITY DEFINER functions. Nothing here changes that.
-- ---------------------------------------------------------------------------
create or replace view public.movement_journal
with (security_barrier = true) as
select
  m.id,
  m.created_at,
  m.movement_type::text                       as movement_type,

  -- See the header: transit_writeoff is the one row that never touched the
  -- bucket its shop_id implies.
  case
    when m.movement_type = 'transit_writeoff' then 'transit'
    when m.shop_id is null                    then 'master'
    else 'shop'
  end                                          as location_kind,
  m.shop_id,
  case
    when m.movement_type = 'transit_writeoff' then 'In transit'
    when m.shop_id is null                    then 'Master'
    else sh.name
  end                                          as location_label,

  m.part_id,
  m.engine_id,
  coalesce(p.name, em.brand || ' ' || em.model) as product_name,
  p.sku,
  e.serial_number,
  coalesce(p.unit, 'unit')                     as unit,

  m.qty_change,
  greatest(m.qty_change, 0)                    as qty_in,
  greatest(-m.qty_change, 0)                   as qty_out,

  -- `reason` is NOT a column on stock_movements — it lives on the loss the
  -- movement came from, and fn_approve_loss only smuggles it into `note` as
  -- text. Surfaced properly here so the Journal can filter and display it.
  l.reason::text                               as reason,
  m.note,

  m.actor,
  pr.full_name                                 as actor_name,

  -- Source document. Exactly one of these is set per row (a count shortage
  -- arrives as a loss, so loss_id covers it).
  m.sale_id, m.loss_id, m.delivery_id, m.return_id, m.receiving_id,
  s.receipt_no,

  lower(
    concat_ws(' ',
      coalesce(p.name, em.brand || ' ' || em.model),
      p.sku, e.serial_number, s.receipt_no, m.note,
      case when m.shop_id is null then 'master' else sh.name end,
      pr.full_name
    )
  )                                            as search_text
from public.stock_movements m
left join public.parts p          on p.id = m.part_id
left join public.engines e        on e.id = m.engine_id
left join public.engine_models em on em.id = e.engine_model_id
left join public.shops sh         on sh.id = m.shop_id
left join public.profiles pr      on pr.id = m.actor
left join public.losses l         on l.id = m.loss_id
left join public.sales s          on s.id = m.sale_id
where public.is_owner();

comment on view public.movement_journal is
  'Owner-only readable ledger. One row per stock_movements row, with the source
   document, actor and loss reason resolved. transit_writeoff is reported at
   location ''transit'' — it is the only movement that debits a bucket it never
   occupied, and leaving it at ''master'' makes master''s balance disagree with
   stock_levels. Read-only: stock_movements has no write policy for anyone.';

revoke all on public.movement_journal from anon;
grant select on public.movement_journal to authenticated;

-- ---------------------------------------------------------------------------
-- fn_stock_card — the bin card: opening balance, running balance, closing.
--
-- WHY A FUNCTION: the running balance needs a window function over the WHOLE
-- series, and the opening balance needs every movement BEFORE the period.
-- Neither is expressible through PostgREST, and computing a running balance in
-- the client over a paginated slice gives a different (wrong) answer on every
-- page — the balance would restart from zero on page 2.
--
-- DETERMINISTIC ORDER: (created_at, id). Two movements can share a timestamp —
-- fn_return_stock writes its shop leg and master leg in the same statement — and
-- ordering by created_at alone lets them swap between loads, which silently
-- changes the balance column on refresh. `id` is the tiebreaker.
--
-- p_shop_id NULL = master, hence `is not distinct from` rather than `=`.
-- ---------------------------------------------------------------------------
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
  qty_in       int,
  qty_out      int,
  balance      bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_open   bigint;
  v_from_ts timestamptz;
  v_to_ts   timestamptz;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can read a stock card';
  end if;

  -- Business dates are PH. created_at is an instant. Convert the PH calendar
  -- day boundaries to instants rather than comparing a timestamptz to a date,
  -- which would silently use UTC midnight and misfile 8 hours of movements.
  v_from_ts := (p_from::timestamp) at time zone 'Asia/Manila';
  v_to_ts   := ((p_to + 1)::timestamp) at time zone 'Asia/Manila';

  -- Opening balance: EVERYTHING before the period. Without it a filtered card
  -- starts from a lie.
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
      -- Particulars: what a person would write in the book.
      case m.movement_type::text
        when 'received'       then 'Received from ' || coalesce(sup.name, 'supplier')
        when 'delivery'       then case
                                     when m.shop_id is null then 'Delivered to ' || coalesce(dsh.name, 'shop')
                                     else 'Received from Master'
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
    left join public.returns rt    on rt.id = m.return_id
    left join public.shops rsh     on rsh.id = rt.shop_id
    where m.part_id = p_part_id
      and m.shop_id is not distinct from p_shop_id
      -- Never touched this bin — see the migration header.
      and m.movement_type::text <> 'transit_writeoff'
      and m.created_at >= v_from_ts
      and m.created_at <  v_to_ts
  ) r
  order by 3, 2 nulls first;
end;
$$;

comment on function public.fn_stock_card(uuid, uuid, date, date) is
  'Owner-only bin card for one part at one location (p_shop_id NULL = master).
   Returns an opening-balance row followed by every movement in the PH date
   range with a running balance, ordered deterministically by (created_at, id).
   Excludes transit_writeoff: those units never reached this bin.';

revoke all on function public.fn_stock_card(uuid, uuid, date, date) from public, anon;
grant execute on function public.fn_stock_card(uuid, uuid, date, date) to authenticated;
