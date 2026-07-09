-- ============================================================================
-- 0013_expenses.sql — Operating expenses (v1).
-- The OTHER cash going out: fuel, truck, pakyaw/delivery labor, utilities,
-- rent, permits, supplies, repairs, misc. NOT stock cost (receiving), NOT
-- wages (payroll), NOT nasira (losses). Owner-only.
-- ============================================================================

do $$ begin
  create type public.expense_scope as enum ('shop','company');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payment_method as enum ('cash','gcash','bank','other');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  active boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.expense_categories(id),
  amount bigint not null check (amount > 0),
  expense_date date not null default public.ph_today(),
  scope public.expense_scope not null default 'shop',
  shop_id uuid references public.shops(id),
  delivery_id uuid references public.deliveries(id),  -- optional: gas/pakyaw for a run
  description text not null,
  paid_to text,
  payment_method public.payment_method default 'cash',
  reference_no text,
  receipt_image_path text,       -- object path in the PRIVATE `receipts` bucket
  recorded_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- shop-scoped needs a shop; company-wide must not have one
  constraint expense_scope_shop check (
    (scope = 'shop' and shop_id is not null)
    or (scope = 'company' and shop_id is null)
  )
);

do $$
declare t text;
begin
  foreach t in array array['expense_categories','expenses'] loop
    execute format(
      'drop trigger if exists set_updated_at on public.%I;
       create trigger set_updated_at before update on public.%I
       for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;

create index if not exists idx_expenses_date on public.expenses (expense_date);
create index if not exists idx_expenses_category on public.expenses (category_id);
create index if not exists idx_expenses_shop on public.expenses (shop_id);
create index if not exists idx_expenses_delivery on public.expenses (delivery_id);

-- ---------------------------------------------------------------------------
-- RLS: owner-only (employees read/write nothing)
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['expense_categories','expenses'] loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('revoke all on public.%I from anon;', t);
    execute format('drop policy if exists %I_owner_all on public.%I;', t, t);
    execute format(
      'create policy %I_owner_all on public.%I for all
       to authenticated using (public.is_owner()) with check (public.is_owner());',
      t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- PRIVATE receipts bucket — owner-only read AND write (unlike product-images)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('receipts', 'receipts', false)
on conflict (id) do update set public = false;

drop policy if exists "receipts owner insert" on storage.objects;
create policy "receipts owner insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_owner());

drop policy if exists "receipts owner update" on storage.objects;
create policy "receipts owner update" on storage.objects
  for update to authenticated
  using (bucket_id = 'receipts' and public.is_owner())
  with check (bucket_id = 'receipts' and public.is_owner());

drop policy if exists "receipts owner delete" on storage.objects;
create policy "receipts owner delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'receipts' and public.is_owner());

drop policy if exists "receipts owner select" on storage.objects;
create policy "receipts owner select" on storage.objects
  for select to authenticated
  using (bucket_id = 'receipts' and public.is_owner());

-- ---------------------------------------------------------------------------
-- Seed: Jerry's real-world buckets (idempotent)
-- ---------------------------------------------------------------------------
insert into public.expense_categories (id, name, sort_order) values
  ('c0000000-0000-4000-8000-000000000001', 'Delivery Fuel/Gas', 10),
  ('c0000000-0000-4000-8000-000000000002', 'Truck/Vehicle', 20),
  ('c0000000-0000-4000-8000-000000000003', 'Delivery Labor/Pakyaw', 30),
  ('c0000000-0000-4000-8000-000000000004', 'Transportation/Freight', 40),
  ('c0000000-0000-4000-8000-000000000005', 'Utilities', 50),
  ('c0000000-0000-4000-8000-000000000006', 'Rent', 60),
  ('c0000000-0000-4000-8000-000000000007', 'Permits & Fees', 70),
  ('c0000000-0000-4000-8000-000000000008', 'Shop Supplies', 80),
  ('c0000000-0000-4000-8000-000000000009', 'Repairs & Maintenance', 90),
  ('c0000000-0000-4000-8000-00000000000a', 'Communication', 100),
  ('c0000000-0000-4000-8000-00000000000b', 'Miscellaneous', 110)
on conflict (id) do nothing;
