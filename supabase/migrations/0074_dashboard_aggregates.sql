-- 0074 — dashboard + nav-badge aggregates computed in SQL, not by shipping rows.
--
-- The dashboard was summing THOUSANDS of raw rows in the app (receivables,
-- month sales) on every load, blocking the page for seconds on the free tier.
-- These owner-only functions do the sum/count in the database and return a
-- handful of numbers in one round-trip. lib/dashboard.ts calls them and falls
-- back to direct queries if this migration isn't applied, so the app works
-- either way — applying it only makes the dashboard fast.
--
-- All three are SECURITY DEFINER (they read owner-only views like receivables /
-- supplier_payables / *_low_stock) and each GUARDS its caller with is_owner()
-- in-body, per test-definer-guards.

-- ── the dashboard KPI scalars, one round-trip ───────────────────────────────
create or replace function public.fn_dashboard_summary()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := public.ph_today();
begin
  if not public.is_owner() then
    raise exception 'Only the owner can read the dashboard';
  end if;

  return jsonb_build_object(
    'pending_count',
      (select count(*) from sales  where status in ('pending','questioned') and deleted_at is null)
    + (select count(*) from losses where status in ('pending','questioned') and deleted_at is null),
    'today_revenue',
      (select coalesce(sum(total_centavos), 0) from sales
        where status = 'approved' and business_date = v_today and deleted_at is null),
    'today_count',
      (select count(*) from sales
        where status = 'approved' and business_date = v_today and deleted_at is null),
    'master_item_count',
      (select count(*) from stock_levels sl join parts p on p.id = sl.part_id
        where sl.shop_id is null and sl.qty > 0 and p.deleted_at is null)
    + (select count(*) from engines where status = 'in_master' and deleted_at is null),
    'low_stock_count',      (select count(*) from shop_low_stock),
    'in_transit_count',     (select count(*) from deliveries where status = 'in_transit' and deleted_at is null),
    'need_you_count',       (select count(*) from deliveries where status in ('discrepancy','requested') and deleted_at is null),
    'payables_owed',          (select coalesce(sum(outstanding), 0)     from supplier_payables),
    'payables_overdue',       (select coalesce(sum(overdue_amount), 0)  from supplier_payables),
    'payables_overdue_count', (select coalesce(sum(overdue_count), 0)   from supplier_payables),
    'receivables_owed',  (select coalesce(sum(balance_centavos), 0) from receivables where balance_centavos > 0),
    'receivables_count', (select count(*)                          from receivables where balance_centavos > 0)
  );
end $$;

revoke all on function public.fn_dashboard_summary() from public, anon;
grant execute on function public.fn_dashboard_summary() to authenticated;

-- ── top-selling products in a date range (approved sales) ───────────────────
create or replace function public.fn_dashboard_top_products(
  p_from date,
  p_to date,
  p_limit int default 5
)
returns table (name text, qty bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Only the owner can read the dashboard';
  end if;

  return query
    select coalesce(sl.description, 'Item') as name, sum(sl.qty)::bigint as qty
    from sales s
    join sale_lines sl on sl.sale_id = s.id
    where s.status = 'approved'
      and s.business_date between p_from and p_to
      and s.deleted_at is null
    group by 1
    order by 2 desc
    limit greatest(p_limit, 1);
end $$;

revoke all on function public.fn_dashboard_top_products(date, date, int) from public, anon;
grant execute on function public.fn_dashboard_top_products(date, date, int) to authenticated;

-- ── the owner sidebar badge counts, one round-trip ──────────────────────────
create or replace function public.fn_nav_badge_counts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Only the owner can read these counts';
  end if;

  return jsonb_build_object(
    'approvals',
      (select count(*) from sales  where status in ('pending','questioned') and deleted_at is null)
    + (select count(*) from losses where status in ('pending','questioned') and deleted_at is null),
    'deliveries',
      (select count(*) from deliveries where status in ('requested','discrepancy') and deleted_at is null)
    + (select count(*) from returns    where status = 'requested' and deleted_at is null),
    'stock_alerts',
      (select count(*) from master_low_stock)
    + (select count(*) from shop_low_stock)
    + (select count(*) from delivery_requests where status = 'open' and deleted_at is null),
    'receivables', (select count(*) from receivables where balance_centavos > 0),
    'warranties',  (select count(*) from warranty_claims where status = 'requested' and deleted_at is null),
    'suppliers',   (select count(*) from receiving_balances where overdue = true)
  );
end $$;

revoke all on function public.fn_nav_badge_counts() from public, anon;
grant execute on function public.fn_nav_badge_counts() to authenticated;
