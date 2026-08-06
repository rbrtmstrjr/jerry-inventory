-- ---------------------------------------------------------------------------
-- 0122 — restore the anon revokes that 0116 silently undid. SECURITY FIX.
--
-- 0116 dropped and recreated every view in `public` so the qty columns could be
-- retyped. It carefully restored each view's definition, reloptions
-- (security_barrier) and GRANTS — and verified all three.
--
-- It did not restore the REVOKES, because a revoke is not a grant: it is the
-- ABSENCE of one, and absence cannot be snapshotted from
-- information_schema.role_table_grants.
--
-- That mattered because of a Supabase default this project already depends on
-- elsewhere: `alter default privileges ... grant all on tables to anon,
-- authenticated`. A NEWLY CREATED view picks those up automatically. So every
-- view 0002 had explicitly revoked from `anon` came back anon-readable the
-- moment 0116 recreated it.
--
-- Observed after 0116, with the anon key:
--     public_settings   READABLE — 1 row      <- actual data
--     shop_stock        READABLE — 0 rows
--     receivables       READABLE — 0 rows     <- RLS still held, but the
--     movement_journal  READABLE — 0 rows        grant should not have existed
--
-- Row-level security stopped it being a leak in most cases; `public_settings`
-- is the exception, and it is exactly the view whose security IS the column
-- list rather than a row filter (see CLAUDE.md — it has no row filter because
-- every column it exposes is printed on paper handed to customers). Low
-- severity, but the revoke was deliberate and belongs back.
--
-- Caught by `test-settings`: "signed-out reads nothing from public_settings".
-- Worth noting what this says about 0116's verification: it checked the view
-- COUNT and the RELOPTIONS and called that proof. It never asked what `anon`
-- could reach afterwards. A migration that recreates objects must verify the
-- privileges it did NOT intend to change, not only the ones it did.
--
-- FIX: revoke anon from every view in public. Not a curated list — a list is
-- what drifts. No view in this schema is meant to be anon-readable: the shop
-- app authenticates, and even `/receipt/[saleId]`, which sits outside every
-- route group, is gated by RLS on an authenticated session.
--
-- `authenticated` is untouched: the app reads these constantly.
-- ---------------------------------------------------------------------------

do $$
declare
  v record;
  n int := 0;
begin
  for v in
    select c.relname
      from pg_class c
     where c.relkind = 'v'
       and c.relnamespace = 'public'::regnamespace
  loop
    execute format('revoke all on public.%I from anon', v.relname);
    n := n + 1;
  end loop;

  raise notice '0122: anon revoked from % views', n;

  -- Prove it, rather than trusting the loop: ask the catalog whether anon
  -- retains any privilege on any view in public.
  perform 1
    from information_schema.role_table_grants g
    join pg_class c on c.relname = g.table_name
                   and c.relnamespace = 'public'::regnamespace
                   and c.relkind = 'v'
   where g.table_schema = 'public'
     and g.grantee = 'anon';

  if found then
    raise exception '0122: anon still holds privileges on at least one view';
  end if;
end $$;
