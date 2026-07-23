-- ---------------------------------------------------------------------------
-- 0080 — per-pay-run "deduct government benefits?" choice.
--
-- Gerry pays twice a month (semi-monthly) but withholds SSS / PhilHealth /
-- Pag-IBIG only ONCE a month — on one of the two runs. The contribution is a
-- MONTHLY obligation, so the run that deducts carries the FULL monthly amount,
-- and the other run withholds nothing.
--
-- Until now the split was inferred from the period's start date + the global
-- contribution_split_semimonthly setting. This makes it an explicit per-period
-- choice instead, chosen when the run is created.
--
--   deduct_contributions IS NULL  → legacy behavior (date + split setting).
--                                    Every existing period stays NULL, so its
--                                    already-computed figures never move.
--   deduct_contributions = true   → this run withholds the FULL monthly benefit.
--   deduct_contributions = false  → this run withholds nothing.
--
-- Monthly runs (one a month) and weekly runs (never contribute) leave it NULL
-- and keep the exact behavior they had. The 0078 probation override still
-- layers on top of whatever amount this produces.
-- ---------------------------------------------------------------------------

alter table public.pay_periods
  add column if not exists deduct_contributions boolean;

-- ---------------------------------------------------------------------------
-- Net writer — honor the per-period deduction choice (supersedes 0078).
-- Only two lines of behavior change vs 0078:
--   • an explicit `false` run withholds nothing (enrolment gate),
--   • an explicit `true` run takes the FULL amount (no ÷2 half-split).
-- A NULL period is byte-identical to 0078 (legacy date/split logic).
-- Still transitively guarded via fn_contribution_basis (definer-guards
-- whitelist).
-- ---------------------------------------------------------------------------
create or replace function public.fn_apply_entry_contributions(p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry record;
  v_period record;
  v_staff record;
  v_basis bigint;
  v_split public.semimonthly_split;
  v_is_second boolean;
  v_agency public.contribution_agency;
  r record;
  v_ee bigint;
  v_er bigint;
  v_total_ee bigint := 0;
  v_rows jsonb := '[]'::jsonb;
  v_row jsonb;
  v_enrolled boolean;
  v_avail bigint;
  v_vale bigint;
  v_override jsonb;
  v_deduct boolean;
begin
  select * into v_entry from payroll_entries where id = p_entry_id;
  if v_entry is null then raise exception 'Entry not found'; end if;

  select * into v_period from pay_periods where id = v_entry.pay_period_id;
  select * into v_staff from staff where id = v_entry.staff_id;
  v_override := coalesce(v_entry.contribution_override, '{}'::jsonb);
  v_deduct := v_period.deduct_contributions;  -- NULL = legacy

  delete from payroll_entry_contributions where payroll_entry_id = p_entry_id;

  -- Contributions apply only to an enrolled staffer, on a monthly/semi-monthly
  -- period, with something earned — AND not on a run explicitly marked as not
  -- deducting. Weekly has no defined split; casual helpers
  -- (contributions_enabled=false) carry none; zero gross withholds nothing.
  v_enrolled := coalesce(v_staff.contributions_enabled, true)
                and v_period.frequency <> 'weekly'
                and coalesce(v_entry.gross_pay, 0) > 0
                and coalesce(v_deduct, true);

  if v_enrolled then
    v_basis := public.fn_contribution_basis(v_staff.pay_type, v_staff.pay_rate);
    select contribution_split_semimonthly into v_split from settings where id = 1;
    v_is_second := v_period.frequency = 'semi_monthly'
                   and extract(day from v_period.start_date) > 15;

    foreach v_agency in array array['sss','philhealth','pagibig']::public.contribution_agency[]
    loop
      select * into r from public.fn_resolve_contribution(v_agency, v_basis, v_period.start_date);
      v_ee := r.ee_amount_centavos;
      v_er := r.er_amount_centavos;

      if v_period.frequency = 'semi_monthly' then
        if v_deduct is not null then
          -- Explicit per-period choice: the deducting run (v_deduct=true) takes
          -- the FULL monthly obligation. A non-deducting run never gets here
          -- (v_enrolled is false above). No half-split.
          null;
        elsif v_split = 'second_cutoff' then
          if not v_is_second then v_ee := 0; v_er := 0; end if;
        else
          if v_is_second then
            v_ee := v_ee - (v_ee / 2);
            v_er := v_er - (v_er / 2);
          else
            v_ee := v_ee / 2;
            v_er := v_er / 2;
          end if;
        end if;
      end if;

      -- Owner override of the EMPLOYEE share for this agency (e.g. ₱0 during
      -- probation). The employer share stays computed.
      if v_override ? (v_agency::text) then
        v_ee := greatest(0, (v_override ->> (v_agency::text))::bigint);
      end if;

      v_total_ee := v_total_ee + v_ee;
      v_rows := v_rows || jsonb_build_object(
        'agency', v_agency, 'bracket_id', r.bracket_id,
        'credited', r.credited_salary_centavos, 'ee', v_ee, 'er', v_er
      );
    end loop;

    -- Refuse to decide something this consequential on the owner's behalf.
    if v_total_ee > v_entry.gross_pay then
      raise exception
        'Cannot withhold % from %: their gross for this period is only %. Enter their days worked, lower the contribution amounts, turn off this run''s deduction, or turn off contributions for this staff member.',
        (v_total_ee / 100.0)::money, v_staff.full_name, (v_entry.gross_pay / 100.0)::money
        using errcode = 'check_violation';
    end if;

    for v_row in select * from jsonb_array_elements(v_rows)
    loop
      insert into payroll_entry_contributions (
        payroll_entry_id, agency, bracket_id,
        salary_basis_centavos, credited_salary_centavos,
        ee_amount_centavos, er_amount_centavos
      ) values (
        p_entry_id,
        (v_row->>'agency')::public.contribution_agency,
        (v_row->>'bracket_id')::uuid,
        v_basis,
        nullif(v_row->>'credited', '')::bigint,
        (v_row->>'ee')::bigint,
        (v_row->>'er')::bigint
      );
    end loop;
  end if;
  -- v_total_ee stays 0 for not-enrolled / weekly / zero-gross / no-deduct run.

  -- Vale: cap to what net can bear (gross − ee); the rest carries on the ledger.
  v_avail := greatest(0, coalesce(v_entry.gross_pay, 0) - v_total_ee);
  v_vale := least(coalesce(v_entry.vale_centavos, 0), v_avail);

  update payroll_entries
  set vale_centavos = v_vale,
      net_pay = coalesce(gross_pay, 0) - v_total_ee - v_vale
  where id = p_entry_id;
end $$;
revoke all on function public.fn_apply_entry_contributions(uuid) from public, anon;
grant execute on function public.fn_apply_entry_contributions(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_create_pay_period — carry the per-run deduction choice. The 4-arg version
-- is DROPPED so the new 5-arg one (with a default) is unambiguous; body is
-- otherwise identical to 0040.
-- ---------------------------------------------------------------------------
drop function if exists public.fn_create_pay_period(text, date, date, public.pay_frequency);

create or replace function public.fn_create_pay_period(
  p_label text,
  p_start date,
  p_end date,
  p_frequency public.pay_frequency,
  p_deduct_contributions boolean default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_id uuid;
  v_count int;
  e record;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can run payroll';
  end if;
  if p_end < p_start then
    raise exception 'Period end must be on or after the start';
  end if;

  insert into pay_periods (label, start_date, end_date, frequency, deduct_contributions)
  values (p_label, p_start, p_end, p_frequency, p_deduct_contributions)
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

  -- Contributions come off the RATE, not days worked, so even a 0-day daily
  -- staffer's draft shows the deduction that is coming (or none, this run).
  for e in select id from payroll_entries where pay_period_id = v_period_id loop
    perform public.fn_apply_entry_contributions(e.id);
  end loop;

  return v_period_id;
end $$;

revoke all on function public.fn_create_pay_period(text, date, date, public.pay_frequency, boolean) from public, anon;
grant execute on function public.fn_create_pay_period(text, date, date, public.pay_frequency, boolean) to authenticated;
