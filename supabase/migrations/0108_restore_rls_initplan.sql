-- 0108 — Restore the 0076 InitPlan wrapping on the 0106/0107 policies.
-- 0106/0107 recreated these with BARE public.is_owner()/auth_shop_id(), which
-- Postgres evaluates once PER ROW → seq scan on sales/sale_lines/losses/customers
-- at scale. Wrapping each in a scalar subquery hoists it to a single InitPlan.
-- Bodies are otherwise identical to 0106/0107; only eval frequency changes.

drop policy if exists sales_update on public.sales;
create policy sales_update on public.sales for update
  to authenticated using (
    (select public.is_owner())
    or (shop_id = (select public.auth_shop_id()) and recorded_by = auth.uid()
        and status in ('recorded','questioned'))
  ) with check (
    (select public.is_owner())
    or (shop_id = (select public.auth_shop_id()) and recorded_by = auth.uid()
        and status = 'recorded')
  );

drop policy if exists sale_lines_insert on public.sale_lines;
create policy sale_lines_insert on public.sale_lines for insert
  to authenticated with check (
    exists (select 1 from public.sales s where s.id = sale_id
      and ((select public.is_owner())
           or (s.shop_id = (select public.auth_shop_id()) and s.recorded_by = auth.uid()
               and s.status = 'recorded'))));

drop policy if exists sale_lines_update on public.sale_lines;
create policy sale_lines_update on public.sale_lines for update
  to authenticated using (
    exists (select 1 from public.sales s where s.id = sale_id
      and ((select public.is_owner())
           or (s.shop_id = (select public.auth_shop_id()) and s.recorded_by = auth.uid()
               and s.status = 'recorded'))));

drop policy if exists sale_lines_delete on public.sale_lines;
create policy sale_lines_delete on public.sale_lines for delete
  to authenticated using (
    exists (select 1 from public.sales s where s.id = sale_id
      and ((select public.is_owner())
           or (s.shop_id = (select public.auth_shop_id()) and s.recorded_by = auth.uid()
               and s.status = 'recorded'))));

drop policy if exists losses_update on public.losses;
create policy losses_update on public.losses for update
  to authenticated using (
    (select public.is_owner())
    or (shop_id = (select public.auth_shop_id()) and recorded_by = auth.uid()
        and status in ('recorded','questioned'))
  ) with check (
    (select public.is_owner())
    or (shop_id = (select public.auth_shop_id()) and recorded_by = auth.uid()
        and status = 'recorded')
  );

drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select
  to authenticated using (
    (select public.is_owner())
    or exists (select 1 from public.sales s
               where s.customer_id = customers.id
                 and s.shop_id = (select public.auth_shop_id())
                 and s.deleted_at is null)
  );
