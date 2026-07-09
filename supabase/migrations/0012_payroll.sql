-- ============================================================================
-- 0012_payroll.sql — Simple payroll (v1): staff, positions, pay periods,
-- payroll entries. Internal pay tracker — NO overtime/benefits/contributions
-- (schema leaves room; net_pay exists so future deductions slot in).
-- Payroll staff are their OWN records — a paid worker may have no app login.
-- ALL payroll tables are OWNER-ONLY.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
do $$ begin
  create type public.pay_type as enum ('daily','monthly');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.pay_frequency as enum ('weekly','semi_monthly','monthly');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.pay_period_status as enum ('open','finalized');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.payroll_entry_status as enum ('draft','approved','paid');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid references public.shops(id),   -- null = global/shared
  title text not null,
  default_pay_rate bigint check (default_pay_rate is null or default_pay_rate >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id),
  full_name text not null,
  position_id uuid references public.positions(id),
  pay_type public.pay_type not null default 'daily',
  pay_rate bigint not null default 0 check (pay_rate >= 0),  -- daily rate OR monthly salary
  date_hired date,
  active boolean not null default true,
  user_id uuid references public.profiles(id),  -- optional link to an app login
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.pay_periods (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  start_date date not null,
  end_date date not null,
  frequency public.pay_frequency not null default 'semi_monthly',
  status public.pay_period_status not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint pay_period_range check (end_date >= start_date)
);

create table if not exists public.payroll_entries (
  id uuid primary key default gen_random_uuid(),
  pay_period_id uuid not null references public.pay_periods(id) on delete cascade,
  staff_id uuid not null references public.staff(id),
  shop_id uuid not null references public.shops(id),  -- denormalized for reporting
  days_worked numeric(5,2) not null default 0 check (days_worked >= 0),
  gross_pay bigint not null default 0 check (gross_pay >= 0),
  net_pay bigint not null default 0 check (net_pay >= 0),  -- = gross in v1
  status public.payroll_entry_status not null default 'draft',
  date_paid date,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (pay_period_id, staff_id)
);

do $$
declare t text;
begin
  foreach t in array array['positions','staff','pay_periods','payroll_entries'] loop
    execute format(
      'drop trigger if exists set_updated_at on public.%I;
       create trigger set_updated_at before update on public.%I
       for each row execute function public.set_updated_at();', t, t);
  end loop;
end $$;

create index if not exists idx_staff_shop on public.staff (shop_id);
create index if not exists idx_payroll_entries_period on public.payroll_entries (pay_period_id);
create index if not exists idx_payroll_entries_shop on public.payroll_entries (shop_id);
create index if not exists idx_pay_periods_dates on public.pay_periods (start_date, end_date);

-- ---------------------------------------------------------------------------
-- RLS: payroll is OWNER-ONLY. Regular employees read nothing.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['positions','staff','pay_periods','payroll_entries'] loop
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
-- Proration rule (explicit + simple):
--   daily   → rate × days_worked
--   monthly → monthly:      full salary
--             semi_monthly: salary ÷ 2
--             weekly:       salary ÷ 4
-- ---------------------------------------------------------------------------
create or replace function public.fn_payroll_gross(
  p_pay_type public.pay_type,
  p_rate bigint,
  p_days numeric,
  p_frequency public.pay_frequency
) returns bigint
language sql immutable
as $$
  select case
    when p_pay_type = 'daily' then round(p_rate * p_days)::bigint
    when p_frequency = 'monthly' then p_rate
    when p_frequency = 'semi_monthly' then round(p_rate / 2.0)::bigint
    else round(p_rate / 4.0)::bigint
  end;
$$;

-- ---------------------------------------------------------------------------
-- Create a pay period and draft entries for every active staff member.
-- Monthly staff are pre-computed; daily staff start at 0 days.
-- ---------------------------------------------------------------------------
create or replace function public.fn_create_pay_period(
  p_label text,
  p_start date,
  p_end date,
  p_frequency public.pay_frequency
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_id uuid;
  v_count int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can run payroll';
  end if;
  if p_end < p_start then
    raise exception 'Period end must be on or after the start';
  end if;

  insert into pay_periods (label, start_date, end_date, frequency)
  values (p_label, p_start, p_end, p_frequency)
  returning id into v_period_id;

  insert into payroll_entries (pay_period_id, staff_id, shop_id, days_worked, gross_pay, net_pay)
  select
    v_period_id,
    s.id,
    s.shop_id,
    0,
    case when s.pay_type = 'monthly'
      then public.fn_payroll_gross(s.pay_type, s.pay_rate, 0, p_frequency)
      else 0 end,
    case when s.pay_type = 'monthly'
      then public.fn_payroll_gross(s.pay_type, s.pay_rate, 0, p_frequency)
      else 0 end
  from staff s
  where s.active and s.deleted_at is null;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    raise exception 'No active staff — add staff before running payroll';
  end if;

  return v_period_id;
end $$;

revoke all on function public.fn_create_pay_period(text, date, date, public.pay_frequency) from public, anon;
grant execute on function public.fn_create_pay_period(text, date, date, public.pay_frequency) to authenticated;

-- ---------------------------------------------------------------------------
-- Save days worked (daily staff) — recomputes gross. Blocked once finalized
-- or once an entry is paid.
--   p_lines: [{entry_id, days_worked}]
-- ---------------------------------------------------------------------------
create or replace function public.fn_save_payroll_days(
  p_period_id uuid,
  p_lines jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.pay_period_status;
  v_freq public.pay_frequency;
  r record;
  v_entry record;
  v_staff record;
  v_gross bigint;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can run payroll';
  end if;

  select status, frequency into v_status, v_freq
  from pay_periods where id = p_period_id and deleted_at is null;
  if v_status is null then raise exception 'Pay period not found'; end if;
  if v_status = 'finalized' then
    raise exception 'This period is finalized — reopen it to make changes';
  end if;

  for r in
    select * from jsonb_to_recordset(coalesce(p_lines, '[]'::jsonb))
      as x(entry_id uuid, days_worked numeric)
  loop
    if r.days_worked is null or r.days_worked < 0 then
      raise exception 'Days worked cannot be negative';
    end if;

    select * into v_entry from payroll_entries
    where id = r.entry_id and pay_period_id = p_period_id
    for update;
    if v_entry is null then
      raise exception 'Entry % does not belong to this period', r.entry_id;
    end if;
    if v_entry.status = 'paid' then
      continue; -- paid lines are immutable
    end if;

    select pay_type, pay_rate into v_staff from staff where id = v_entry.staff_id;
    v_gross := public.fn_payroll_gross(v_staff.pay_type, v_staff.pay_rate, r.days_worked, v_freq);

    update payroll_entries
    set days_worked = r.days_worked, gross_pay = v_gross, net_pay = v_gross
    where id = r.entry_id;
  end loop;
end $$;

revoke all on function public.fn_save_payroll_days(uuid, jsonb) from public, anon;
grant execute on function public.fn_save_payroll_days(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Approve all draft entries in a period (draft → approved)
-- ---------------------------------------------------------------------------
create or replace function public.fn_approve_pay_period(p_period_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.pay_period_status;
  v_count int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can run payroll';
  end if;
  select status into v_status from pay_periods where id = p_period_id and deleted_at is null;
  if v_status is null then raise exception 'Pay period not found'; end if;
  if v_status = 'finalized' then
    raise exception 'This period is finalized — reopen it to make changes';
  end if;

  update payroll_entries set status = 'approved'
  where pay_period_id = p_period_id and status = 'draft';
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.fn_approve_pay_period(uuid) from public, anon;
grant execute on function public.fn_approve_pay_period(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Mark entries paid (approved → paid, stamps date_paid). Pass '[]' + p_all
-- to pay every approved entry in the period.
-- ---------------------------------------------------------------------------
create or replace function public.fn_mark_payroll_paid(
  p_period_id uuid,
  p_entry_ids jsonb default '[]'::jsonb,
  p_all boolean default false
) returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.pay_period_status;
  v_count int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can run payroll';
  end if;
  select status into v_status from pay_periods where id = p_period_id and deleted_at is null;
  if v_status is null then raise exception 'Pay period not found'; end if;
  if v_status = 'finalized' then
    raise exception 'This period is finalized — reopen it to make changes';
  end if;

  if p_all then
    update payroll_entries
    set status = 'paid', date_paid = public.ph_today()
    where pay_period_id = p_period_id and status = 'approved';
  else
    update payroll_entries
    set status = 'paid', date_paid = public.ph_today()
    where pay_period_id = p_period_id
      and status = 'approved'
      and id in (select value::uuid from jsonb_array_elements_text(coalesce(p_entry_ids,'[]'::jsonb)));
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.fn_mark_payroll_paid(uuid, jsonb, boolean) from public, anon;
grant execute on function public.fn_mark_payroll_paid(uuid, jsonb, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Finalize (lock) / reopen a period
-- ---------------------------------------------------------------------------
create or replace function public.fn_set_pay_period_status(
  p_period_id uuid,
  p_finalize boolean
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Only the owner can run payroll';
  end if;
  update pay_periods
  set status = case when p_finalize then 'finalized'::public.pay_period_status
                    else 'open'::public.pay_period_status end
  where id = p_period_id and deleted_at is null;
  if not found then raise exception 'Pay period not found'; end if;
end $$;

revoke all on function public.fn_set_pay_period_status(uuid, boolean) from public, anon;
grant execute on function public.fn_set_pay_period_status(uuid, boolean) to authenticated;

-- ---------------------------------------------------------------------------
-- Seed: a few common global positions (idempotent)
-- ---------------------------------------------------------------------------
insert into public.positions (id, shop_id, title, default_pay_rate) values
  ('b0000000-0000-4000-8000-000000000001', null, 'Shop Attendant', 45000),
  ('b0000000-0000-4000-8000-000000000002', null, 'Cashier',        50000),
  ('b0000000-0000-4000-8000-000000000003', null, 'Mechanic',       60000)
on conflict (id) do nothing;
