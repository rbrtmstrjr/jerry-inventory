-- ============================================================================
-- 0039_gov_contributions.sql — SSS / PhilHealth / Pag-IBIG contributions.
--
-- RATES ARE DATA, NOT CODE. Every rate, bracket, MSC, floor and ceiling lives
-- in `contribution_brackets`, effective-dated and owner-editable from Settings.
-- A new circular is a DATA EDIT, never a redeploy. Nothing in app code may
-- hardcode a percentage or a peso boundary.
--
-- SEEDS BELOW ARE EFFECTIVE-DATED AND WERE VERIFIED AGAINST OFFICIAL SOURCES IN
-- JULY 2026. They are a starting point, not a compliance guarantee — maintain
-- them via Settings → Contribution Rates when an agency issues a new circular.
--
--   SSS        RA 11199 / Circular 2024-006, effective 2025-01-01 (unchanged
--              for 2026). 15% of the MSC: 5% employee, 10% employer. MSC runs
--              P5,000..P35,000 in P500 steps (61 brackets). EC (employer-only)
--              is P10 below MSC 15,000 and P30 from MSC 15,000 up.
--              https://www.sss.gov.ph/sss-contribution-table/
--   PhilHealth RA 11223 (UHC). 5% premium — 2.5% employee / 2.5% employer —
--              on salary clamped to a P10,000 floor and P100,000 ceiling, so
--              P500 min and P5,000 max total. 5% confirmed for 2026.
--              https://pia.gov.ph/news/philhealth-sets-5-premium-contribution-rate-for-2026/
--   Pag-IBIG   RA 9679 / HDMF Circular No. 460, effective 2024-02-01 (current
--              in 2026). Maximum Fund Salary P10,000. At or below P1,500:
--              1% employee / 2% employer. Above P1,500: 2% / 2%. Max P200 each.
--
-- SCOPE: government contributions only. No tax, loans, advances, overtime,
-- holiday pay, 13th month or leave — net_pay = gross_pay - sum(employee share)
-- and nothing else.
-- ============================================================================

create extension if not exists btree_gist;

do $$ begin
  create type public.contribution_agency as enum ('sss','philhealth','pagibig');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.contribution_basis as enum ('msc_bracket','percent_of_salary','fixed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.semimonthly_split as enum ('half_each','second_cutoff');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- The rate book. One row = one agency's rule for one salary range over one
-- date range.
-- ---------------------------------------------------------------------------
create table if not exists public.contribution_brackets (
  id uuid primary key default gen_random_uuid(),
  agency public.contribution_agency not null,

  effective_from date not null,
  effective_to date,                      -- null = still current

  -- the MONTHLY basis range this row matches, in centavos
  salary_min_centavos bigint not null default 0 check (salary_min_centavos >= 0),
  salary_max_centavos bigint,             -- null = open-ended (top bracket)

  basis public.contribution_basis not null,

  -- SSS only: the Monthly Salary Credit for this bracket. When set, the
  -- percents below apply to THIS value, never to the actual salary. SSS is a
  -- bracket -> MSC lookup, not a percentage of pay.
  credited_salary_centavos bigint check (credited_salary_centavos is null or credited_salary_centavos >= 0),

  ee_percent numeric(6,3) not null default 0 check (ee_percent >= 0),
  er_percent numeric(6,3) not null default 0 check (er_percent >= 0),

  -- clamp the basis BEFORE applying the percents (PhilHealth floor/ceiling,
  -- Pag-IBIG Maximum Fund Salary)
  basis_floor_centavos bigint,
  basis_ceiling_centavos bigint,

  -- employer-only add-on that is not a percentage (SSS EC)
  er_extra_centavos bigint not null default 0 check (er_extra_centavos >= 0),

  -- for basis='fixed' (unused by the current seeds; kept for future circulars)
  ee_amount_centavos bigint,
  er_amount_centavos bigint,

  note text,
  source_ref text,                        -- e.g. 'SSS Circular 2024-006'

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  constraint bracket_date_range check (effective_to is null or effective_to >= effective_from),
  constraint bracket_salary_range check (salary_max_centavos is null or salary_max_centavos >= salary_min_centavos),
  constraint bracket_msc_only_for_sss check (credited_salary_centavos is null or basis = 'msc_bracket'),
  constraint bracket_fixed_has_amounts check (
    basis <> 'fixed' or (ee_amount_centavos is not null and er_amount_centavos is not null)
  ),
  constraint bracket_msc_has_credited check (
    basis <> 'msc_bracket' or credited_salary_centavos is not null
  )
);

comment on table public.contribution_brackets is
  'Government contribution rate book. Effective-dated and owner-editable — a new circular is a data edit, never a code change.';
comment on column public.contribution_brackets.credited_salary_centavos is
  'SSS MSC. When set, ee/er_percent apply to this value, NOT the actual salary.';

-- A given agency + date + monthly basis must resolve to EXACTLY ONE row, or
-- the computation is ambiguous. Enforced here, not in app code.
alter table public.contribution_brackets
  drop constraint if exists contribution_brackets_no_overlap;
alter table public.contribution_brackets
  add constraint contribution_brackets_no_overlap
  exclude using gist (
    agency with =,
    daterange(effective_from, effective_to, '[]') with &&,
    int8range(salary_min_centavos, salary_max_centavos, '[]') with &&
  ) where (deleted_at is null);

create index if not exists idx_brackets_lookup
  on public.contribution_brackets (agency, effective_from, salary_min_centavos)
  where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Staff: government IDs + enrollment.
-- Casual helpers who are not enrolled get contributions_enabled=false and
-- contribute nothing.
-- ---------------------------------------------------------------------------
alter table public.staff
  add column if not exists sss_no text,
  add column if not exists philhealth_no text,
  add column if not exists pagibig_no text,
  add column if not exists contributions_enabled boolean not null default true;

-- ---------------------------------------------------------------------------
-- Per-entry snapshot. Stores the COMPUTED amounts and the bracket used.
--
-- Never recomputed: editing the rate book next year must not silently rewrite
-- last year's payslips. Same principle as stored engine tier prices and the
-- at-sale balance snapshot.
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_entry_contributions (
  id uuid primary key default gen_random_uuid(),
  payroll_entry_id uuid not null references public.payroll_entries(id) on delete cascade,
  agency public.contribution_agency not null,
  bracket_id uuid references public.contribution_brackets(id),  -- audit: which row was used
  salary_basis_centavos bigint not null,
  credited_salary_centavos bigint,        -- the MSC used, for SSS
  ee_amount_centavos bigint not null default 0 check (ee_amount_centavos >= 0),
  er_amount_centavos bigint not null default 0 check (er_amount_centavos >= 0),
  created_at timestamptz not null default now(),
  unique (payroll_entry_id, agency)
);

create index if not exists idx_entry_contributions_entry
  on public.payroll_entry_contributions (payroll_entry_id);

comment on table public.payroll_entry_contributions is
  'Frozen per-entry contribution snapshot + the bracket it came from. Never recomputed for a past period.';

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------
alter table public.settings
  add column if not exists payroll_working_days_per_month int not null default 26
    check (payroll_working_days_per_month between 1 and 31),
  add column if not exists contribution_split_semimonthly public.semimonthly_split
    not null default 'half_each';

comment on column public.settings.payroll_working_days_per_month is
  'Derives a monthly contribution basis from a daily rate (rate x days). Independent of days actually worked.';

-- ---------------------------------------------------------------------------
-- RLS — owner-only, like the rest of payroll.
-- ---------------------------------------------------------------------------
alter table public.contribution_brackets enable row level security;
alter table public.payroll_entry_contributions enable row level security;

drop policy if exists contribution_brackets_all on public.contribution_brackets;
create policy contribution_brackets_all on public.contribution_brackets
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

drop policy if exists payroll_entry_contributions_all on public.payroll_entry_contributions;
create policy payroll_entry_contributions_all on public.payroll_entry_contributions
  for all to authenticated using (public.is_owner()) with check (public.is_owner());

do $$ begin
  execute 'drop trigger if exists set_updated_at on public.contribution_brackets';
  execute 'create trigger set_updated_at before update on public.contribution_brackets
           for each row execute function public.set_updated_at()';
end $$;

-- ============================================================================
-- SEEDS
-- ============================================================================

-- ---------------------------------------------------------------------------
-- SSS — 61 MSC brackets, P5,000..P35,000 in P500 steps.
--
-- The official table's Range of Compensation for MSC m is [m-250, m+250), with
-- the bottom row open below (P5,000: "BELOW 5,250") and the top row open above
-- (P35,000: "34,750 - OVER"). Verified against the published table at
-- sss.gov.ph: "BELOW 5,250"->5,000 · "5,250-5,749.99"->5,500 ·
-- "5,750-6,249.99"->6,000 · "18,250-18,749.99"->18,500 · "34,750-OVER"->35,000.
-- The spot-checks after this insert FAIL THE MIGRATION if the generated rows
-- ever drift from those published anchors.
--
-- Boundaries in centavos: the range ends one centavo below the next start, so
-- 5,749.99 is 574999 and the next row begins at 575000 — no gap, no overlap.
--
-- (MPF/WISP above MSC 20,000 is SSS's internal split of the same 15%; payroll
-- neither sees nor models it.)
-- ---------------------------------------------------------------------------
insert into public.contribution_brackets (
  agency, effective_from, effective_to,
  salary_min_centavos, salary_max_centavos,
  basis, credited_salary_centavos, ee_percent, er_percent, er_extra_centavos,
  note, source_ref
)
select
  'sss',
  date '2025-01-01',
  null,
  case when msc = 500000 then 0 else msc - 25000 end,             -- [m-250 ...
  case when msc = 3500000 then null else msc + 24999 end,         -- ... m+249.99]
  'msc_bracket',
  msc,
  5, 10,
  case when msc < 1500000 then 1000 else 3000 end,                -- EC: P10 / P30
  'MSC ' || (msc / 100)::text,
  'SSS Circular 2024-006 (RA 11199), effective 2025-01-01'
from generate_series(500000, 3500000, 50000) as msc
where not exists (
  select 1 from public.contribution_brackets
  where agency = 'sss' and effective_from = date '2025-01-01' and deleted_at is null
);

-- Fail loudly if the generated table does not match the published anchors.
do $$
declare
  v_count int;
  v_msc bigint;
begin
  select count(*) into v_count from public.contribution_brackets
  where agency = 'sss' and deleted_at is null;
  if v_count <> 61 then
    raise exception 'SSS seed: expected 61 brackets, got %', v_count;
  end if;

  -- "BELOW 5,250" -> MSC 5,000
  select credited_salary_centavos into v_msc from public.contribution_brackets
  where agency = 'sss' and deleted_at is null and 100000 between salary_min_centavos and coalesce(salary_max_centavos, 9223372036854775807);
  if v_msc <> 500000 then raise exception 'SSS seed: P1,000 should map to MSC 5,000, got %', v_msc; end if;

  -- "5,250 - 5,749.99" -> MSC 5,500
  select credited_salary_centavos into v_msc from public.contribution_brackets
  where agency = 'sss' and deleted_at is null and 525000 between salary_min_centavos and coalesce(salary_max_centavos, 9223372036854775807);
  if v_msc <> 550000 then raise exception 'SSS seed: P5,250 should map to MSC 5,500, got %', v_msc; end if;

  -- "18,250 - 18,749.99" -> MSC 18,500
  select credited_salary_centavos into v_msc from public.contribution_brackets
  where agency = 'sss' and deleted_at is null and 1830000 between salary_min_centavos and coalesce(salary_max_centavos, 9223372036854775807);
  if v_msc <> 1850000 then raise exception 'SSS seed: P18,300 should map to MSC 18,500, got %', v_msc; end if;

  -- "34,750 - OVER" -> MSC 35,000
  select credited_salary_centavos into v_msc from public.contribution_brackets
  where agency = 'sss' and deleted_at is null and 9900000 between salary_min_centavos and coalesce(salary_max_centavos, 9223372036854775807);
  if v_msc <> 3500000 then raise exception 'SSS seed: P99,000 should map to MSC 35,000, got %', v_msc; end if;
end $$;

-- ---------------------------------------------------------------------------
-- PhilHealth — one row. 5% split evenly, on salary clamped to P10,000..P100,000.
-- ---------------------------------------------------------------------------
insert into public.contribution_brackets (
  agency, effective_from, effective_to,
  salary_min_centavos, salary_max_centavos,
  basis, ee_percent, er_percent,
  basis_floor_centavos, basis_ceiling_centavos,
  note, source_ref
)
select
  'philhealth', date '2025-01-01', null,
  0, null,
  'percent_of_salary', 2.5, 2.5,
  1000000,    -- P10,000 floor  -> P250 / P250 minimum
  10000000,   -- P100,000 ceiling -> P2,500 / P2,500 maximum
  '5% premium, shared equally',
  'RA 11223 (UHC) — 5% rate confirmed for 2026'
where not exists (
  select 1 from public.contribution_brackets where agency = 'philhealth' and deleted_at is null
);

-- ---------------------------------------------------------------------------
-- Pag-IBIG — two rows, both capped at the P10,000 Maximum Fund Salary.
-- ---------------------------------------------------------------------------
insert into public.contribution_brackets (
  agency, effective_from, effective_to,
  salary_min_centavos, salary_max_centavos,
  basis, ee_percent, er_percent, basis_ceiling_centavos,
  note, source_ref
)
select * from (values
  ('pagibig'::public.contribution_agency, date '2024-02-01', null::date,
   0::bigint, 150000::bigint,
   'percent_of_salary'::public.contribution_basis, 1::numeric, 2::numeric, 1000000::bigint,
   'P1,500 and below', 'HDMF Circular No. 460 (RA 9679), effective 2024-02-01'),
  ('pagibig'::public.contribution_agency, date '2024-02-01', null::date,
   150001::bigint, null::bigint,
   'percent_of_salary'::public.contribution_basis, 2::numeric, 2::numeric, 1000000::bigint,
   'Above P1,500 — max P200 each at the P10,000 MFS', 'HDMF Circular No. 460 (RA 9679), effective 2024-02-01')
) as v(agency, effective_from, effective_to, salary_min_centavos, salary_max_centavos,
       basis, ee_percent, er_percent, basis_ceiling_centavos, note, source_ref)
where not exists (
  select 1 from public.contribution_brackets where agency = 'pagibig' and deleted_at is null
);
