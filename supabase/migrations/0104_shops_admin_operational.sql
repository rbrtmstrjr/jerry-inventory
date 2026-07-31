-- ---------------------------------------------------------------------------
-- 0104 — Shops & Employees moves to the OFFICE; closing + credentials stay
-- Gerry's (revises the 0099 blanket shops lock at the owner's request).
--
-- Gerry decided the page is daily operational work: the admin should manage
-- branch details (name, location, map pin, color, logo) and the STAFF records
-- (people, birthdays — their RLS was already office-tier). Two powers stay
-- above the admin:
--
--   • CLOSING (or re-opening) a shop — `deleted_at` is the shop's life
--     switch; flipping it re-shapes reports, releases the color, and hides a
--     branch. BEFORE UPDATE trigger, same pattern as the price lock (0100).
--   • HARD DELETE — Gerry-only policy (in practice only test cleanup deletes,
--     via the exempt service role).
--
-- Shop LOGIN credentials (create/replace/deactivate) were never table writes —
-- they are service-role server actions gated `role==='owner'` strictly, and
-- profiles RLS (0099) backs them: nothing here changes that.
-- ---------------------------------------------------------------------------

-- 0099's blanket FOR ALL policy splits: office writes, Gerry deletes
drop policy if exists shops_write on public.shops;

drop policy if exists shops_insert on public.shops;
create policy shops_insert on public.shops for insert
  to authenticated with check ((select public.is_owner()));

drop policy if exists shops_update on public.shops;
create policy shops_update on public.shops for update
  to authenticated
  using ((select public.is_owner()))
  with check ((select public.is_owner()));

drop policy if exists shops_delete on public.shops;
create policy shops_delete on public.shops for delete
  to authenticated using ((select public.is_primary_owner()));

-- closing/reopening is the one UPDATE an admin must not make
create or replace function public.enforce_shop_close_lock()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.deleted_at is distinct from old.deleted_at
     and auth.uid() is not null
     and not public.is_primary_owner()
  then
    raise exception 'Only the owner can close or reopen a shop';
  end if;
  return new;
end;
$$;
comment on function public.enforce_shop_close_lock() is
  'Closing/reopening a shop (deleted_at) is Gerry-only (0104); every other shop edit is office-tier. Service role exempt.';

drop trigger if exists trg_shops_close_lock on public.shops;
create trigger trg_shops_close_lock
  before update on public.shops
  for each row execute function public.enforce_shop_close_lock();
