-- 0071 — vale / cash-advance deduction on payroll (tracked ledger)
--
-- A staffer borrows cash from the business (a "vale") and repays it out of their
-- pay — separate from the government contributions. This is a TRACKED LEDGER:
-- record an advance → it builds a running balance the staffer owes → deduct an
-- installment each pay period until settled. An over-large deduction is CAPPED
-- to what's left of net pay (never a negative paycheck) and the remainder CARRIES
-- to the next period.
--
-- net_pay is written in exactly one place — fn_apply_entry_contributions (0041)
-- — so the vale is folded in there: net = gross − Σ ee − vale, with the vale
-- capped to (gross − Σ ee) so the `net_pay >= 0` CHECK (0012) can never fire.
-- The outstanding-balance cap is enforced at input time in fn_save_payroll_vale.

-- ── 1. the advance ledger ───────────────────────────────────────────────────
create table if not exists public.staff_advances (
  id uuid primary key default gen_random_uuid(),
  staff_id uuid not null references public.staff(id),
  shop_id uuid not null references public.shops(id),
  amount_centavos bigint not null check (amount_centavos > 0),
  note text,
  advance_date date not null default public.ph_today(),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists idx_staff_advances_staff on public.staff_advances (staff_id);

alter table public.staff_advances enable row level security;
revoke all on public.staff_advances from anon;
drop policy if exists staff_advances_owner_all on public.staff_advances;
create policy staff_advances_owner_all on public.staff_advances for all
  to authenticated using (public.is_owner()) with check (public.is_owner());

-- ── 2. the per-entry deduction (frozen on the entry) ───────────────────────
alter table public.payroll_entries
  add column if not exists vale_centavos bigint not null default 0
    check (vale_centavos >= 0);

-- ── 3. running balance per staffer (computed, never stored) ────────────────
-- balance = Σ advances − Σ vale deducted across all their payslips.
create or replace view public.staff_advance_balances
with (security_barrier = true) as
select
  s.id as staff_id, s.full_name, s.shop_id,
  coalesce(a.advanced, 0) as advanced,
  coalesce(d.deducted, 0) as deducted,
  coalesce(a.advanced, 0) - coalesce(d.deducted, 0) as balance
from public.staff s
left join (
  select staff_id, sum(amount_centavos) as advanced
  from public.staff_advances where deleted_at is null group by staff_id
) a on a.staff_id = s.id
left join (
  select staff_id, sum(vale_centavos) as deducted
  from public.payroll_entries group by staff_id
) d on d.staff_id = s.id
where s.deleted_at is null and public.is_owner();
revoke all on public.staff_advance_balances from anon;
grant select on public.staff_advance_balances to authenticated;

-- ── 4. net writer — fold the vale into every path (supersedes 0041) ────────
-- Unchanged contribution rules (not-enrolled / weekly / zero-gross / the
-- gross-vs-withholding guard); only the final net line now also subtracts a
-- vale, capped to available net so net_pay >= 0 always holds.
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
begin
  select * into v_entry from payroll_entries where id = p_entry_id;
  if v_entry is null then raise exception 'Entry not found'; end if;

  select * into v_period from pay_periods where id = v_entry.pay_period_id;
  select * into v_staff from staff where id = v_entry.staff_id;

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

      v_total_ee := v_total_ee + v_ee;
      v_rows := v_rows || jsonb_build_object(
        'agency', v_agency, 'bracket_id', r.bracket_id,
        'credited', r.credited_salary_centavos, 'ee', v_ee, 'er', v_er
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

-- ── 5. record / void an advance ────────────────────────────────────────────
create or replace function public.fn_record_staff_advance(
  p_staff_id uuid,
  p_amount_centavos bigint,
  p_note text default null,
  p_date date default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_shop uuid; v_id uuid;
begin
  if not public.is_owner() then raise exception 'Only the owner can record advances'; end if;
  if coalesce(p_amount_centavos, 0) <= 0 then raise exception 'Amount must be greater than zero'; end if;
  select shop_id into v_shop from staff where id = p_staff_id and deleted_at is null;
  if v_shop is null then raise exception 'Staff not found'; end if;
  insert into staff_advances (staff_id, shop_id, amount_centavos, note, advance_date, created_by)
  values (p_staff_id, v_shop, p_amount_centavos, nullif(trim(coalesce(p_note, '')), ''),
          coalesce(p_date, public.ph_today()), auth.uid())
  returning id into v_id;
  return v_id;
end $$;
revoke all on function public.fn_record_staff_advance(uuid, bigint, text, date) from public, anon;
grant execute on function public.fn_record_staff_advance(uuid, bigint, text, date) to authenticated;

create or replace function public.fn_void_staff_advance(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_adv record; v_advanced bigint; v_deducted bigint;
begin
  if not public.is_owner() then raise exception 'Only the owner can void advances'; end if;
  select * into v_adv from staff_advances where id = p_id and deleted_at is null for update;
  if v_adv is null then raise exception 'Advance not found'; end if;
  -- can't void what's already been repaid via payslip deductions
  select coalesce(sum(amount_centavos), 0) into v_advanced
  from staff_advances where staff_id = v_adv.staff_id and deleted_at is null;
  select coalesce(sum(vale_centavos), 0) into v_deducted
  from payroll_entries where staff_id = v_adv.staff_id;
  if v_advanced - v_adv.amount_centavos < v_deducted then
    raise exception 'Cannot void — % has already been deducted against this advance',
      (v_deducted / 100.0)::money;
  end if;
  update staff_advances set deleted_at = now() where id = p_id;
end $$;
revoke all on function public.fn_void_staff_advance(uuid) from public, anon;
grant execute on function public.fn_void_staff_advance(uuid) to authenticated;

-- ── 6. set the vale deducted on a payslip (capped + carry) ─────────────────
create or replace function public.fn_save_payroll_vale(
  p_entry_id uuid,
  p_requested_centavos bigint
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entry record;
  v_period record;
  v_ee bigint;
  v_avail bigint;
  v_balance bigint;
  v_capped bigint;
begin
  if not public.is_owner() then raise exception 'Only the owner can edit payroll'; end if;
  if coalesce(p_requested_centavos, 0) < 0 then raise exception 'Amount cannot be negative'; end if;

  select * into v_entry from payroll_entries where id = p_entry_id;
  if v_entry is null then raise exception 'Entry not found'; end if;
  if v_entry.status = 'paid' then raise exception 'This payslip is already paid'; end if;

  select * into v_period from pay_periods where id = v_entry.pay_period_id;
  if v_period.status = 'finalized' then raise exception 'This pay period is finalized'; end if;

  -- available net = gross − Σ employee gov share (the frozen snapshot)
  select coalesce(sum(ee_amount_centavos), 0) into v_ee
  from payroll_entry_contributions where payroll_entry_id = p_entry_id;
  v_avail := greatest(0, v_entry.gross_pay - v_ee);

  -- outstanding balance for this staffer, EXCLUDING this entry's current vale
  select coalesce((select sum(amount_centavos) from staff_advances
                   where staff_id = v_entry.staff_id and deleted_at is null), 0)
       - coalesce((select sum(vale_centavos) from payroll_entries
                   where staff_id = v_entry.staff_id and id <> p_entry_id), 0)
    into v_balance;

  v_capped := greatest(0, least(p_requested_centavos, v_avail, greatest(0, v_balance)));

  update payroll_entries set vale_centavos = v_capped where id = p_entry_id;
  perform public.fn_apply_entry_contributions(p_entry_id); -- rewrites net_pay
  return v_capped;
end $$;
revoke all on function public.fn_save_payroll_vale(uuid, bigint) from public, anon;
grant execute on function public.fn_save_payroll_vale(uuid, bigint) to authenticated;
