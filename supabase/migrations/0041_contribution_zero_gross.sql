-- ============================================================================
-- 0041_contribution_zero_gross.sql — you cannot withhold from pay that isn't
-- there.
--
-- 0040 deducted contributions from every enrolled entry regardless of gross.
-- `payroll_entries` has CHECK (net_pay >= 0), and fn_create_pay_period drafts
-- DAILY staff at 0 days -> gross 0 -> net would be -1,582.50 -> the check fires
-- and creating ANY period containing a daily-rate staffer fails outright.
--
-- Two rules, chosen to avoid inventing policy:
--
--   gross = 0  -> no contributions at all, no snapshot rows.
--     Nothing was earned, so nothing is withheld. This is also the normal draft
--     state of a daily staffer before the owner types their days in.
--
--   0 < gross < total employee share -> RAISE, naming the person and amounts.
--     Silently withholding someone's entire pay (net 0), or quietly withholding
--     less than the agency expects, are both decisions with legal weight that
--     payroll software should not make on the owner's behalf. Stopping forces a
--     deliberate choice: fix the days, or turn off contributions for that
--     staffer. Enrolled staff earning less per month than their own
--     contribution is not a normal case — casual helpers belong on
--     contributions_enabled = false.
--
-- The contribution BASIS is still the rate (never days worked), so a full
-- month's deduction does not swing with attendance. This only governs whether
-- there is anything to withhold from at all.
-- ============================================================================

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
begin
  select * into v_entry from payroll_entries where id = p_entry_id;
  if v_entry is null then raise exception 'Entry not found'; end if;

  select * into v_period from pay_periods where id = v_entry.pay_period_id;
  select * into v_staff from staff where id = v_entry.staff_id;

  delete from payroll_entry_contributions where payroll_entry_id = p_entry_id;

  -- Not enrolled (casual helpers) -> no contributions at all, net = gross.
  if not coalesce(v_staff.contributions_enabled, true) then
    update payroll_entries set net_pay = gross_pay where id = p_entry_id;
    return;
  end if;

  -- Weekly periods are out of scope: a contribution is a MONTHLY obligation and
  -- the agencies define no weekly split. Rather than invent one, weekly periods
  -- carry no contributions — run monthly or semi-monthly to remit.
  if v_period.frequency = 'weekly' then
    update payroll_entries set net_pay = gross_pay where id = p_entry_id;
    return;
  end if;

  -- Nothing earned -> nothing to withhold. Also the normal draft state of a
  -- daily staffer before their days are entered.
  if coalesce(v_entry.gross_pay, 0) = 0 then
    update payroll_entries set net_pay = 0 where id = p_entry_id;
    return;
  end if;

  v_basis := public.fn_contribution_basis(v_staff.pay_type, v_staff.pay_rate);

  select contribution_split_semimonthly into v_split from settings where id = 1;
  -- PH convention: 1st cutoff covers days 1-15, 2nd covers 16-EOM.
  v_is_second := v_period.frequency = 'semi_monthly'
                 and extract(day from v_period.start_date) > 15;

  foreach v_agency in array array['sss','philhealth','pagibig']::public.contribution_agency[]
  loop
    select * into r from public.fn_resolve_contribution(v_agency, v_basis, v_period.start_date);

    v_ee := r.ee_amount_centavos;
    v_er := r.er_amount_centavos;

    if v_period.frequency = 'semi_monthly' then
      if v_split = 'second_cutoff' then
        if not v_is_second then
          v_ee := 0;
          v_er := 0;
        end if;
      else
        -- half_each: 1st takes the floor, 2nd takes the remainder, so the two
        -- always sum to the monthly amount exactly.
        if v_is_second then
          v_ee := v_ee - (v_ee / 2);
          v_er := v_er - (v_er / 2);
        else
          v_ee := v_ee / 2;
          v_er := v_er / 2;
        end if;
      end if;
    end if;

    v_total_ee := v_total_ee + v_ee;
    v_rows := v_rows || jsonb_build_object(
      'agency', v_agency,
      'bracket_id', r.bracket_id,
      'credited', r.credited_salary_centavos,
      'ee', v_ee,
      'er', v_er
    );
  end loop;

  -- Refuse to decide something this consequential on the owner's behalf.
  if v_total_ee > v_entry.gross_pay then
    raise exception
      'Cannot withhold % from %: their gross for this period is only %. Enter their days worked, or turn off contributions for this staff member.',
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

  update payroll_entries
  set net_pay = gross_pay - v_total_ee
  where id = p_entry_id;
end $$;

revoke all on function public.fn_apply_entry_contributions(uuid) from public, anon;
grant execute on function public.fn_apply_entry_contributions(uuid) to authenticated;
