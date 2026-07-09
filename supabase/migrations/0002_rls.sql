-- ============================================================================
-- 0002_rls.sql — Row-Level Security: the access enforcer
--
-- Rules:
--  • Owner: full access to everything.
--  • Employee: scoped to exactly ONE shop_id. Can never read master
--    inventory, cost/margin fields, other shops, or owner-only figures.
--  • Employees read shop stock via SECURITY DEFINER views that EXCLUDE
--    cost columns — sensitive data is physically unreachable.
--  • The stock ledger is written only by SECURITY DEFINER functions.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Helper functions (SECURITY DEFINER so they can read profiles without
-- recursive RLS; STABLE so they're evaluated once per statement)
-- ---------------------------------------------------------------------------
create or replace function public.is_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner' and active
  );
$$;

create or replace function public.auth_shop_id()
returns uuid
language sql stable security definer set search_path = ''
as $$
  select shop_id from public.profiles
  where id = auth.uid() and active;
$$;

revoke all on function public.is_owner() from public;
revoke all on function public.auth_shop_id() from public;
grant execute on function public.is_owner() to authenticated;
grant execute on function public.auth_shop_id() to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere (deny-by-default)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'shops','profiles','suppliers','product_categories','engine_models','parts',
    'part_fitments','customers','engines','stock_levels','receivings',
    'receiving_lines','deliveries','delivery_lines','returns','return_lines',
    'sales','sale_lines','losses','stock_movements','warranties',
    'warranty_claims','count_snapshots','count_snapshot_lines','settings'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
  end loop;
end $$;

-- Make sure the anon key can't touch anything directly.
do $$
declare t text;
begin
  foreach t in array array[
    'shops','profiles','suppliers','product_categories','engine_models','parts',
    'part_fitments','customers','engines','stock_levels','receivings',
    'receiving_lines','deliveries','delivery_lines','returns','return_lines',
    'sales','sale_lines','losses','stock_movements','warranties',
    'warranty_claims','count_snapshots','count_snapshot_lines','settings'
  ] loop
    execute format('revoke all on public.%I from anon;', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- profiles: self-read; owner manages
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  to authenticated using (id = auth.uid() or public.is_owner());

drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert
  to authenticated with check (public.is_owner());

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete
  to authenticated using (public.is_owner());

-- ---------------------------------------------------------------------------
-- shops: owner all; employee sees only their own shop
-- ---------------------------------------------------------------------------
drop policy if exists shops_select on public.shops;
create policy shops_select on public.shops for select
  to authenticated using (public.is_owner() or id = public.auth_shop_id());

drop policy if exists shops_write on public.shops;
create policy shops_write on public.shops for all
  to authenticated using (public.is_owner()) with check (public.is_owner());
-- note: the permissive select above still applies for employees (select only)

-- ---------------------------------------------------------------------------
-- Reference data readable by any signed-in user (no costs here):
-- product_categories, engine_models, part_fitments
-- ---------------------------------------------------------------------------
drop policy if exists categories_select on public.product_categories;
create policy categories_select on public.product_categories for select
  to authenticated using (true);
drop policy if exists categories_write on public.product_categories;
create policy categories_write on public.product_categories for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists engine_models_select on public.engine_models;
create policy engine_models_select on public.engine_models for select
  to authenticated using (true);
drop policy if exists engine_models_write on public.engine_models;
create policy engine_models_write on public.engine_models for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists part_fitments_select on public.part_fitments;
create policy part_fitments_select on public.part_fitments for select
  to authenticated using (true);
drop policy if exists part_fitments_write on public.part_fitments;
create policy part_fitments_write on public.part_fitments for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

-- ---------------------------------------------------------------------------
-- Owner-only tables (employees reach shop stock ONLY via the safe views):
-- suppliers, parts, engines, stock_levels, receivings(+lines),
-- deliveries(+lines), returns(+lines), stock_movements, warranties(+claims),
-- count snapshots(+lines), settings
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'suppliers','parts','engines','stock_levels','receivings','receiving_lines',
    'deliveries','delivery_lines','returns','return_lines','warranties',
    'warranty_claims','count_snapshots','count_snapshot_lines','settings'
  ] loop
    execute format('drop policy if exists %I_owner_all on public.%I;', t, t);
    execute format(
      'create policy %I_owner_all on public.%I for all
       to authenticated using (public.is_owner()) with check (public.is_owner());',
      t, t);
  end loop;
end $$;

-- stock_movements: owner can read; NOBODY inserts directly (ledger is written
-- only by SECURITY DEFINER functions in later migrations)
drop policy if exists movements_owner_select on public.stock_movements;
create policy movements_owner_select on public.stock_movements for select
  to authenticated using (public.is_owner());

-- ---------------------------------------------------------------------------
-- customers: employees create/read customers (needed for engine sales);
-- only owner updates/deletes
-- ---------------------------------------------------------------------------
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select
  to authenticated using (true);

drop policy if exists customers_insert on public.customers;
create policy customers_insert on public.customers for insert
  to authenticated with check (true);

drop policy if exists customers_update on public.customers;
create policy customers_update on public.customers for update
  to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists customers_delete on public.customers;
create policy customers_delete on public.customers for delete
  to authenticated using (public.is_owner());

-- ---------------------------------------------------------------------------
-- sales: employee records PENDING sales for their own shop only
-- ---------------------------------------------------------------------------
drop policy if exists sales_select on public.sales;
create policy sales_select on public.sales for select
  to authenticated using (public.is_owner() or shop_id = public.auth_shop_id());

drop policy if exists sales_insert on public.sales;
create policy sales_insert on public.sales for insert
  to authenticated with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'pending')
  );

-- employee may edit/cancel their own sale ONLY while still pending;
-- they can never flip it to approved (status must stay pending/rejected-safe)
drop policy if exists sales_update on public.sales;
create policy sales_update on public.sales for update
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('pending','questioned'))
  ) with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'pending')
  );

drop policy if exists sales_delete on public.sales;
create policy sales_delete on public.sales for delete
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'pending')
  );

-- sale_lines follow their parent sale
drop policy if exists sale_lines_select on public.sale_lines;
create policy sale_lines_select on public.sale_lines for select
  to authenticated using (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner() or s.shop_id = public.auth_shop_id()))
  );

drop policy if exists sale_lines_insert on public.sale_lines;
create policy sale_lines_insert on public.sale_lines for insert
  to authenticated with check (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner()
                   or (s.shop_id = public.auth_shop_id()
                       and s.recorded_by = auth.uid()
                       and s.status = 'pending')))
  );

drop policy if exists sale_lines_update on public.sale_lines;
create policy sale_lines_update on public.sale_lines for update
  to authenticated using (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner()
                   or (s.shop_id = public.auth_shop_id()
                       and s.recorded_by = auth.uid()
                       and s.status = 'pending')))
  );

drop policy if exists sale_lines_delete on public.sale_lines;
create policy sale_lines_delete on public.sale_lines for delete
  to authenticated using (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner()
                   or (s.shop_id = public.auth_shop_id()
                       and s.recorded_by = auth.uid()
                       and s.status = 'pending')))
  );

-- ---------------------------------------------------------------------------
-- losses: same shape as sales
-- ---------------------------------------------------------------------------
drop policy if exists losses_select on public.losses;
create policy losses_select on public.losses for select
  to authenticated using (public.is_owner() or shop_id = public.auth_shop_id());

drop policy if exists losses_insert on public.losses;
create policy losses_insert on public.losses for insert
  to authenticated with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'pending')
  );

drop policy if exists losses_update on public.losses;
create policy losses_update on public.losses for update
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('pending','questioned'))
  ) with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'pending')
  );

drop policy if exists losses_delete on public.losses;
create policy losses_delete on public.losses for delete
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'pending')
  );

-- ---------------------------------------------------------------------------
-- Employee-safe views (SECURITY DEFINER: bypass base-table RLS but scope
-- rows themselves and EXCLUDE cost columns entirely)
-- ---------------------------------------------------------------------------

-- Parts stock at the caller's shop (owner sees all shops)
create or replace view public.shop_stock
with (security_barrier = true) as
select
  sl.shop_id,
  p.id as part_id,
  p.name,
  pc.name as category,
  p.sku,
  p.barcode,
  p.unit,
  p.price_centavos,      -- selling price only; cost is NOT exposed
  p.reorder_level,
  p.image_url,
  sl.qty
from public.stock_levels sl
join public.parts p on p.id = sl.part_id and p.deleted_at is null
left join public.product_categories pc on pc.id = p.category_id
where sl.shop_id is not null
  and (public.is_owner() or sl.shop_id = public.auth_shop_id());

-- Engines currently at the caller's shop (no cost column)
create or replace view public.shop_engines
with (security_barrier = true) as
select
  e.id as engine_id,
  e.serial_number,
  em.brand,
  em.model,
  em.horsepower,
  em.stroke,
  e.condition,
  e.price_centavos,      -- selling price only
  e.status,
  e.shop_id
from public.engines e
join public.engine_models em on em.id = e.engine_model_id
where e.deleted_at is null
  and e.status = 'delivered'
  and e.shop_id is not null
  and (public.is_owner() or e.shop_id = public.auth_shop_id());

revoke all on public.shop_stock from anon;
revoke all on public.shop_engines from anon;
grant select on public.shop_stock to authenticated;
grant select on public.shop_engines to authenticated;
