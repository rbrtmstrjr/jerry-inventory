-- ---------------------------------------------------------------------------
-- 0047 — Close the 0042 hole on three cost/balance definer functions
--
-- AUDIT FINDING (Phase 1). `fn_supplier_outstanding` and `fn_receiving_balance`
-- are SECURITY DEFINER (they bypass RLS), granted to `authenticated`, and had
-- NO caller check. A shop session that supplied a supplier_id / receiving_id
-- got the supplier debt back — cost data, the one thing the whole schema exists
-- to keep from shops. `fn_sale_balance` had no caller scoping either: any sale's
-- balance was computable given its id. This is exactly the hole 0042 named — "a
-- definer function without a role check is the hole RLS exists to close."
--
-- Exploitability today is low (the ids live in owner-only tables a shop cannot
-- enumerate, and a UUID is not guessable), but the invariant must be enforced
-- in the function, not left resting on id-unguessability. Defense in depth.
--
-- THE CRON TRAP — why the guard is NOT a plain `is_owner()`.
-- `fn_supplier_outstanding` and `fn_receiving_balance` are called by the daily
-- pg_cron sweeps (fn_check_supplier_limit_alerts, fn_check_supplier_overdue),
-- which run with NO JWT. Under that context `is_owner()` is FALSE (verified),
-- so a plain owner-only guard would make the cron compute 0 for everyone and
-- silently kill every overdue/limit alert — a worse regression than the leak.
--
-- The distinguishing fact (verified against the live DB):
--   • owner client → auth.uid() = owner,  is_owner() TRUE
--   • shop client  → auth.uid() = shop,    is_owner() FALSE
--   • cron/service → auth.uid() IS NULL,   is_owner() FALSE
-- So `is_owner() OR auth.uid() IS NULL` admits owner + cron and blocks a shop.
-- A blocked caller gets an empty result (0 / null), matching the master_low_stock
-- view pattern (non-owner silently sees nothing) rather than raising — these are
-- read helpers, and raising would change the contract of functions the cron and
-- the owner already depend on.
--
-- `fn_sale_balance` additionally admits the sale's OWN shop, because the
-- shop-callable utang-payment chain (fn_record_utang_payment / _void) calls it
-- to check the payment ceiling on that shop's own sale. auth.uid() persists
-- through a SECURITY DEFINER call, so auth_shop_id() there is the real shop.
--
-- All three keep their existing signatures, grants, and every internal caller
-- (all of which run as owner or cron) works unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.fn_supplier_outstanding(p_supplier_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(b.bal), 0)
  from (
    select r.total_amount - r.amount_paid
         - coalesce((select sum(sp.amount) from supplier_payments sp
                     where sp.receiving_id = r.id and sp.deleted_at is null), 0) as bal
    from receivings r
    where r.supplier_id = p_supplier_id and r.deleted_at is null
      -- owner or cron only; a shop gets 0
      and (public.is_owner() or auth.uid() is null)
  ) b
  where b.bal > 0;
$$;

create or replace function public.fn_receiving_balance(p_receiving_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select r.total_amount
       - coalesce(r.amount_paid, 0)
       - coalesce((
           select sum(sp.amount) from supplier_payments sp
           where sp.receiving_id = r.id and sp.deleted_at is null
         ), 0)
  from receivings r
  where r.id = p_receiving_id and r.deleted_at is null
    -- owner or cron only; a shop gets null
    and (public.is_owner() or auth.uid() is null);
$$;

create or replace function public.fn_sale_balance(p_sale_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select s.total_centavos
       - coalesce(s.amount_paid_centavos, 0)
       - coalesce((
           select sum(up.amount_centavos)
           from utang_payments up
           where up.sale_id = s.id
             and up.status = 'approved'
             and up.deleted_at is null
         ), 0)
  from sales s
  where s.id = p_sale_id and s.deleted_at is null
    -- owner, cron, or the sale's OWN shop (the utang-payment chain runs here)
    and (public.is_owner() or auth.uid() is null
         or s.shop_id = public.auth_shop_id());
$$;
