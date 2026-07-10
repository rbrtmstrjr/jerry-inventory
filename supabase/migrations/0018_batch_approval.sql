-- ============================================================================
-- 0018_batch_approval.sql — one submission = one review for Jerry.
-- Submitting now creates a submission_batches row and tags every item with
-- batch_id; fn_approve_batch approves the whole group in one call (per-item
-- question/reject still available for plucking out a bad line).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Batch table
-- ---------------------------------------------------------------------------
create table if not exists public.submission_batches (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id),
  submitted_by uuid not null references public.profiles(id),
  submitted_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.submission_batches enable row level security;

drop policy if exists batches_select on public.submission_batches;
create policy batches_select on public.submission_batches for select
  to authenticated using (
    public.is_owner() or shop_id = public.auth_shop_id()
  );
-- inserts happen only inside fn_submit_shop_batch (security definer)

alter table public.sales  add column if not exists batch_id uuid references public.submission_batches(id);
alter table public.losses add column if not exists batch_id uuid references public.submission_batches(id);
create index if not exists sales_batch_idx  on public.sales(batch_id);
create index if not exists losses_batch_idx on public.losses(batch_id);

-- ---------------------------------------------------------------------------
-- Submit: everything recorded → pending under ONE new batch.
-- ---------------------------------------------------------------------------
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

  if v_sales + v_losses = 0 then
    raise exception 'Nothing to submit — no recorded sales or losses';
  end if;

  return jsonb_build_object('batch_id', v_batch, 'sales', v_sales, 'losses', v_losses);
end $$;

revoke all on function public.fn_submit_shop_batch() from public, anon;
grant execute on function public.fn_submit_shop_batch() to authenticated;

-- ---------------------------------------------------------------------------
-- Approve a whole batch in one shot. Approves every PENDING item in the
-- batch through the same per-item engines (stock deduction, warranty,
-- negative-stock guard — any guard failure aborts the whole batch untouched).
-- Questioned items are deliberately skipped: Jerry flagged those and they
-- resolve individually.
-- ---------------------------------------------------------------------------
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

  if v_sales + v_losses = 0 then
    raise exception 'Nothing pending in this batch — items were already reviewed or are questioned';
  end if;

  return jsonb_build_object('sales', v_sales, 'losses', v_losses);
end $$;

revoke all on function public.fn_approve_batch(uuid, text) from public, anon;
grant execute on function public.fn_approve_batch(uuid, text) to authenticated;
