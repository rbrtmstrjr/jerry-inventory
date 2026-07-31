-- 0111 — SQL aggregate for the Reports · Sales & Inventory tab.
--
-- The tab fetchAll'd every approved sale + its lines (and losses, and transit
-- write-offs) for the range to the browser and summed in JS — O(transactions).
-- At the 3-year dataset a wide range shipped ~13k+ sales × lines per 1000-row
-- page, so a 90-day report took ~2.3s and a year ~6.9s. This computes the same
-- aggregates in SQL (the fn_pnl_facts pattern), returning a handful of rows so
-- any range is flat. Money math must stay byte-identical to the JS row-walk —
-- proven by scripts/test-sales-report.mjs before the app switches to it.
--
-- Owner-only (is_owner wrapped as an InitPlan per 0076). Read-only.
-- The row-level detail the JS also produced (per-line CSV export, the
-- engines-sold table) is NOT summed here: CSV export becomes an on-demand fetch,
-- and engines_sold is returned as a capped list.

create or replace function public.fn_sales_report(
  p_from date,
  p_to date,
  p_shop_id uuid default null
) returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not (select public.is_owner()) then
    raise exception 'Only the owner can read sales reports';
  end if;

  with rng_sales as (
    select s.id, s.shop_id, s.business_date, s.total_centavos
    from sales s
    where s.status = 'approved'
      and s.business_date between p_from and p_to
      and s.deleted_at is null
      and (p_shop_id is null or s.shop_id = p_shop_id)
  ),
  rng_lines as (
    select rs.shop_id, rs.business_date, sl.description, sl.qty,
           sl.line_total_centavos, sl.part_id, sl.engine_id
    from rng_sales rs
    join sale_lines sl on sl.sale_id = rs.id
  ),
  rng_losses as (
    select l.reason, l.qty, l.value_centavos
    from losses l
    where l.status = 'approved'
      and l.business_date between p_from and p_to
      and l.deleted_at is null
      and (p_shop_id is null or l.shop_id = p_shop_id)
  ),
  rng_transit as (
    select abs(m.qty_change) as qty,
           coalesce(p.cost_centavos, e.cost_centavos, 0) as unit_cost
    from stock_movements m
    left join parts p on p.id = m.part_id
    left join engines e on e.id = m.engine_id
    where m.movement_type = 'transit_writeoff'
      and m.created_at >= p_from::timestamptz
      and m.created_at < (p_to + 1)::timestamptz
  )
  select jsonb_build_object(
    'totals', jsonb_build_object(
      'revenue',        (select coalesce(sum(total_centavos), 0) from rng_sales),
      'sales_count',    (select count(*) from rng_sales),
      'loss_value',     (select coalesce(sum(value_centavos), 0) from rng_losses),
      'loss_count',     (select count(*) from rng_losses),
      'transit_value',  (select coalesce(sum(qty * unit_cost), 0) from rng_transit),
      'transit_qty',    (select coalesce(sum(qty), 0) from rng_transit),
      'engines_sold',   (select count(*) from rng_lines where engine_id is not null)
    ),
    -- per (day, shop) revenue — the trend chart series
    'trend', coalesce((
      select jsonb_agg(t) from (
        select business_date as date, shop_id,
               sum(total_centavos) as revenue
        from rng_sales
        group by business_date, shop_id
        order by business_date
      ) t
    ), '[]'::jsonb),
    'by_shop', coalesce((
      select jsonb_agg(t) from (
        select shop_id,
               sum(total_centavos) as revenue,
               count(*) as count
        from rng_sales
        group by shop_id
      ) t
    ), '[]'::jsonb),
    'by_reason', coalesce((
      select jsonb_agg(t) from (
        select reason,
               sum(value_centavos) as value,
               sum(qty) as qty
        from rng_losses
        group by reason
      ) t
    ), '[]'::jsonb),
    'top_parts', coalesce((
      select jsonb_agg(t) from (
        select coalesce(description, 'Item') as name,
               sum(qty) as qty,
               sum(line_total_centavos) as revenue
        from rng_lines
        where part_id is not null
        group by coalesce(description, 'Item')
        order by sum(qty) desc
        limit 10
      ) t
    ), '[]'::jsonb),
    -- engines sold — a list, capped (row-level; wide ranges truncate the table)
    'engines_sold_list', coalesce((
      select jsonb_agg(t) from (
        select coalesce(description, 'Engine') as description,
               shop_id, business_date as date,
               line_total_centavos as price_centavos
        from rng_lines
        where engine_id is not null
        order by business_date desc
        limit 2000
      ) t
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

revoke all on function public.fn_sales_report(date, date, uuid) from public, anon;
grant execute on function public.fn_sales_report(date, date, uuid) to authenticated;
