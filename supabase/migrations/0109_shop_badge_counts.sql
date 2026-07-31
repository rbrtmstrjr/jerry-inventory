-- 0109 — one round-trip for the shop nav badge counts + shop name.
-- The shop layout blocked every shop page on getProfile + 4 separate view
-- queries. This returns all of it in a single SECURITY DEFINER call, scoped to
-- the caller's own shop. Read-only (like fn_stock_card / fn_cron_job_health).
create or replace function public.fn_shop_badge_counts()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_name text;
  v_del int; v_low int; v_rec int;
begin
  v_shop := (select shop_id from profiles
             where id = auth.uid() and role = 'employee' and active and deleted_at is null);
  if v_shop is null then
    raise exception 'Only shop staff can read shop badge counts';
  end if;

  select name into v_name from shops where id = v_shop;
  select count(*) into v_del  from shop_incoming_deliveries where status = 'in_transit';
  select count(*) into v_low  from shop_low_stock_safe;
  select count(*) into v_rec  from shop_receivables where balance_centavos > 0;

  return jsonb_build_object(
    'shop_name', coalesce(v_name, 'My Shop'),
    'deliveries', v_del, 'low_stock', v_low, 'receivables', v_rec
  );
end $$;

revoke all on function public.fn_shop_badge_counts() from public, anon;
grant execute on function public.fn_shop_badge_counts() to authenticated;
