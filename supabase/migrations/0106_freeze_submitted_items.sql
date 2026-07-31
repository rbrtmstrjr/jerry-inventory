-- 0106 — Freeze a submitted item to the shop (SEC-6.1).
--
-- The approval pipeline only means something if what the owner reviews cannot
-- change after it is submitted. Since 0016/0017 the draft state is 'recorded'
-- and 'pending' means "submitted, awaiting the owner's approval" — yet the
-- employee edit/insert/delete policies still listed 'pending' among the
-- editable states. That was a fossil from the pre-0016 model where 'pending'
-- WAS the draft (the 0002 comment "edit ONLY while still pending" dates from
-- then). The hole let a shop record an honest sale, submit it, then silently
-- lower a line's price or bump its qty before the owner approved —
-- fn_approve_sale reads the LIVE lines, so the owner approved one thing and a
-- different thing posted.
--
-- Fix: the shop may edit an item only while it is a draft ('recorded') or when
-- the owner has explicitly sent it back ('questioned'). A submitted ('pending')
-- item is frozen. WITHDRAWING a submission is NOT an edit — it removes the item
-- so nothing posts — so sales_delete / losses_delete KEEP 'pending' and the
-- shop's Cancel button still works. The owner arm (is_owner()) is untouched.
--
-- Only the USING/WITH CHECK state lists change; every other clause is byte-for-
-- byte the 0017 policy.

-- ── sales: the row (money columns, customer, payment_type) ──────────────────
drop policy if exists sales_update on public.sales;
create policy sales_update on public.sales for update
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('recorded','questioned'))
  ) with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'recorded')
  );

-- ── sale_lines: the actual qty / price the approval deducts and books ────────
drop policy if exists sale_lines_insert on public.sale_lines;
create policy sale_lines_insert on public.sale_lines for insert
  to authenticated with check (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner()
                   or (s.shop_id = public.auth_shop_id()
                       and s.recorded_by = auth.uid()
                       and s.status = 'recorded')))
  );

drop policy if exists sale_lines_update on public.sale_lines;
create policy sale_lines_update on public.sale_lines for update
  to authenticated using (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner()
                   or (s.shop_id = public.auth_shop_id()
                       and s.recorded_by = auth.uid()
                       and s.status = 'recorded')))
  );

drop policy if exists sale_lines_delete on public.sale_lines;
create policy sale_lines_delete on public.sale_lines for delete
  to authenticated using (
    exists (select 1 from public.sales s
            where s.id = sale_id
              and (public.is_owner()
                   or (s.shop_id = public.auth_shop_id()
                       and s.recorded_by = auth.uid()
                       and s.status = 'recorded')))
  );

-- ── losses: same freeze ─────────────────────────────────────────────────────
drop policy if exists losses_update on public.losses;
create policy losses_update on public.losses for update
  to authenticated using (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status in ('recorded','questioned'))
  ) with check (
    public.is_owner()
    or (shop_id = public.auth_shop_id()
        and recorded_by = auth.uid()
        and status = 'recorded')
  );

-- sales_delete / losses_delete deliberately UNCHANGED — withdrawing a pending
-- submission is legitimate and is not an edit.
