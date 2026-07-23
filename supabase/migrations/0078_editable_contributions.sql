-- ---------------------------------------------------------------------------
-- 0078 — editable government-contribution amounts (probationary staff).
--
-- Philippine practice: a new hire on 6-month probation is often not yet
-- remitted to SSS / PhilHealth / Pag-IBIG. The three employee-share fields were
-- auto-computed from the rate book and LOCKED; the owner needs to override them
-- per payslip (typically to ₱0 during probation), for ENROLLED staff only.
--
-- The override lives on the ENTRY, not the snapshot, so it SURVIVES a later
-- "Save days" (which re-runs fn_apply_entry_contributions and would otherwise
-- recompute the amount straight from the book). Rates stay data; this only
-- overrides the frozen per-entry amount, exactly like the amounts were already
-- a frozen per-entry snapshot.
-- ---------------------------------------------------------------------------

-- Per-agency employee-share override, e.g. {"sss": 0, "philhealth": 0}. NULL /
-- a missing agency key = use the computed amount. Centavos.
alter table public.payroll_entries
  add column if not exists contribution_override jsonb;

-- ---------------------------------------------------------------------------
-- Net writer — apply the per-agency override on top of the computed employee
-- share (supersedes 0071). Everything else is byte-identical: enrolment gate,
-- semi-monthly split, the gross-vs-withholding guard, the vale cap, net = gross
-- − Σee − vale. With no override (column NULL) behaviour is exactly 0071.
--
-- Still transitively guarded via fn_contribution_basis (test-definer-guards
-- whitelist) — it is not directly callable in a way that leaks anything.
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
begin
  select * into v_entry from payroll_entries where id = p_entry_id;
  if v_entry is null then raise exception 'Entry not found'; end if;

  select * into v_period from pay_periods where id = v_entry.pay_period_id;
  select * into v_staff from staff where id = v_entry.staff_id;
  v_override := coalesce(v_entry.contribution_override, '{}'::jsonb);

  delete from payroll_entry_contributions where payroll_entry_id = p_entry_id;

  -- Contributions apply only to an enrolled staffer, on a monthly/semi-monthly
  -- period, with something earned. Weekly has no defined split; casual helpers
  -- (contributions_enabled=false) carry none; zero gross withholds nothing.
  v_enrolled := coalesce(v_staff.contributions_enabled, true)
                and v_period.frequency <> 'weekly'
                and coalesce(v_entry.gross_pay, 0) > 0;

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
        if v_split = 'second_cutoff' then
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
        'Cannot withhold % from %: their gross for this period is only %. Enter their days worked, lower the contribution amounts, or turn off contributions for this staff member.',
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
  -- v_total_ee stays 0 for not-enrolled / weekly / zero-gross.

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
-- Owner sets the three employee-share amounts for one payslip. p_amounts is a
-- {agency: centavos} object; a present agency is overridden, an absent one
-- reverts to the computed amount. Enrolled + unpaid + unlocked only.
-- ---------------------------------------------------------------------------
create or replace function public.fn_save_entry_contributions(
  p_entry_id uuid,
  p_amounts jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry record;
  v_period record;
  v_staff record;
  v_override jsonb := '{}'::jsonb;
  v_agency text;
  v_val bigint;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can edit contributions';
  end if;

  select * into v_entry from payroll_entries where id = p_entry_id;
  if v_entry is null then raise exception 'Entry not found'; end if;
  if v_entry.status = 'paid' then
    raise exception 'This payslip is already paid — reopen it first';
  end if;

  select * into v_period from pay_periods where id = v_entry.pay_period_id;
  if v_period.status = 'finalized' then
    raise exception 'This pay period is finalized — reopen it first';
  end if;

  select * into v_staff from staff where id = v_entry.staff_id;
  -- Only enrolled staff have benefits to edit (probationary/not-enrolled: none).
  if not (coalesce(v_staff.contributions_enabled, true)
          and v_period.frequency <> 'weekly'
          and coalesce(v_entry.gross_pay, 0) > 0) then
    raise exception 'This staffer has no contributions to edit for this period';
  end if;

  foreach v_agency in array array['sss','philhealth','pagibig']
  loop
    if p_amounts ? v_agency then
      v_val := (p_amounts ->> v_agency)::bigint;
      if v_val < 0 then
        raise exception 'Contribution amounts cannot be negative';
      end if;
      v_override := v_override || jsonb_build_object(v_agency, v_val);
    end if;
  end loop;

  update payroll_entries
  set contribution_override = nullif(v_override, '{}'::jsonb)
  where id = p_entry_id;

  perform public.fn_apply_entry_contributions(p_entry_id);
end $$;
revoke all on function public.fn_save_entry_contributions(uuid, jsonb) from public, anon;
grant execute on function public.fn_save_entry_contributions(uuid, jsonb) to authenticated;
