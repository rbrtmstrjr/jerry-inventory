-- ---------------------------------------------------------------------------
-- 0105 — Voiding an expense is Gerry's alone (the 0101 rule, expense edition).
--
-- A void erases a money record from every list and report AND removes its
-- receipt photo — the same "un-ring the bell" class as voiding an utang
-- payment. The office keeps daily expense work (record, edit, categorise,
-- approve shop claims); only Gerry can make one disappear.
--
-- Verified before writing this: NOTHING else soft-deletes an expense — no
-- shop-side cancel path exists and no definer function touches
-- `expenses.deleted_at` — so the trigger has zero collateral.
--
-- 0013's blanket FOR ALL office policy splits so hard DELETE is Gerry-only
-- too; the 0051 shop policies (shops read/insert their own claims) are
-- separate and untouched.
-- ---------------------------------------------------------------------------

drop policy if exists expenses_owner_all on public.expenses;

drop policy if exists expenses_office_select on public.expenses;
create policy expenses_office_select on public.expenses for select
  to authenticated using ((select public.is_owner()));

drop policy if exists expenses_office_insert on public.expenses;
create policy expenses_office_insert on public.expenses for insert
  to authenticated with check ((select public.is_owner()));

drop policy if exists expenses_office_update on public.expenses;
create policy expenses_office_update on public.expenses for update
  to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

drop policy if exists expenses_gerry_delete on public.expenses;
create policy expenses_gerry_delete on public.expenses for delete
  to authenticated using ((select public.is_primary_owner()));

-- the VOID (deleted_at flip) is the one UPDATE an admin must not make
create or replace function public.enforce_expense_void_lock()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.deleted_at is distinct from old.deleted_at
     and auth.uid() is not null
     and not public.is_primary_owner()
  then
    raise exception 'Only the owner can void an expense';
  end if;
  return new;
end;
$$;
comment on function public.enforce_expense_void_lock() is
  'Voiding (deleted_at) an expense is Gerry-only (0105); every other expense edit is office-tier. Service role exempt.';

drop trigger if exists trg_expenses_void_lock on public.expenses;
create trigger trg_expenses_void_lock
  before update on public.expenses
  for each row execute function public.enforce_expense_void_lock();
