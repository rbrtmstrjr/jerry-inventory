-- ============================================================================
-- 0042_contribution_owner_guards.sql — close a definer bypass.
--
-- fn_resolve_contribution and fn_contribution_basis are SECURITY DEFINER, which
-- means they run with the definer's rights and BYPASS RLS. Both were granted to
-- `authenticated` with no is_owner() check, so an employee could read the rate
-- book and the payroll settings straight through the RPC even though
-- contribution_brackets and settings are owner-only tables.
--
-- The rates themselves are published circulars, so this leaked little of value —
-- but a definer function without a role check is exactly the hole RLS exists to
-- close, and every other definer function here re-checks the caller. Caught by
-- test-payroll-contributions.mjs ("employee cannot even resolve a rate").
--
-- Nested calls are unaffected: fn_apply_entry_contributions is reached only from
-- fn_create_pay_period / fn_save_payroll_days, which already establish that the
-- caller is the owner, and auth.uid() carries through the definer chain.
-- ============================================================================

create or replace function public.fn_contribution_basis(
  p_pay_type public.pay_type,
  p_rate bigint
) returns bigint
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_days int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can read payroll settings';
  end if;

  if p_pay_type = 'monthly' then
    return p_rate;
  end if;

  select payroll_working_days_per_month into v_days from settings where id = 1;
  return p_rate * v_days;
end $$;

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
  if not public.is_owner() then
    raise exception 'Only the owner can resolve contribution rates';
  end if;

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

revoke all on function public.fn_contribution_basis(public.pay_type, bigint) from public, anon;
grant execute on function public.fn_contribution_basis(public.pay_type, bigint) to authenticated;
revoke all on function public.fn_resolve_contribution(public.contribution_agency, bigint, date) from public, anon;
grant execute on function public.fn_resolve_contribution(public.contribution_agency, bigint, date) to authenticated;
