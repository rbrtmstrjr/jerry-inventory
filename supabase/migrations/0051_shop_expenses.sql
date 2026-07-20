-- ============================================================================
-- 0051 — Shop-recorded expenses with approval.
--
-- Shops record their own expenses; they ride the EXISTING submission batch to
-- Admin and only count (ledger, P&L, contribution) once APPROVED. This
-- reverses two earlier decisions ("owner records all", "shops never see
-- expenses") — intentional, per the client after a working demo.
--
-- Why approval when utang payments post immediately (0026): an expense is a
-- claim that CASH LEFT with no stock footprint — a fabricated one is theft
-- the inventory can never catch. Sales/losses at least reconcile against
-- stock; an expense reconciles against nothing, so it gets the preventive
-- control, not the detective one.
--
-- Owner-recorded expenses skip approval (he doesn't approve himself): they
-- are created status='approved' — the column DEFAULTS preserve today's
-- behavior and double as the backfill (ADD COLUMN .. DEFAULT rewrites
-- existing rows), so history creates ZERO pending items (0028/0033 style).
--
-- Category proposals are REAL expense_categories rows with status='proposed'
-- (created inside fn_record_shop_expense, deduped case-insensitively), so
-- expenses.category_id stays NOT NULL and "Gas"/"Gasolina"/"Fuel" sprawl is
-- resolved at review: approve-as-proposed flips the row to active, or the
-- expense is REMAPPED to an existing category and the proposal never
-- activates. Proposed categories never appear in pickers or reports.
-- ============================================================================

-- ── expenses: lifecycle ─────────────────────────────────────────────────────
alter table public.expenses
  add column if not exists status public.submission_status not null default 'approved',
  add column if not exists source text not null default 'owner'
    check (source in ('owner','shop')),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists review_note text,
  add column if not exists batch_id uuid references public.submission_batches(id);

-- a shop-sourced expense is ALWAYS shop-scoped at its own shop
alter table public.expenses
  add constraint expense_shop_source check (
    source <> 'shop' or (scope = 'shop' and shop_id is not null)
  );

create index if not exists idx_expenses_status on public.expenses (status);
create index if not exists idx_expenses_batch on public.expenses (batch_id);

comment on column public.expenses.status is
  'recorded→pending→questioned→approved/rejected. Only APPROVED counts in any
   ledger, report, or P&L figure. Owner-created rows default to approved (the
   owner does not approve himself).';

-- ── expense_categories: proposals ───────────────────────────────────────────
alter table public.expense_categories
  add column if not exists status text not null default 'active'
    check (status in ('active','proposed')),
  add column if not exists proposed_by_shop_id uuid references public.shops(id);

-- ── RLS: shops see their OWN shop's expenses (both sources); company never ──
drop policy if exists expenses_shop_select on public.expenses;
create policy expenses_shop_select on public.expenses for select
  to authenticated using (
    scope = 'shop' and shop_id = public.auth_shop_id()
  );
-- (owner_all FOR ALL policy from 0013 remains; policies OR together.
--  Employees still have NO insert/update path — writes go through the RPCs.)

-- categories: employees read active ones (the picker) + their own proposals
drop policy if exists expense_categories_shop_select on public.expense_categories;
create policy expense_categories_shop_select on public.expense_categories for select
  to authenticated using (
    status = 'active' or proposed_by_shop_id = public.auth_shop_id()
  );

-- ── receipts bucket: shops write/read ONLY their own path prefix ────────────
-- Shop receipts live under 'shop-<shop_id>/…'; the prefix is the isolation.
drop policy if exists "receipts shop insert" on storage.objects;
create policy "receipts shop insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'receipts'
    and public.auth_shop_id() is not null
    and name like 'shop-' || public.auth_shop_id()::text || '/%'
  );

drop policy if exists "receipts shop select" on storage.objects;
create policy "receipts shop select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'receipts'
    and public.auth_shop_id() is not null
    and name like 'shop-' || public.auth_shop_id()::text || '/%'
  );

-- ── fn_record_shop_expense — shops RECORD; scope/shop are FORCED ────────────
create or replace function public.fn_record_shop_expense(
  p_amount_centavos bigint,
  p_description text,
  p_category_id uuid default null,
  p_proposed_category text default null,
  p_expense_date date default null,
  p_paid_to text default null,
  p_payment_method text default 'cash',
  p_reference_no text default null,
  p_receipt_path text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_cat uuid;
  v_id uuid;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can record a shop expense';
  end if;

  if p_amount_centavos is null or p_amount_centavos <= 0 then
    raise exception 'Amount must be positive';
  end if;
  if coalesce(trim(p_description), '') = '' then
    raise exception 'A description is required';
  end if;
  if (p_category_id is null) = (coalesce(trim(p_proposed_category), '') = '') then
    raise exception 'Pick a category OR propose a new one (exactly one)';
  end if;
  -- the receipt must sit in this shop's own prefix (storage policy enforces
  -- the upload; this stops a path pointing at someone else's object)
  if p_receipt_path is not null
     and p_receipt_path not like 'shop-' || v_shop::text || '/%' then
    raise exception 'Receipt path must be under this shop''s folder';
  end if;

  if p_category_id is not null then
    select id into v_cat from expense_categories
    where id = p_category_id and status = 'active' and deleted_at is null;
    if v_cat is null then
      raise exception 'Category not found or not active';
    end if;
  else
    -- reuse an ACTIVE category of the same name (typo-proofing), else reuse an
    -- existing proposal, else create the proposal (status=proposed — invisible
    -- to pickers/reports until Admin approves it)
    select id into v_cat from expense_categories
    where lower(name) = lower(trim(p_proposed_category)) and deleted_at is null
    order by (status = 'active') desc
    limit 1;
    if v_cat is null then
      insert into expense_categories (name, status, proposed_by_shop_id, sort_order)
      values (trim(p_proposed_category), 'proposed', v_shop, 900)
      returning id into v_cat;
    end if;
  end if;

  insert into expenses
    (category_id, amount, expense_date, scope, shop_id, description, paid_to,
     payment_method, reference_no, receipt_image_path, recorded_by,
     status, source)
  values
    (v_cat, p_amount_centavos, coalesce(p_expense_date, public.ph_today()),
     'shop', v_shop, trim(p_description), nullif(trim(coalesce(p_paid_to,'')),''),
     coalesce(p_payment_method, 'cash')::public.payment_method,
     nullif(trim(coalesce(p_reference_no,'')),''), p_receipt_path, auth.uid(),
     'recorded', 'shop')
  returning id into v_id;

  return v_id;
end $$;

revoke all on function public.fn_record_shop_expense(bigint, text, uuid, text, date, text, text, text, text) from public, anon;
grant execute on function public.fn_record_shop_expense(bigint, text, uuid, text, date, text, text, text, text) to authenticated;

-- ── fn_approve_expense — the ONLY way a shop expense starts counting ────────
-- Mirrors fn_approve_sale/fn_approve_loss (dedicated approve fn; batch and the
-- queue both call it). p_remap_category_id resolves a proposed category to an
-- existing one; approving WITHOUT a remap activates the proposal as-is.
create or replace function public.fn_approve_expense(
  p_expense_id uuid,
  p_note text default null,
  p_remap_category_id uuid default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.submission_status;
  v_cat uuid;
  v_cat_status text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve expenses';
  end if;

  select status, category_id into v_status, v_cat
  from expenses where id = p_expense_id and deleted_at is null for update;
  if v_status is null then raise exception 'Expense not found'; end if;
  if v_status not in ('pending','questioned') then
    raise exception 'Expense already reviewed (status: %)', v_status;
  end if;

  select status into v_cat_status from expense_categories where id = v_cat;

  if p_remap_category_id is not null then
    if not exists (
      select 1 from expense_categories
      where id = p_remap_category_id and status = 'active' and deleted_at is null
    ) then
      raise exception 'Remap target category not found or not active';
    end if;
    update expenses set category_id = p_remap_category_id where id = p_expense_id;
    -- the proposal never activates; it stays proposed and can be retired from
    -- /expenses/categories if nothing else references it
  elsif v_cat_status = 'proposed' then
    update expense_categories set status = 'active' where id = v_cat;
  end if;

  update expenses
  set status = 'approved',
      approved_by = auth.uid(),
      approved_at = now(),
      review_note = coalesce(nullif(trim(coalesce(p_note,'')),''), review_note)
  where id = p_expense_id;
end $$;

revoke all on function public.fn_approve_expense(uuid, text, uuid) from public, anon;
grant execute on function public.fn_approve_expense(uuid, text, uuid) to authenticated;

-- ── submit: expenses become the 4th batch member ────────────────────────────
create or replace function public.fn_submit_shop_batch()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_batch uuid;
  v_sales int;
  v_losses int;
  v_expenses int;
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can submit the batch';
  end if;

  insert into submission_batches (shop_id, submitted_by)
  values (v_shop, auth.uid())
  returning id into v_batch;

  update sales set status = 'pending', batch_id = v_batch
  where shop_id = v_shop and status = 'recorded' and deleted_at is null;
  get diagnostics v_sales = row_count;

  update losses set status = 'pending', batch_id = v_batch
  where shop_id = v_shop and status = 'recorded' and deleted_at is null;
  get diagnostics v_losses = row_count;

  update expenses set status = 'pending', batch_id = v_batch
  where shop_id = v_shop and source = 'shop' and status = 'recorded'
    and deleted_at is null;
  get diagnostics v_expenses = row_count;

  if v_sales + v_losses + v_expenses = 0 then
    raise exception 'Nothing to submit — no recorded sales, losses, or expenses';
  end if;

  return jsonb_build_object(
    'batch_id', v_batch,
    'sales', v_sales, 'losses', v_losses, 'expenses', v_expenses
  );
end $$;

revoke all on function public.fn_submit_shop_batch() from public, anon;
grant execute on function public.fn_submit_shop_batch() to authenticated;

-- ── batch approve: expenses ride along (as-proposed category activation) ────
create or replace function public.fn_approve_batch(
  p_batch_id uuid,
  p_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_sales int := 0;
  v_losses int := 0;
  v_expenses int := 0;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve batches';
  end if;

  if not exists (
    select 1 from submission_batches where id = p_batch_id and deleted_at is null
  ) then
    raise exception 'Batch not found';
  end if;

  for r in
    select id from sales
    where batch_id = p_batch_id and status = 'pending' and deleted_at is null
    order by created_at
  loop
    perform public.fn_approve_sale(r.id, p_note);
    v_sales := v_sales + 1;
  end loop;

  for r in
    select id from losses
    where batch_id = p_batch_id and status = 'pending' and deleted_at is null
    order by created_at
  loop
    perform public.fn_approve_loss(r.id, p_note);
    v_losses := v_losses + 1;
  end loop;

  for r in
    select id from expenses
    where batch_id = p_batch_id and status = 'pending' and deleted_at is null
    order by created_at
  loop
    perform public.fn_approve_expense(r.id, p_note);
    v_expenses := v_expenses + 1;
  end loop;

  if v_sales + v_losses + v_expenses = 0 then
    raise exception 'Nothing pending in this batch — items were already reviewed or are questioned';
  end if;

  return jsonb_build_object('sales', v_sales, 'losses', v_losses, 'expenses', v_expenses);
end $$;

revoke all on function public.fn_approve_batch(uuid, text) from public, anon;
grant execute on function public.fn_approve_batch(uuid, text) to authenticated;

-- ── review: 'expense' joins sale | loss | payment for question/reject ───────
create or replace function public.fn_review_submission(
  p_kind text,          -- 'sale' | 'loss' | 'payment' | 'expense'
  p_id uuid,
  p_action text,        -- 'question' | 'reject'
  p_note text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status public.submission_status;
  v_new public.submission_status;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can review submissions';
  end if;
  if p_action not in ('question','reject') then
    raise exception 'Unknown action %', p_action;
  end if;
  if p_action = 'question' and coalesce(trim(p_note), '') = '' then
    raise exception 'A question needs a note for the employee';
  end if;

  v_new := case p_action when 'question' then 'questioned'::public.submission_status
                         else 'rejected'::public.submission_status end;

  if p_kind = 'sale' then
    select status into v_status from sales where id = p_id and deleted_at is null for update;
    if v_status is null then raise exception 'Sale not found'; end if;
    if v_status not in ('pending','questioned') then
      raise exception 'Sale already reviewed (status: %)', v_status;
    end if;
    update sales
    set status = v_new, owner_note = p_note,
        reviewed_by = case when p_action = 'reject' then auth.uid() else reviewed_by end,
        reviewed_at = case when p_action = 'reject' then now() else reviewed_at end
    where id = p_id;

  elsif p_kind = 'loss' then
    select status into v_status from losses where id = p_id and deleted_at is null for update;
    if v_status is null then raise exception 'Loss not found'; end if;
    if v_status not in ('pending','questioned') then
      raise exception 'Loss already reviewed (status: %)', v_status;
    end if;
    update losses
    set status = v_new, owner_note = p_note,
        reviewed_by = case when p_action = 'reject' then auth.uid() else reviewed_by end,
        reviewed_at = case when p_action = 'reject' then now() else reviewed_at end
    where id = p_id;

  elsif p_kind = 'payment' then
    select status into v_status from utang_payments where id = p_id and deleted_at is null for update;
    if v_status is null then raise exception 'Payment not found'; end if;
    if v_status not in ('pending','questioned') then
      raise exception 'Payment already reviewed (status: %)', v_status;
    end if;
    update utang_payments
    set status = v_new, owner_note = p_note,
        reviewed_by = case when p_action = 'reject' then auth.uid() else reviewed_by end,
        reviewed_at = case when p_action = 'reject' then now() else reviewed_at end
    where id = p_id;

  elsif p_kind = 'expense' then
    select status into v_status from expenses where id = p_id and deleted_at is null for update;
    if v_status is null then raise exception 'Expense not found'; end if;
    if v_status not in ('pending','questioned') then
      raise exception 'Expense already reviewed (status: %)', v_status;
    end if;
    update expenses
    set status = v_new, review_note = p_note,
        approved_by = case when p_action = 'reject' then auth.uid() else approved_by end,
        approved_at = case when p_action = 'reject' then now() else approved_at end
    where id = p_id;

  else
    raise exception 'Unknown kind %', p_kind;
  end if;
end $$;

revoke all on function public.fn_review_submission(text, uuid, text, text) from public, anon;
grant execute on function public.fn_review_submission(text, uuid, text, text) to authenticated;

-- ── reviewed history: expenses join the unified list (shop-sourced only — an
--    owner-recorded expense was never reviewed, so it has no place here) ─────
drop view if exists public.reviewed_items;

create view public.reviewed_items
with (security_barrier = true) as

select
  'sale'::text                                        as item_type,
  s.id,
  s.shop_id,
  sh.name                                             as shop_name,
  s.status::text                                      as status,
  s.reviewed_at,
  coalesce(s.reviewed_at, s.updated_at, s.created_at) as event_at,
  ((coalesce(s.reviewed_at, s.updated_at, s.created_at)
      at time zone 'Asia/Manila')::date)              as event_date,
  s.created_at,
  s.business_date,
  s.total_centavos                                    as amount_centavos,
  coalesce(li.summary, 'Sale')                        as summary,
  s.customer_id,
  c.name                                              as customer_name,
  s.owner_note,
  s.batch_id,
  lower(concat_ws(' ', sh.name, c.name, li.summary, s.receipt_no)) as search_text
from public.sales s
join public.shops sh on sh.id = s.shop_id
left join public.customers c on c.id = s.customer_id
left join lateral (
  select string_agg(
           sl.description || case when sl.qty > 1 then ' × ' || sl.qty else '' end,
           ', ' order by sl.created_at
         ) as summary
  from public.sale_lines sl
  where sl.sale_id = s.id
) li on true
where s.deleted_at is null
  and s.status in ('approved','rejected','questioned')
  and public.is_owner()

union all

select
  'loss'::text,
  l.id,
  l.shop_id,
  sh.name,
  l.status::text,
  l.reviewed_at,
  coalesce(l.reviewed_at, l.updated_at, l.created_at),
  ((coalesce(l.reviewed_at, l.updated_at, l.created_at)
      at time zone 'Asia/Manila')::date),
  l.created_at,
  l.business_date,
  coalesce(l.value_centavos, 0),
  coalesce(l.description, 'Item') || ' × ' || l.qty || ' · ' || l.reason::text,
  null::uuid,
  null::text,
  l.owner_note,
  l.batch_id,
  lower(concat_ws(' ', sh.name, l.description, l.reason::text, l.note))
from public.losses l
join public.shops sh on sh.id = l.shop_id
where l.deleted_at is null
  and l.status in ('approved','rejected','questioned')
  and public.is_owner()

union all

select
  'utang_payment'::text,
  up.id,
  up.shop_id,
  sh.name,
  up.status::text,
  up.reviewed_at,
  coalesce(up.reviewed_at, up.created_at),
  ((coalesce(up.reviewed_at, up.created_at)
      at time zone 'Asia/Manila')::date),
  up.created_at,
  up.business_date,
  up.amount_centavos,
  'Utang payment — ' || coalesce(c.name, 'walk-in'),
  up.customer_id,
  c.name,
  up.owner_note,
  up.batch_id,
  lower(concat_ws(' ', sh.name, c.name, sa.receipt_no))
from public.utang_payments up
join public.shops sh on sh.id = up.shop_id
left join public.customers c on c.id = up.customer_id
left join public.sales sa on sa.id = up.sale_id
where up.deleted_at is null
  and up.status in ('approved','rejected','questioned')
  and public.is_owner()

union all

select
  'expense'::text,
  e.id,
  e.shop_id,
  sh.name,
  e.status::text,
  e.approved_at,
  coalesce(e.approved_at, e.updated_at, e.created_at),
  ((coalesce(e.approved_at, e.updated_at, e.created_at)
      at time zone 'Asia/Manila')::date),
  e.created_at,
  e.expense_date,
  e.amount,
  ec.name || ' — ' || e.description,
  null::uuid,
  null::text,
  e.review_note,
  e.batch_id,
  lower(concat_ws(' ', sh.name, ec.name, e.description, e.paid_to))
from public.expenses e
join public.shops sh on sh.id = e.shop_id
join public.expense_categories ec on ec.id = e.category_id
where e.deleted_at is null
  and e.source = 'shop'
  and e.status in ('approved','rejected','questioned')
  and public.is_owner();

revoke all on public.reviewed_items from anon;
grant select on public.reviewed_items to authenticated;
