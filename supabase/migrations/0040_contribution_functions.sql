-- ============================================================================
-- 0040_contribution_functions.sql — compute + snapshot gov contributions.
--
-- net_pay = gross_pay - sum(employee shares). The employer share NEVER reduces
-- net; it is a cost of employing, tracked alongside.
--
-- ROUNDING RULE (explicit, because half-centavos are reachable):
--   * Percentages are applied in numeric and rounded HALF UP to whole centavos
--     (Postgres round() on numeric rounds half away from zero; amounts here are
--     never negative, so that is half-up).
--   * A semi-monthly `half_each` split gives the FIRST cutoff floor(total/2)
--     and the SECOND cutoff the remainder. The two halves therefore always sum
--     to exactly the monthly obligation — a stray centavo is never invented or
--     lost, which matters because the remittance total must tie out to the
--     agency's monthly figure.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- The monthly basis a contribution is computed from.
--
-- Deliberately NOT tied to days actually worked: contributions are a monthly
-- obligation from the staff member's RATE, so they don't swing with attendance.
-- A daily rate is annualised via settings.payroll_working_days_per_month.
-- ---------------------------------------------------------------------------
create or replace function public.fn_contribution_basis(
  p_pay_type public.pay_type,
  p_rate bigint
) returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_pay_type = 'monthly' then p_rate
    else p_rate * (select payroll_working_days_per_month from settings where id = 1)
  end;
$$;

-- ---------------------------------------------------------------------------
-- Resolve one agency's rule for a basis on a date, and return the MONTHLY
-- amounts. The (agency, date, salary) exclusion constraint guarantees at most
-- one matching row, so this cannot silently pick a winner.
-- ---------------------------------------------------------------------------
create or replace function public.fn_resolve_contribution(
  p_agency public.contribution_agency,
  p_basis_centavos bigint,
  p_on_date date
) returns table (
  bracket_id uuid,
  credited_salary_centavos bigint,
  ee_amount_centavos bigint,
  er_amount_centavos bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  b record;
  v_basis bigint;
begin
  select * into b
  from contribution_brackets
  where agency = p_agency
    and deleted_at is null
    and p_on_date >= effective_from
    and (effective_to is null or p_on_date <= effective_to)
    and p_basis_centavos >= salary_min_centavos
    and (salary_max_centavos is null or p_basis_centavos <= salary_max_centavos);

  if b is null then
    -- No row = no rule. Silently returning zero would under-remit, so say so.
    raise exception 'No % bracket covers a monthly basis of % centavos on %',
      p_agency, p_basis_centavos, p_on_date;
  end if;

  if b.basis = 'fixed' then
    bracket_id := b.id;
    credited_salary_centavos := null;
    ee_amount_centavos := coalesce(b.ee_amount_centavos, 0);
    er_amount_centavos := coalesce(b.er_amount_centavos, 0) + b.er_extra_centavos;
    return next;
    return;
  end if;

  if b.basis = 'msc_bracket' then
    -- SSS: the percents apply to the CREDITED salary (MSC), not actual pay.
    bracket_id := b.id;
    credited_salary_centavos := b.credited_salary_centavos;
    ee_amount_centavos := round(b.credited_salary_centavos * b.ee_percent / 100)::bigint;
    er_amount_centavos := round(b.credited_salary_centavos * b.er_percent / 100)::bigint
                          + b.er_extra_centavos;
    return next;
    return;
  end if;

  -- percent_of_salary: clamp the basis first (PhilHealth floor/ceiling,
  -- Pag-IBIG Maximum Fund Salary), then apply the percents.
  v_basis := p_basis_centavos;
  if b.basis_floor_centavos is not null and v_basis < b.basis_floor_centavos then
    v_basis := b.basis_floor_centavos;
  end if;
  if b.basis_ceiling_centavos is not null and v_basis > b.basis_ceiling_centavos then
    v_basis := b.basis_ceiling_centavos;
  end if;

  bracket_id := b.id;
  credited_salary_centavos := null;
  ee_amount_centavos := round(v_basis * b.ee_percent / 100)::bigint;
  er_amount_centavos := round(v_basis * b.er_percent / 100)::bigint + b.er_extra_centavos;
  return next;
end $$;

-- ---------------------------------------------------------------------------
-- Compute + snapshot every agency for one entry, then set net_pay.
--
-- Called whenever an entry's gross is (re)computed. Rewrites this entry's
-- snapshot rows — which is correct while the period is open, and impossible
-- once it is finalized/paid because the callers refuse to touch those.
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
        -- whole obligation lands on the 2nd cutoff
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

    insert into payroll_entry_contributions (
      payroll_entry_id, agency, bracket_id,
      salary_basis_centavos, credited_salary_centavos,
      ee_amount_centavos, er_amount_centavos
    ) values (
      p_entry_id, v_agency, r.bracket_id,
      v_basis, r.credited_salary_centavos,
      v_ee, v_er
    );

    v_total_ee := v_total_ee + v_ee;
  end loop;

  update payroll_entries
  set net_pay = gross_pay - v_total_ee
  where id = p_entry_id;
end $$;

revoke all on function public.fn_apply_entry_contributions(uuid) from public, anon;
grant execute on function public.fn_apply_entry_contributions(uuid) to authenticated;
revoke all on function public.fn_resolve_contribution(public.contribution_agency, bigint, date) from public, anon;
grant execute on function public.fn_resolve_contribution(public.contribution_agency, bigint, date) to authenticated;
revoke all on function public.fn_contribution_basis(public.pay_type, bigint) from public, anon;
grant execute on function public.fn_contribution_basis(public.pay_type, bigint) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_create_pay_period — draft entries now carry contributions from the start.
-- Body identical to 0012 except the closing loop.
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
  e record;
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

  -- Contributions come off the RATE, not days worked, so even a 0-day daily
  -- staffer's draft shows the deduction that is coming.
  for e in select id from payroll_entries where pay_period_id = v_period_id loop
    perform public.fn_apply_entry_contributions(e.id);
  end loop;

  return v_period_id;
end $$;

revoke all on function public.fn_create_pay_period(text, date, date, public.pay_frequency) from public, anon;
grant execute on function public.fn_create_pay_period(text, date, date, public.pay_frequency) to authenticated;

-- ---------------------------------------------------------------------------
-- fn_save_payroll_days — recompute gross, then re-apply contributions so net
-- follows. Body identical to 0012 except the final call.
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

    -- sets net_pay = gross - employee shares
    perform public.fn_apply_entry_contributions(r.entry_id);
  end loop;
end $$;

revoke all on function public.fn_save_payroll_days(uuid, jsonb) from public, anon;
grant execute on function public.fn_save_payroll_days(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Remittance totals per agency for a period — what the owner hands each agency.
-- ---------------------------------------------------------------------------
create or replace function public.fn_remittance_totals(p_period_id uuid)
returns table (
  agency public.contribution_agency,
  staff_count bigint,
  ee_total_centavos bigint,
  er_total_centavos bigint,
  total_centavos bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.agency,
    count(*)::bigint,
    coalesce(sum(c.ee_amount_centavos), 0)::bigint,
    coalesce(sum(c.er_amount_centavos), 0)::bigint,
    coalesce(sum(c.ee_amount_centavos + c.er_amount_centavos), 0)::bigint
  from payroll_entry_contributions c
  join payroll_entries e on e.id = c.payroll_entry_id
  where e.pay_period_id = p_period_id
    and public.is_owner()
  group by c.agency
  order by c.agency;
$$;

revoke all on function public.fn_remittance_totals(uuid) from public, anon;
grant execute on function public.fn_remittance_totals(uuid) to authenticated;
