-- 0070 — shop-initiated warranty-claim resolution (with admin approval)
--
-- The SHOP that sold the engine files a warranty claim + proposed resolution
-- (repair / replace / refund); the OWNER approves or rejects. Mirrors the
-- shop→admin request→approve pattern (transfers 0054, returns 0065): nothing
-- moves until the owner approves. On approval the stock + accounting effects
-- run, reusing the ledger's existing primitives (loss / return / expense) — no
-- new movement type.
--
-- Resolutions on approval:
--   replace — the shop's on-hand replacement engine is booked out as an approved
--             LOSS @cost (reason 'warranty'; shrinkage, no revenue), marked sold
--             to the customer, and the warranty repoints to it (term continues).
--             The defective unit → status 'defective' at master (RMA) — not
--             sellable, cost already sunk at the original sale.
--   refund  — the refund amount is booked as an approved COMPANY expense
--             ("Warranty Refunds"); the defective unit → 'defective' at master.
--   repair  — logged only (no stock/money).
--   reject  — note required, nothing moves.

-- ── 1. warranty_claims: workflow columns ───────────────────────────────────
alter table public.warranty_claims
  add column if not exists status text not null default 'requested'
    check (status in ('requested', 'approved', 'rejected', 'cancelled')),
  add column if not exists resolution text
    check (resolution in ('repair', 'replace', 'refund')),
  add column if not exists shop_id uuid references public.shops(id),
  add column if not exists requested_by uuid references public.profiles(id),
  add column if not exists approved_by uuid references public.profiles(id),
  add column if not exists approved_at timestamptz,
  add column if not exists review_note text,
  add column if not exists replacement_engine_id uuid references public.engines(id),
  add column if not exists refund_centavos bigint;
-- existing rows are owner-typed logs → already resolved.
update public.warranty_claims set status = 'approved' where status is null;

-- ── 2. a category for warranty refunds (idempotent) ────────────────────────
insert into public.expense_categories (name, status, sort_order)
select 'Warranty Refunds', 'active', 90
where not exists (
  select 1 from public.expense_categories
  where lower(name) = 'warranty refunds' and deleted_at is null
);

-- ── 3. notification types ───────────────────────────────────────────────────
alter table public.notifications drop constraint if exists notifications_type_check;
alter table public.notifications add constraint notifications_type_check
  check (type in (
    'master_low_stock','shop_low_stock','delivery_request',
    'delivery_request_fulfilled','delivery_request_dismissed',
    'utang_payment','utang_payment_voided',
    'delivery_incoming','delivery_confirmed','delivery_discrepancy',
    'warranty_expiring',
    'supplier_limit_warning','supplier_limit_reached','supplier_payment_overdue',
    'transfer_requested','transfer_approved','transfer_rejected',
    'warranty_claim','warranty_claim_approved','warranty_claim_rejected'
  ));

-- ── 4. shop-facing safe view (a shop reads its own claims) ─────────────────
-- Owner-only base table; this view (owned by postgres) bypasses that and
-- re-scopes by warranty→sale→shop, exactly like shop_warranties (0031).
create or replace view public.shop_warranty_claims
with (security_barrier = true) as
select
  c.id, c.warranty_id, c.status, c.resolution, c.issue, c.review_note,
  c.refund_centavos, c.created_at, c.approved_at,
  s.shop_id,
  e.serial_number,
  em.brand, em.model, em.horsepower,
  cust.name as customer_name,
  re.serial_number as replacement_serial
from public.warranty_claims c
join public.warranties w on w.id = c.warranty_id and w.deleted_at is null
join public.sales s on s.id = w.sale_id and s.deleted_at is null
join public.engines e on e.id = w.engine_id
left join public.engine_models em on em.id = e.engine_model_id
left join public.customers cust on cust.id = w.customer_id
left join public.engines re on re.id = c.replacement_engine_id
where c.deleted_at is null
  and (public.is_owner() or s.shop_id = public.auth_shop_id());
revoke all on public.shop_warranty_claims from anon;
grant select on public.shop_warranty_claims to authenticated;

-- ── 5. fn_request_warranty_claim — shop files it; NO stock moves ───────────
create or replace function public.fn_request_warranty_claim(
  p_warranty_id uuid,
  p_issue text,
  p_resolution text,
  p_replacement_engine_id uuid default null,
  p_refund_centavos bigint default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shop uuid;
  v_w record;
  v_rep record;
  v_id uuid;
  v_issue text := nullif(trim(coalesce(p_issue, '')), '');
begin
  select shop_id into v_shop from profiles
  where id = auth.uid() and role = 'employee' and active and deleted_at is null;
  if v_shop is null then
    raise exception 'Only shop employees can file a warranty claim';
  end if;
  if v_issue is null then raise exception 'Describe the issue'; end if;
  if p_resolution not in ('repair', 'replace', 'refund') then
    raise exception 'Resolution must be repair, replace, or refund';
  end if;

  select w.id, w.engine_id, w.customer_id, s.shop_id
    into v_w
  from warranties w
  join sales s on s.id = w.sale_id and s.deleted_at is null
  where w.id = p_warranty_id and w.deleted_at is null;
  if v_w.id is null then raise exception 'Warranty not found'; end if;
  if v_w.shop_id is distinct from v_shop then
    raise exception 'That warranty is not from your shop';
  end if;

  if p_resolution = 'replace' then
    if p_replacement_engine_id is null then
      raise exception 'Pick a replacement engine from your stock';
    end if;
    if p_replacement_engine_id = v_w.engine_id then
      raise exception 'The replacement must be a different engine';
    end if;
    select id, cost_centavos, serial_number into v_rep from engines
    where id = p_replacement_engine_id and status = 'delivered'
      and shop_id = v_shop and deleted_at is null;
    if v_rep.id is null then
      raise exception 'The replacement engine must be on hand at your shop';
    end if;
  elsif p_resolution = 'refund' then
    if coalesce(p_refund_centavos, 0) <= 0 then
      raise exception 'Enter the refund amount';
    end if;
  end if;

  insert into warranty_claims
    (warranty_id, issue, status, resolution, shop_id, requested_by,
     replacement_engine_id, refund_centavos)
  values
    (p_warranty_id, v_issue, 'requested', p_resolution, v_shop, auth.uid(),
     case when p_resolution = 'replace' then p_replacement_engine_id end,
     case when p_resolution = 'refund' then p_refund_centavos end)
  returning id into v_id;

  perform public.fn_notify(
    'owner', v_shop, 'warranty_claim',
    'Warranty claim (' || p_resolution || ')',
    'A shop filed a warranty claim awaiting your approval',
    'warranty_claims', v_id);

  return v_id;
end $$;
revoke all on function public.fn_request_warranty_claim(uuid, text, text, uuid, bigint) from public, anon;
grant execute on function public.fn_request_warranty_claim(uuid, text, text, uuid, bigint) to authenticated;

-- ── 6. fn_approve_warranty_claim — owner; runs the resolution ──────────────
create or replace function public.fn_approve_warranty_claim(p_claim_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c record;
  v_defective uuid;
  v_customer uuid;
  v_cust_name text;
  v_rep record;
  v_loss_id uuid;
  v_cat uuid;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can approve warranty claims';
  end if;

  select c.id, c.warranty_id, c.status, c.resolution, c.shop_id,
         c.replacement_engine_id, c.refund_centavos
    into v_c
  from warranty_claims c
  where c.id = p_claim_id and c.deleted_at is null for update;
  if v_c.id is null then raise exception 'Claim not found'; end if;
  if v_c.status <> 'requested' then raise exception 'This claim is not pending'; end if;

  select engine_id, customer_id into v_defective, v_customer
  from warranties where id = v_c.warranty_id and deleted_at is null for update;
  if v_defective is null then raise exception 'Warranty no longer available'; end if;
  select name into v_cust_name from customers where id = v_customer;

  if v_c.resolution = 'replace' then
    -- replacement must still be on hand at the shop
    select id, cost_centavos, serial_number into v_rep from engines
    where id = v_c.replacement_engine_id and status = 'delivered'
      and shop_id = v_c.shop_id and deleted_at is null for update;
    if v_rep.id is null then
      raise exception 'The replacement engine is no longer on hand at the shop';
    end if;

    -- 1) book the replacement OUT as an approved loss @cost (shrinkage)
    insert into losses (shop_id, recorded_by, engine_id, qty, reason, description,
                        status, value_centavos, reviewed_by, reviewed_at)
    values (v_c.shop_id, auth.uid(), v_rep.id, 1, 'warranty',
            'Warranty replacement to ' || coalesce(v_cust_name, 'a customer'),
            'approved', coalesce(v_rep.cost_centavos, 0), auth.uid(), now())
    returning id into v_loss_id;
    insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, loss_id, note)
    values ('loss', v_rep.id, -1, v_c.shop_id, auth.uid(), v_loss_id,
            'warranty replacement');

    -- 2) the replacement is now the customer's; warranty repoints to it (term continues)
    update engines set status = 'sold', customer_id = v_customer, sold_at = now()
    where id = v_rep.id;
    update warranties set engine_id = v_rep.id, updated_at = now()
    where id = v_c.warranty_id;

    -- 3) the defective unit → master, flagged defective (RMA); not sellable
    update engines set status = 'defective', shop_id = null where id = v_defective;
    insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, note)
    values ('return', v_defective, 1, null, auth.uid(),
            'defective warranty return (for supplier RMA)');

  elsif v_c.resolution = 'refund' then
    -- defective unit → master, flagged defective (RMA)
    update engines set status = 'defective', shop_id = null where id = v_defective;
    insert into stock_movements (movement_type, engine_id, qty_change, shop_id, actor, note)
    values ('return', v_defective, 1, null, auth.uid(),
            'defective warranty return (refunded; for supplier RMA)');

    -- book the refund as an approved company expense
    select id into v_cat from expense_categories
    where lower(name) = 'warranty refunds' and deleted_at is null limit 1;
    if v_cat is null then
      insert into expense_categories (name, status) values ('Warranty Refunds', 'active')
      returning id into v_cat;
    end if;
    insert into expenses (category_id, amount, scope, shop_id, description,
                          source, status, recorded_by, approved_by, approved_at)
    values (v_cat, v_c.refund_centavos, 'company', null,
            'Warranty refund to ' || coalesce(v_cust_name, 'a customer'),
            'owner', 'approved', auth.uid(), auth.uid(), now());

  end if;
  -- 'repair' does nothing but stamp the claim approved.

  update warranty_claims
  set status = 'approved', approved_by = auth.uid(), approved_at = now()
  where id = p_claim_id;

  perform public.fn_notify(
    'shop', v_c.shop_id, 'warranty_claim_approved',
    'Warranty claim approved',
    'Admin approved the ' || v_c.resolution || ' — done',
    'warranty_claims', p_claim_id);

  return p_claim_id;
end $$;
revoke all on function public.fn_approve_warranty_claim(uuid) from public, anon;
grant execute on function public.fn_approve_warranty_claim(uuid) to authenticated;

-- ── 7. fn_reject_warranty_claim — owner; note required, nothing moves ──────
create or replace function public.fn_reject_warranty_claim(p_claim_id uuid, p_note text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_shop uuid; v_status text;
begin
  if not public.is_owner() then raise exception 'Only the owner can reject claims'; end if;
  if coalesce(trim(p_note), '') = '' then raise exception 'A reason is required to reject'; end if;
  select shop_id, status into v_shop, v_status from warranty_claims
  where id = p_claim_id and deleted_at is null for update;
  if v_shop is null then raise exception 'Claim not found'; end if;
  if v_status <> 'requested' then raise exception 'This claim is not pending'; end if;
  update warranty_claims
  set status = 'rejected', review_note = trim(p_note),
      approved_by = auth.uid(), approved_at = now()
  where id = p_claim_id;
  perform public.fn_notify(
    'shop', v_shop, 'warranty_claim_rejected',
    'Warranty claim declined', trim(p_note),
    'warranty_claims', p_claim_id);
  return p_claim_id;
end $$;
revoke all on function public.fn_reject_warranty_claim(uuid, text) from public, anon;
grant execute on function public.fn_reject_warranty_claim(uuid, text) to authenticated;

-- ── 8. fn_cancel_warranty_claim — shop, only while requested ───────────────
create or replace function public.fn_cancel_warranty_claim(p_claim_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare v_shop uuid; v_status text;
begin
  select shop_id, status into v_shop, v_status from warranty_claims
  where id = p_claim_id and deleted_at is null for update;
  if v_shop is null then raise exception 'Claim not found'; end if;
  if v_shop is distinct from public.auth_shop_id() then
    raise exception 'You can only cancel your own claim';
  end if;
  if v_status <> 'requested' then raise exception 'Only a pending claim can be cancelled'; end if;
  update warranty_claims set status = 'cancelled' where id = p_claim_id;
  return p_claim_id;
end $$;
revoke all on function public.fn_cancel_warranty_claim(uuid) from public, anon;
grant execute on function public.fn_cancel_warranty_claim(uuid) to authenticated;
