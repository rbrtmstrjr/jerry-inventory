-- ---------------------------------------------------------------------------
-- 0100 — Price lock: cost + selling price are Gerry's after entry (0099 pt 2).
--
-- The admin ENCODES cost and selling price exactly once, when stock enters
-- (Receiving / Add product / Add engine — all INSERTs, untouched here).
-- AFTER that, changing either money column on `parts` or `engines` is
-- Gerry-only: the office calls him, he updates it.
--
-- Enforced by a BEFORE UPDATE trigger, not app code, because a revoked
-- ability beats a hidden input. It fires ONLY when one of the two columns
-- actually changes (IS DISTINCT FROM), so every other update — names,
-- photos, barcodes, engine status changes from deliveries/sales, merge
-- tombstones — passes untouched.
--
-- Exemptions, both deliberate:
--   • auth.uid() IS NULL  — the service role (tests, seeds, maintenance)
--     and JWT-less cron contexts. Verified: NO definer function updates
--     these columns on existing rows (receiving stores per-receiving costs
--     in receiving_lines; a reused part's catalog cost is not rewritten),
--     so nothing internal ever trips this on an admin's behalf.
--   • is_primary_owner()  — Gerry.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_price_lock()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if (new.cost_centavos is distinct from old.cost_centavos
      or new.price_centavos is distinct from old.price_centavos)
     and auth.uid() is not null
     and not public.is_primary_owner()
  then
    raise exception 'Only the owner can change cost or selling price';
  end if;
  return new;
end;
$$;
comment on function public.enforce_price_lock() is
  'Cost/selling-price edits on parts+engines are Gerry-only after entry (0100). Service role and JWT-less contexts exempt.';

drop trigger if exists trg_parts_price_lock on public.parts;
create trigger trg_parts_price_lock
  before update on public.parts
  for each row execute function public.enforce_price_lock();

drop trigger if exists trg_engines_price_lock on public.engines;
create trigger trg_engines_price_lock
  before update on public.engines
  for each row execute function public.enforce_price_lock();
