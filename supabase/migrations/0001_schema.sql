-- ============================================================================
-- 0001_schema.sql — Jerry's Marine: core schema
-- Money is ALWAYS integer centavos (bigint). Quantities are int.
-- Every table: uuid id, created_at, updated_at, soft-delete (deleted_at).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums (idempotent)
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.user_role as enum ('owner','employee');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.engine_status as enum ('in_master','delivered','sold','returned');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.submission_status as enum ('pending','questioned','approved','rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  -- nasira = damaged, nawala = missing
  create type public.loss_reason as enum ('nasira','nawala','expired','sample','correction');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.movement_type as enum ('received','delivery','return','sale','loss','correction');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- Business date helper: "today" in the shops' timezone.
create or replace function public.ph_today()
returns date language sql stable as
$$ select (now() at time zone 'Asia/Manila')::date $$;

-- ---------------------------------------------------------------------------
-- Shops & people
-- ---------------------------------------------------------------------------
create table if not exists public.shops (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  location text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role public.user_role not null,
  shop_id uuid references public.shops(id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  -- owner has no shop; employee must belong to exactly one shop
  constraint profiles_role_shop check (
    (role = 'owner' and shop_id is null)
    or (role = 'employee' and shop_id is not null)
  )
);

-- ---------------------------------------------------------------------------
-- Catalog
-- ---------------------------------------------------------------------------
create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.product_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.engine_models (
  id uuid primary key default gen_random_uuid(),
  brand text not null,
  model text not null,
  horsepower numeric(5,1),
  stroke text check (stroke in ('2-stroke','4-stroke')),
  default_warranty_months int not null default 12,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (brand, model)
);

-- Quantity-tracked items: parts & fisherman goods
create table if not exists public.parts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category_id uuid references public.product_categories(id),
  sku text,
  barcode text unique,          -- manufacturer barcode OR generated internal Code128
  unit text not null default 'pc',
  cost_centavos bigint not null default 0 check (cost_centavos >= 0),
  price_centavos bigint not null default 0 check (price_centavos >= 0),
  reorder_level int not null default 0 check (reorder_level >= 0),
  image_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- part ↔ engine model compatibility ("this impeller fits Yamaha 40HP")
create table if not exists public.part_fitments (
  part_id uuid not null references public.parts(id) on delete cascade,
  engine_model_id uuid not null references public.engine_models(id) on delete cascade,
  primary key (part_id, engine_model_id)
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Serialized engines: each physical unit is its own row, never quantity-counted
create table if not exists public.engines (
  id uuid primary key default gen_random_uuid(),
  serial_number text not null unique,
  engine_model_id uuid not null references public.engine_models(id),
  condition text not null default 'brand_new' check (condition in ('brand_new','second_hand')),
  cost_centavos bigint not null default 0 check (cost_centavos >= 0),
  price_centavos bigint not null default 0 check (price_centavos >= 0),
  warranty_months int,          -- overrides model default when set
  status public.engine_status not null default 'in_master',
  shop_id uuid references public.shops(id),   -- current location when delivered
  customer_id uuid references public.customers(id),
  sold_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Stock (parts only; engines are tracked per-row)
-- shop_id NULL = Jerry's master stock
-- ---------------------------------------------------------------------------
create table if not exists public.stock_levels (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.parts(id) on delete cascade,
  shop_id uuid references public.shops(id),
  qty int not null default 0 check (qty >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (part_id, shop_id)
);

-- ---------------------------------------------------------------------------
-- Receiving from suppliers (into master)
-- ---------------------------------------------------------------------------
create table if not exists public.receivings (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers(id),
  received_at timestamptz not null default now(),
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.receiving_lines (
  id uuid primary key default gen_random_uuid(),
  receiving_id uuid not null references public.receivings(id) on delete cascade,
  part_id uuid references public.parts(id),
  engine_id uuid references public.engines(id),
  qty int not null check (qty > 0),
  unit_cost_centavos bigint not null default 0 check (unit_cost_centavos >= 0),
  created_at timestamptz not null default now(),
  constraint receiving_line_item check ((part_id is null) <> (engine_id is null)),
  constraint receiving_engine_qty check (engine_id is null or qty = 1)
);

-- ---------------------------------------------------------------------------
-- Deliveries (Jerry → shop, auto-lands) & Returns (shop → Jerry)
-- ---------------------------------------------------------------------------
create table if not exists public.deliveries (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id),
  delivered_at timestamptz not null default now(),
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.delivery_lines (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.deliveries(id) on delete cascade,
  part_id uuid references public.parts(id),
  engine_id uuid references public.engines(id),
  qty int not null check (qty > 0),
  created_at timestamptz not null default now(),
  constraint delivery_line_item check ((part_id is null) <> (engine_id is null)),
  constraint delivery_engine_qty check (engine_id is null or qty = 1)
);

create table if not exists public.returns (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id),
  returned_at timestamptz not null default now(),
  reason text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.return_lines (
  id uuid primary key default gen_random_uuid(),
  return_id uuid not null references public.returns(id) on delete cascade,
  part_id uuid references public.parts(id),
  engine_id uuid references public.engines(id),
  qty int not null check (qty > 0),
  created_at timestamptz not null default now(),
  constraint return_line_item check ((part_id is null) <> (engine_id is null)),
  constraint return_engine_qty check (engine_id is null or qty = 1)
);

-- ---------------------------------------------------------------------------
-- Shop submissions: sales & losses (PENDING until Jerry approves)
-- ---------------------------------------------------------------------------
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id),
  recorded_by uuid not null references public.profiles(id),
  customer_id uuid references public.customers(id),
  business_date date not null default public.ph_today(),
  status public.submission_status not null default 'pending',
  total_centavos bigint not null default 0 check (total_centavos >= 0),
  owner_note text,              -- Jerry's question / rejection reason
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  part_id uuid references public.parts(id),
  engine_id uuid references public.engines(id),
  qty int not null check (qty > 0),
  unit_price_centavos bigint not null check (unit_price_centavos >= 0),
  line_total_centavos bigint not null check (line_total_centavos >= 0),
  created_at timestamptz not null default now(),
  constraint sale_line_item check ((part_id is null) <> (engine_id is null)),
  constraint sale_engine_qty check (engine_id is null or qty = 1)
);

create table if not exists public.losses (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id),
  recorded_by uuid not null references public.profiles(id),
  part_id uuid references public.parts(id),
  engine_id uuid references public.engines(id),
  qty int not null check (qty > 0),
  reason public.loss_reason not null,
  note text,
  business_date date not null default public.ph_today(),
  status public.submission_status not null default 'pending',
  value_centavos bigint,        -- write-off value, set at approval (from cost)
  owner_note text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint loss_item check ((part_id is null) <> (engine_id is null)),
  constraint loss_engine_qty check (engine_id is null or qty = 1)
);

-- ---------------------------------------------------------------------------
-- Stock movements ledger (append-only source of truth)
-- One row per location affected; qty_change is signed.
-- shop_id NULL = master stock.
-- ---------------------------------------------------------------------------
create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  movement_type public.movement_type not null,
  part_id uuid references public.parts(id),
  engine_id uuid references public.engines(id),
  qty_change int not null,
  shop_id uuid references public.shops(id),
  actor uuid references public.profiles(id),
  sale_id uuid references public.sales(id),
  loss_id uuid references public.losses(id),
  delivery_id uuid references public.deliveries(id),
  return_id uuid references public.returns(id),
  receiving_id uuid references public.receivings(id),
  note text,
  created_at timestamptz not null default now(),
  constraint movement_item check ((part_id is null) <> (engine_id is null))
);

-- ---------------------------------------------------------------------------
-- Warranties (auto-created when an engine sale is approved)
-- ---------------------------------------------------------------------------
create table if not exists public.warranties (
  id uuid primary key default gen_random_uuid(),
  engine_id uuid not null unique references public.engines(id),
  sale_id uuid references public.sales(id),
  customer_id uuid not null references public.customers(id),
  sold_on date not null,
  months int not null,
  expires_on date not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.warranty_claims (
  id uuid primary key default gen_random_uuid(),
  warranty_id uuid not null references public.warranties(id) on delete cascade,
  claim_date date not null default public.ph_today(),
  issue text not null,
  action_taken text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Monthly physical count
-- ---------------------------------------------------------------------------
create table if not exists public.count_snapshots (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id),
  snapshot_date date not null default public.ph_today(),
  note text,
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.count_snapshot_lines (
  id uuid primary key default gen_random_uuid(),
  snapshot_id uuid not null references public.count_snapshots(id) on delete cascade,
  part_id uuid not null references public.parts(id),
  expected_qty int not null,
  counted_qty int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (snapshot_id, part_id)
);

-- ---------------------------------------------------------------------------
-- Settings (single row)
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  business_name text not null default 'Jerry''s Marine',
  address text,
  phone text,
  receipt_footer text,
  default_warranty_months int not null default 12,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'shops','profiles','suppliers','product_categories','engine_models','parts',
    'customers','engines','stock_levels','receivings','deliveries','returns',
    'sales','losses','warranties','warranty_claims','count_snapshots',
    'count_snapshot_lines','settings'
  ] loop
    execute format(
      'drop trigger if exists set_updated_at on public.%I;
       create trigger set_updated_at before update on public.%I
       for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Indexes for common lookups
-- ---------------------------------------------------------------------------
create index if not exists idx_parts_barcode on public.parts (barcode) where deleted_at is null;
create index if not exists idx_parts_category on public.parts (category_id);
create index if not exists idx_engines_status on public.engines (status);
create index if not exists idx_engines_shop on public.engines (shop_id);
create index if not exists idx_stock_levels_shop on public.stock_levels (shop_id);
create index if not exists idx_sales_shop_status on public.sales (shop_id, status);
create index if not exists idx_sales_business_date on public.sales (business_date);
create index if not exists idx_losses_shop_status on public.losses (shop_id, status);
create index if not exists idx_losses_business_date on public.losses (business_date);
create index if not exists idx_movements_created on public.stock_movements (created_at);
create index if not exists idx_movements_part on public.stock_movements (part_id);
create index if not exists idx_movements_engine on public.stock_movements (engine_id);
create index if not exists idx_warranties_expires on public.warranties (expires_on);
