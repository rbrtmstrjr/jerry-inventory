-- ---------------------------------------------------------------------------
-- 0083 — remove the Payroll feature (keep Staff + birthdays).
--
-- Client feedback: payroll is run outside the app now. This drops the whole
-- payroll surface — pay periods, entries, the frozen contribution snapshots,
-- vale/cash-advance, and the government-contribution rate book — plus the two
-- payroll dials on `settings`. Labor stops being a P&L line; wages, if tracked,
-- ride the Expenses module like any other operating cost.
--
-- KEPT ON PURPOSE: `staff` and `positions` (dormant), and the whole
-- `staff_birthdays_today` birthday reminder (0079) that reads `staff`. Staff are
-- now managed from Shops & Employees, not Payroll.
--
-- Old migrations (0012/0039–0042/0071/0078/0080) are left untouched — this is an
-- append-only drop. Enum types (`pay_frequency`, `contribution_agency`, …) are
-- left in place, harmless and dormant.
-- ---------------------------------------------------------------------------

-- 1. Redefine the P&L facts RPC WITHOUT payroll (the ps_pg/ps_er CTEs and the
--    payroll_gross/payroll_er output keys are gone). Must run before the tables
--    are dropped. Otherwise byte-identical to 0075.
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
  shop_ids as (
    select shop_id from ps_rev where shop_id is not null
    union select shop_id from ps_loss where shop_id is not null
    union select shop_id from ps_opex where shop_id is not null
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
        'opex',            coalesce(ox.opex, 0)
      ))
      from shop_ids si
      left join ps_rev   r  on r.shop_id  = si.shop_id
      left join ps_cogs  cg on cg.shop_id = si.shop_id
      left join ps_lines ln on ln.shop_id = si.shop_id
      left join ps_loss  ls on ls.shop_id = si.shop_id
      left join ps_opex  ox on ox.shop_id = si.shop_id
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

-- 2. Drop the payroll balances view (over payroll_entries + staff_advances).
drop view if exists public.staff_advance_balances;

-- 3. Drop every payroll RPC. Names are unique (no overloads) except
--    fn_create_pay_period, whose old + new signatures are both dropped.
drop function if exists public.fn_apply_entry_contributions;
drop function if exists public.fn_save_entry_contributions;
drop function if exists public.fn_save_payroll_vale;
drop function if exists public.fn_record_staff_advance;
drop function if exists public.fn_void_staff_advance;
drop function if exists public.fn_create_pay_period(text, date, date, public.pay_frequency, boolean);
drop function if exists public.fn_create_pay_period(text, date, date, public.pay_frequency);
drop function if exists public.fn_save_payroll_days;
drop function if exists public.fn_approve_pay_period;
drop function if exists public.fn_mark_payroll_paid;
drop function if exists public.fn_set_pay_period_status;
drop function if exists public.fn_remittance_totals;
drop function if exists public.fn_resolve_contribution;
drop function if exists public.fn_contribution_basis;
drop function if exists public.fn_payroll_gross;

-- 4. Drop the payroll tables in FK order (RLS policies + triggers + the
--    contribution_brackets exclusion constraint drop with them). `staff` and
--    `positions` are KEPT.
drop table if exists public.payroll_entry_contributions;
drop table if exists public.staff_advances;
drop table if exists public.payroll_entries;
drop table if exists public.pay_periods;
drop table if exists public.contribution_brackets;

-- 5. Drop the two payroll-only dials on the settings row.
alter table public.settings
  drop column if exists payroll_working_days_per_month,
  drop column if exists contribution_split_semimonthly;
