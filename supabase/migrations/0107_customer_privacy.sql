-- 0107 — Scope customer reads to a shop's own customers (SEC-5.1).
--
-- customers_select was `using (true)`: any shop login could read every
-- customer's name / phone / address across all branches — the entire CRM — with
-- one direct PostgREST call (the UI never queries customers directly; the shop
-- gets the customer data it needs through the scoped receivables / shop_warranties
-- views, and fn_record_sale creates/looks up customers as SECURITY DEFINER).
--
-- Fix: the owner (office tier) still sees all; a shop sees a customer only when
-- that customer has a sale at the shop. That is exactly the set the
-- receivables / shop_warranties joins need, so those views keep resolving names,
-- while cross-shop enumeration is closed. fn_record_sale is a definer function
-- and bypasses RLS, so inline customer creation/lookup is unaffected.
--
-- The subquery respects sales' own RLS (an employee only sees their shop's
-- sales), and customers is not referenced back from the sales policy, so there
-- is no recursion.

drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select
  to authenticated using (
    public.is_owner()
    or exists (
      select 1 from public.sales s
      where s.customer_id = customers.id
        and s.shop_id = public.auth_shop_id()
        and s.deleted_at is null
    )
  );

-- Note: product_categories / engine_models / part_fitments keep `using (true)`
-- on purpose — non-sensitive shared reference data every shop legitimately
-- reads (pickers, warranty lookups). Only customers carries PII.
