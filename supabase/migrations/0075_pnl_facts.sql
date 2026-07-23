-- 0075 — P&L facts aggregated in SQL, so computePnl stops shipping rows.
--
-- lib/pnl.ts computed the P&L by fetching every sale + line + frozen cost in a
-- range and summing them in JavaScript — O(transactions). At one year a
-- full-year P&L already took ~20s; at five years it would time out. This
-- function does the identical aggregation in the database and returns a handful
-- of numbers (per-shop rows + a few globals), so the cost becomes O(shops×days)
-- — flat as history grows.
--
-- It mirrors computePnl EXACTLY (the app keeps the JS row-walk as a fallback and
-- asserts the two produce byte-identical numbers). SECURITY DEFINER + is_owner()
-- guard (reads owner-only sale_line_costs / expenses / payroll). All the joins
-- it needs are already indexed (sale_line_costs PK on sale_line_id, 0073
-- indexes on sale_lines, payroll_entry_contributions on payroll_entry_id).
--
-- p_shop_id scopes the per-shop + line-split facts to one branch (the /reports
-- ?tab=shops drill-down). company_overhead and transit_writeoffs are business-
-- level and are NEVER shop-scoped — exactly as the JS leaves them outside bump().

create or replace function public.fn_pnl_facts(
  p_from date,
  p_to date,
  p_shop_id uuid default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can compute the P&L';
  end if;

  with rng_sales as (
    select s.id, s.shop_id, s.total_centavos
    from sales s
    where s.status = 'approved'
      and s.business_date between p_from and p_to
      and s.deleted_at is null
      and (p_shop_id is null or s.shop_id = p_shop_id)
  ),
  -- one row per sale LINE, with its frozen cost and the discount resolved the
  -- same way the JS does: stored discount first, else asking − agreed, else NULL
  -- (unknown — a pre-tier-pricing sale, never counted as a zero discount).
  lf as (
    select rs.shop_id,
           (sl.engine_id is not null) as is_engine,
           sl.qty,
           sl.line_total_centavos as rev,
           coalesce(slc.line_cost_centavos, 0) as cost,
           coalesce(
             sl.discount_centavos,
             case when sl.list_reference_centavos is not null
                   and sl.agreed_price_centavos is not null
                  then sl.list_reference_centavos - sl.agreed_price_centavos
             end
           ) as d
    from rng_sales rs
    join sale_lines sl on sl.sale_id = rs.id
    left join sale_line_costs slc on slc.sale_line_id = sl.id
  ),
  ps_rev as (
    select shop_id, sum(total_centavos) as revenue, count(*) as sales_count
    from rng_sales group by shop_id
  ),
  -- a.cogs in the JS sums ALL sale_line_costs for the sale (by sale_id), so do
  -- the same here — kept separate from the by-line part/engine split below.
  ps_cogs as (
    select rs.shop_id, sum(slc.line_cost_centavos) as cogs
    from rng_sales rs
    join sale_line_costs slc on slc.sale_id = rs.id
    group by rs.shop_id
  ),
  ps_lines as (
    select shop_id,
           sum(qty) filter (where not is_engine)                    as units_sold,
           count(*) filter (where is_engine)                        as engines_sold,
           sum(d)   filter (where is_engine and d is not null)      as engine_discount
    from lf group by shop_id
  ),
  ps_loss as (
    select shop_id, sum(value_centavos) as losses
    from losses
    where status = 'approved' and business_date between p_from and p_to and deleted_at is null
      and (p_shop_id is null or shop_id = p_shop_id)
    group by shop_id
  ),
  ps_opex as (
    select shop_id, sum(amount) as opex
    from expenses
    where scope = 'shop' and status = 'approved'
      and expense_date between p_from and p_to and deleted_at is null
      and (p_shop_id is null or shop_id = p_shop_id)
    group by shop_id
  ),
  ps_pg as (
    select pe.shop_id, sum(pe.gross_pay) as gross
    from payroll_entries pe
    join pay_periods pp on pp.id = pe.pay_period_id
    where pp.start_date <= p_to and pp.end_date >= p_from and pp.deleted_at is null
      and (p_shop_id is null or pe.shop_id = p_shop_id)
    group by pe.shop_id
  ),
  ps_er as (
    select pe.shop_id, sum(pec.er_amount_centavos) as er
    from payroll_entries pe
    join pay_periods pp on pp.id = pe.pay_period_id
    join payroll_entry_contributions pec on pec.payroll_entry_id = pe.id
    where pp.start_date <= p_to and pp.end_date >= p_from and pp.deleted_at is null
      and (p_shop_id is null or pe.shop_id = p_shop_id)
    group by pe.shop_id
  ),
  shop_ids as (
    select shop_id from ps_rev where shop_id is not null
    union select shop_id from ps_loss where shop_id is not null
    union select shop_id from ps_opex where shop_id is not null
    union select shop_id from ps_pg   where shop_id is not null
    union select shop_id from ps_er   where shop_id is not null
  )
  select jsonb_build_object(
    'per_shop', coalesce((
      select jsonb_agg(jsonb_build_object(
        'shop_id',         si.shop_id,
        'revenue',         coalesce(r.revenue, 0),
        'sales_count',     coalesce(r.sales_count, 0),
        'cogs',            coalesce(cg.cogs, 0),
        'units_sold',      coalesce(ln.units_sold, 0),
        'engines_sold',    coalesce(ln.engines_sold, 0),
        'engine_discount', coalesce(ln.engine_discount, 0),
        'losses',          coalesce(ls.losses, 0),
        'opex',            coalesce(ox.opex, 0),
        'payroll_gross',   coalesce(pg.gross, 0),
        'payroll_er',      coalesce(er.er, 0)
      ))
      from shop_ids si
      left join ps_rev   r  on r.shop_id  = si.shop_id
      left join ps_cogs  cg on cg.shop_id = si.shop_id
      left join ps_lines ln on ln.shop_id = si.shop_id
      left join ps_loss  ls on ls.shop_id = si.shop_id
      left join ps_opex  ox on ox.shop_id = si.shop_id
      left join ps_pg    pg on pg.shop_id = si.shop_id
      left join ps_er    er on er.shop_id = si.shop_id
    ), '[]'::jsonb),
    'part_revenue',   coalesce((select sum(rev)  from lf where not is_engine), 0),
    'part_cogs',      coalesce((select sum(cost) from lf where not is_engine), 0),
    'engine_revenue', coalesce((select sum(rev)  from lf where is_engine), 0),
    'engine_cogs',    coalesce((select sum(cost) from lf where is_engine), 0),
    'engine_discount_lines',         coalesce((select count(*) from lf where is_engine and d is not null), 0),
    'engine_discount_unknown_lines', coalesce((select count(*) from lf where is_engine and d is null), 0),
    'company_overhead', coalesce((
      select sum(amount) from expenses
      where scope = 'company' and status = 'approved'
        and expense_date between p_from and p_to and deleted_at is null
    ), 0),
    'transit_writeoffs', coalesce((
      select sum(abs(sm.qty_change) * coalesce(p.cost_centavos, e.cost_centavos, 0))
      from stock_movements sm
      left join parts p   on p.id = sm.part_id
      left join engines e on e.id = sm.engine_id
      where sm.movement_type = 'transit_writeoff'
        and sm.created_at >= p_from::timestamptz
        and sm.created_at <= (p_to::text || 'T23:59:59.999')::timestamptz
    ), 0)
  ) into v_result;

  return v_result;
end $$;

revoke all on function public.fn_pnl_facts(date, date, uuid) from public, anon;
grant execute on function public.fn_pnl_facts(date, date, uuid) to authenticated;
