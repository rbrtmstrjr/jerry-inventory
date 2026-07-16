-- ============================================================================
-- 0022_receivables.sql — Utang (receivables) tracking + payments ledger.
--
-- Partial-payment sales already store the at-sale split (amount_paid /
-- balance_due). This adds the money that comes in LATER:
--
--   utang_payments — append-only-ish ledger of balance payments. A payment
--   rides the SAME approval pipeline as a sale: employee records it
--   ('recorded', invisible to the owner) → joins the shop's submission batch
--   ('pending') → owner approves ('approved'). ONLY approved payments reduce
--   the balance, so an employee can't clear an utang and pocket the cash.
--
-- Balance is COMPUTED, never a mutable running total:
--   balance = total_centavos − amount_paid_centavos − Σ(approved payments)
-- sales.balance_due_centavos stays the immutable AT-SALE snapshot (it is what
-- the buyer's printed receipt says); `settled_at` marks when balance hits 0.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Sale gains a settled marker (convenience; balance itself is computed)
-- ---------------------------------------------------------------------------
alter table public.sales
  add column if not exists settled_at timestamptz;

-- ---------------------------------------------------------------------------
-- 2. The payments ledger
-- ---------------------------------------------------------------------------
create table if not exists public.utang_payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  customer_id uuid references public.customers(id),
  shop_id uuid not null references public.shops(id),
  amount_centavos bigint not null check (amount_centavos > 0),
  status public.submission_status not null default 'recorded',
  batch_id uuid references public.submission_batches(id),
  note text,
  owner_note text,                  -- owner's question / rejection reason
  business_date date not null default public.ph_today(),
  recorded_by uuid not null references public.profiles(id),
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_utang_payments_sale on public.utang_payments (sale_id);
create index if not exists idx_utang_payments_shop_status on public.utang_payments (shop_id, status);
create index if not exists idx_utang_payments_batch on public.utang_payments (batch_id);

drop trigger if exists set_updated_at on public.utang_payments;
create trigger set_updated_at before update on public.utang_payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3. RLS — shop sees/cancels its own; owner sees all. Writes go through the
--    SECURITY DEFINER functions (which re-check role + shop).
-- ---------------------------------------------------------------------------
alter table public.utang_payments enable row level security;

drop policy if exists utang_payments_select on public.utang_payments;
create policy utang_payments_select on public.utang_payments for select
  to authenticated using (
    public.is_owner() or shop_id = public.auth_shop_id()
  );

drop policy if exists utang_payments_owner_write on public.utang_payments;
create policy utang_payments_owner_write on public.utang_payments for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

-- employee may cancel their own not-yet-reviewed payment
drop policy if exists utang_payments_delete on public.utang_payments;
create policy utang_payments_delete on public.utang_payments for delete
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('recorded','pending'))
  );

-- ---------------------------------------------------------------------------
-- 4. receivables view — one row per partial sale, with the COMPUTED balance.
--    Scoped: owner sees every shop, employees only their own (security_barrier
--    + the same is_owner()/auth_shop_id() guard as shop_stock/shop_engines).
--    Rows are NOT filtered to balance > 0 so the owner can also review settled
--    history; callers filter `balance_centavos > 0` for open utang.
--    Selling/agreed prices only — no cost columns anywhere.
-- ---------------------------------------------------------------------------
create or replace view public.receivables
with (security_barrier = true) as
select
  s.id                                as sale_id,
  s.receipt_no,
  s.business_date,
  s.created_at,
  s.status                            as sale_status,
  s.shop_id,
  sh.name                             as shop_name,
  s.customer_id,
  c.name                              as customer_name,
  c.phone                             as customer_phone,
  s.total_centavos,
  s.amount_paid_centavos,
  coalesce(p.paid_since, 0)           as paid_since_centavos,
  s.amount_paid_centavos + coalesce(p.paid_since, 0) as total_paid_centavos,
  s.total_centavos - s.amount_paid_centavos - coalesce(p.paid_since, 0) as balance_centavos,
  s.settled_at,
  li.description
from public.sales s
join public.shops sh on sh.id = s.shop_id
left join public.customers c on c.id = s.customer_id
left join lateral (
  select sum(up.amount_centavos) as paid_since
  from public.utang_payments up
  where up.sale_id = s.id
    and up.status = 'approved'
    and up.deleted_at is null
) p on true
left join lateral (
  select string_agg(sl.description, ', ') as description
  from public.sale_lines sl
  where sl.sale_id = s.id
) li on true
where s.deleted_at is null
  and s.payment_type = 'partial'
  and s.status <> 'rejected'
  and (public.is_owner() or s.shop_id = public.auth_shop_id());

-- Shop-facing alias, mirroring the shop_stock / shop_engines naming. The base
-- view is already shop-scoped; this exists so shop code reads a "shop_" view.
create or replace view public.shop_receivables
with (security_barrier = true) as
select * from public.receivables;

revoke all on public.receivables from anon;
revoke all on public.shop_receivables from anon;
grant select on public.receivables to authenticated;
grant select on public.shop_receivables to authenticated;

-- ---------------------------------------------------------------------------
-- 5. Realtime: the owner's approval queue refreshes on payment changes too
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.utang_payments;
exception when duplicate_object then null; end $$;
