-- ---------------------------------------------------------------------------
-- 0099 — Admin accounts (the LIGHT owner tier).
--
-- (0096–0098 were the reverted insider-threat experiment; those numbers are
-- retired so the SQL-editor history can't confuse two different "0096"s.)
--
-- Gerry (role 'owner') is the primary owner. An 'admin' is an office login
-- that runs ALL daily operations — receiving, deliveries, approvals,
-- expenses, payables — without Gerry being present. The split is deliberately
-- small and mostly app-level; the database enforces only the three things
-- that must never depend on a hidden button:
--
--   1. ACCOUNTS  — only Gerry creates/edits/deactivates/deletes profiles
--                  (an admin must not mint logins or reactivate themself).
--   2. SHOPS     — only Gerry opens/closes/edits branches.
--   3. SETTINGS  — office can READ (documents + dials need it); only Gerry
--                  writes.
--
-- Mechanism: is_owner() is REDEFINED to mean "office tier" (owner OR admin,
-- active). Every existing policy, view guard, and definer-function guard that
-- says is_owner() therefore accepts the admin with zero sweeping — including
-- notifications (recipient_role='owner' RLS), so daily alerts reach the
-- office automatically. A new is_primary_owner() (Gerry alone) guards the
-- three surfaces above.
--
-- Deactivation needs no new machinery: profiles.active already exists,
-- getProfile() already returns null for inactive accounts, and BOTH helper
-- functions check `and active` — an inactive admin loses app AND database
-- access the moment the flag flips.
--
-- Prod-safe notes:
--   • the enum value 'admin' already exists on prod (kept inert by the
--     revert of the old experiment), so the references below parse fine.
--   • policies keep the wrapped `(select …)` form (InitPlan, evaluated once
--     per statement — the 0076 lesson).
-- ---------------------------------------------------------------------------

-- 1. role value (no-op on prod; needed for a fresh replay)
alter type public.user_role add value if not exists 'admin';

-- 2. an admin is an office account: no shop, like the owner
alter table public.profiles drop constraint if exists profiles_role_shop;
alter table public.profiles add constraint profiles_role_shop check (
  (role in ('owner', 'admin') and shop_id is null)
  or (role = 'employee' and shop_id is not null)
);

-- 3. is_owner() now means "office tier" — the name is kept so no policy,
--    view, or definer function needs rewriting.
create or replace function public.is_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('owner', 'admin') and active
  );
$$;
comment on function public.is_owner() is
  'Office tier: primary owner OR admin (active). Since 0099. For Gerry-only surfaces use is_primary_owner().';

-- 4. is_primary_owner() — Gerry alone
create or replace function public.is_primary_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'owner' and active
  );
$$;
comment on function public.is_primary_owner() is
  'The primary owner (Gerry) alone. Guards accounts, shops, and settings writes (0099).';
revoke all on function public.is_primary_owner() from public;
grant execute on function public.is_primary_owner() to authenticated;

-- 5. profiles: self-read + office list stays; MANAGEMENT is Gerry's alone.
--    (Without this, a redefined is_owner() would let an admin create logins,
--    change roles, or reactivate themself.)
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert
  to authenticated with check ((select public.is_primary_owner()));

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  to authenticated
  using ((select public.is_primary_owner()))
  with check ((select public.is_primary_owner()));

drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete
  to authenticated using ((select public.is_primary_owner()));

-- 6. shops: structure (open/close/edit) is Gerry's; reads stay office+own-shop
drop policy if exists shops_write on public.shops;
create policy shops_write on public.shops for all
  to authenticated
  using ((select public.is_primary_owner()))
  with check ((select public.is_primary_owner()));

-- 7. settings: office reads (printed documents + alert dials depend on it);
--    only Gerry writes. Replaces the FOR ALL owner policy from 0002.
drop policy if exists settings_owner_all on public.settings;
drop policy if exists settings_office_select on public.settings;
create policy settings_office_select on public.settings for select
  to authenticated using ((select public.is_owner()));

drop policy if exists settings_gerry_insert on public.settings;
create policy settings_gerry_insert on public.settings for insert
  to authenticated with check ((select public.is_primary_owner()));

drop policy if exists settings_gerry_update on public.settings;
create policy settings_gerry_update on public.settings for update
  to authenticated
  using ((select public.is_primary_owner()))
  with check ((select public.is_primary_owner()));

drop policy if exists settings_gerry_delete on public.settings;
create policy settings_gerry_delete on public.settings for delete
  to authenticated using ((select public.is_primary_owner()));
