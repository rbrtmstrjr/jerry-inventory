-- ============================================================================
-- 0033_supplier_payables.sql — accounts payable to suppliers.
--
-- Debt is created at RECEIVING (there is no purchase-order entity — the
-- printable purchase list is paper only). A receiving records what it cost and
-- what was paid; anything unpaid is debt to that supplier.
--
-- OWNER-ONLY throughout: this is Maccky's own dealing with his suppliers, so
-- there is deliberately NO approval pipeline here (that exists to police
-- employees). Employees get zero visibility into cost, debt, limits or
-- payments — every view below carries the `is_owner()` guard.
--
-- NOT AN EXPENSE: supplier payments are stock cost (COGS) and live here, never
-- in the Expenses module (fuel/labour/rent). Logging a supplier payment as an
-- expense would double-count it.
--
-- Balance is COMPUTED, never a mutable running total:
--     balance = total_amount − amount_paid(at receiving) − Σ(supplier_payments)
-- so the ledger and the receiving can never drift apart.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Supplier terms + limit
-- ---------------------------------------------------------------------------
alter table public.suppliers
  add column if not exists credit_limit bigint check (credit_limit is null or credit_limit >= 0),
  add column if not exists payment_terms_days int check (payment_terms_days is null or payment_terms_days >= 0),
  add column if not exists terms_note text;

comment on column public.suppliers.credit_limit is
  'Centavos. NULL = no limit. Warns + requires an override — never blocks.';

-- ---------------------------------------------------------------------------
-- 2. Receiving = the origin of the debt
-- ---------------------------------------------------------------------------
alter table public.receivings
  add column if not exists total_amount bigint not null default 0 check (total_amount >= 0),
  -- what was handed over AT receiving time; later payments live in the ledger
  add column if not exists amount_paid bigint not null default 0 check (amount_paid >= 0),
  add column if not exists payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid','partial','paid')),
  add column if not exists due_date date,
  add column if not exists settled_at timestamptz,
  -- audit trail for going over a credit limit
  add column if not exists limit_override boolean not null default false,
  add column if not exists limit_override_reason text,
  add column if not exists limit_override_by uuid references public.profiles(id),
  add column if not exists limit_override_at timestamptz;

create index if not exists idx_receivings_supplier_status
  on public.receivings (supplier_id, payment_status);
create index if not exists idx_receivings_due_date on public.receivings (due_date);

-- ---------------------------------------------------------------------------
-- 3. Payments ledger.
--    One real-world payment may be SPLIT across several receivings (FIFO), so
--    each row targets exactly one receiving and shares a payment_group_id with
--    its siblings. That keeps balance math a trivial sum-by-receiving while
--    the UI can still show "one ₱50k payment across 3 receivings".
-- ---------------------------------------------------------------------------
create table if not exists public.supplier_payments (
  id uuid primary key default gen_random_uuid(),
  payment_group_id uuid not null default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  receiving_id uuid references public.receivings(id),
  amount bigint not null check (amount > 0),
  paid_at date not null default public.ph_today(),
  method text not null default 'cash'
    check (method in ('cash','bank','gcash','check','other')),
  reference_no text,
  note text,
  receipt_image_path text,          -- object path in the PRIVATE `receipts` bucket
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_supplier_payments_supplier on public.supplier_payments (supplier_id);
create index if not exists idx_supplier_payments_receiving on public.supplier_payments (receiving_id);
create index if not exists idx_supplier_payments_group on public.supplier_payments (payment_group_id);

drop trigger if exists set_updated_at on public.supplier_payments;
create trigger set_updated_at before update on public.supplier_payments
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4. Settings: the "getting close to the limit" threshold
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists supplier_limit_warn_pct int not null default 80
    check (supplier_limit_warn_pct between 1 and 100);

-- ---------------------------------------------------------------------------
-- 5. BACKFILL — receivings that pre-date this feature.
--
-- We have no payment data for them. Marking them 'unpaid' would invent debt
-- that may not exist (₱1M+ across the existing rows) and would immediately
-- fire overdue alerts; marking them settled starts payables tracking cleanly
-- from today. The owner can record any genuinely-unpaid one by hand.
-- Only ever touches rows that were never given payment data.
-- ---------------------------------------------------------------------------
with t as (
  select r.id, coalesce(sum(rl.qty * rl.unit_cost_centavos), 0) as total
  from public.receivings r
  left join public.receiving_lines rl on rl.receiving_id = r.id
  where r.total_amount = 0 and r.amount_paid = 0 and r.settled_at is null
  group by r.id
)
update public.receivings r
set total_amount   = t.total,
    amount_paid    = t.total,
    payment_status = 'paid',
    settled_at     = r.received_at
from t
where t.id = r.id;

-- ---------------------------------------------------------------------------
-- 6. Balances. Computed from the ledger — single source of truth.
-- ---------------------------------------------------------------------------
create or replace function public.fn_receiving_balance(p_receiving_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select r.total_amount
       - coalesce(r.amount_paid, 0)
       - coalesce((
           select sum(sp.amount) from supplier_payments sp
           where sp.receiving_id = r.id and sp.deleted_at is null
         ), 0)
  from receivings r
  where r.id = p_receiving_id and r.deleted_at is null;
$$;

revoke all on function public.fn_receiving_balance(uuid) from public, anon;
grant execute on function public.fn_receiving_balance(uuid) to authenticated;

-- Per-receiving open balance — powers the supplier detail view and the FIFO
-- allocation. Owner-only.
drop view if exists public.supplier_payables;
drop view if exists public.receiving_balances;

create view public.receiving_balances
with (security_barrier = true) as
select
  r.id                                   as receiving_id,
  r.supplier_id,
  s.name                                 as supplier_name,
  r.received_at,
  r.due_date,
  r.note,
  r.total_amount,
  r.amount_paid,
  coalesce(p.paid_since, 0)              as paid_since,
  (r.total_amount - r.amount_paid - coalesce(p.paid_since, 0)) as balance,
  r.payment_status,
  r.settled_at,
  r.limit_override,
  r.limit_override_reason,
  (r.due_date is not null
   and r.due_date < public.ph_today()
   and (r.total_amount - r.amount_paid - coalesce(p.paid_since, 0)) > 0) as overdue,
  case when r.due_date is null then null
       else (public.ph_today() - r.due_date) end as days_overdue
from public.receivings r
left join public.suppliers s on s.id = r.supplier_id
left join lateral (
  select sum(sp.amount) as paid_since
  from public.supplier_payments sp
  where sp.receiving_id = r.id and sp.deleted_at is null
) p on true
where r.deleted_at is null
  and public.is_owner();

-- Per-supplier rollup: what's owed, how overdue, and how close to the limit.
create view public.supplier_payables
with (security_barrier = true) as
select
  s.id                                as supplier_id,
  s.name                              as supplier_name,
  s.contact,
  s.credit_limit,
  s.payment_terms_days,
  s.terms_note,
  coalesce(o.outstanding, 0)          as outstanding,
  coalesce(o.open_count, 0)::int      as open_count,
  o.oldest_due_date,
  coalesce(o.overdue_amount, 0)       as overdue_amount,
  coalesce(o.overdue_count, 0)::int   as overdue_count,
  case
    when s.credit_limit is null or s.credit_limit = 0 then null
    else round(coalesce(o.outstanding, 0)::numeric * 100 / s.credit_limit, 1)
  end                                 as utilization_pct
from public.suppliers s
left join lateral (
  select
    sum(rb.balance)                                             as outstanding,
    count(*)                                                    as open_count,
    min(rb.due_date)                                            as oldest_due_date,
    sum(case when rb.overdue then rb.balance else 0 end)        as overdue_amount,
    count(*) filter (where rb.overdue)                          as overdue_count
  from public.receiving_balances rb
  where rb.supplier_id = s.id and rb.balance > 0
) o on true
where s.deleted_at is null
  and public.is_owner();

revoke all on public.receiving_balances from anon;
revoke all on public.supplier_payables from anon;
grant select on public.receiving_balances to authenticated;
grant select on public.supplier_payables to authenticated;

-- ---------------------------------------------------------------------------
-- 7. RLS — the ledger is owner-only, full stop.
-- ---------------------------------------------------------------------------
alter table public.supplier_payments enable row level security;

drop policy if exists supplier_payments_owner_all on public.supplier_payments;
create policy supplier_payments_owner_all on public.supplier_payments for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

-- ---------------------------------------------------------------------------
-- 8. Notification types
-- ---------------------------------------------------------------------------
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check check (type in (
  'master_low_stock','shop_low_stock','delivery_request',
  'delivery_request_fulfilled','delivery_request_dismissed',
  'utang_payment','utang_payment_voided',
  'delivery_incoming','delivery_confirmed','delivery_discrepancy',
  'warranty_expiring',
  'supplier_limit_warning','supplier_limit_reached','supplier_payment_overdue'
));
