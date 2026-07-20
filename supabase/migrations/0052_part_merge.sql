-- ============================================================================
-- 0052 — Part merge: fold duplicate catalog parts into one, without ever
-- touching the append-only ledger.
--
-- WHY. fn_receive_stock (0048) creates a fresh `parts` row for every inline
-- new_part, so the same physical part bought from two suppliers becomes two
-- catalog rows with the same name/SKU — and Price Comparison groups by
-- part_id, so they read as two unrelated single-supplier products. The fix is
-- two-pronged: 0052 (this) reuses an existing part at receiving time AND gives
-- the owner a merge tool for the duplicates that already exist; the comparison
-- views resolve everything to a single canonical part.
--
-- THE LEDGER STAYS SACROSANCT. stock_movements has no write policy for anyone
-- and "corrections do not exist". A merge therefore MOVES NO STOCK and writes
-- NO movement: it is a catalog-identity operation only. A source may be merged
-- only when it carries ZERO live stock, nothing in transit, and no open
-- sale/loss line — so retiring it is the already-blessed "orphaned debris"
-- pattern (soft-deleted part, zero stock_levels, historical movements left
-- behind) that test-movements.mjs already excludes. No new ledger path.
--
-- NON-DESTRUCTIVE. The source is not rewritten — its receiving_lines,
-- supplier_quotes, sale_lines stay literally true. A tombstone pointer
-- `merged_into` redirects pricing/comparison to the survivor. Resolution is
-- always coalesce(merged_into, id), enforced one-hop (target must be canonical).
--
-- NO hard SKU-unique index here on purpose: live data already has duplicate
-- SKUs (that's the bug), so a unique(lower(sku)) would fail on apply — the
-- classic "spec assumed a clean DB" trap. Dedup is behavioral (receiving reuse
-- + this merge tool); an index can come later, only after cleanup.
-- ============================================================================

-- ── parts: tombstone pointer ────────────────────────────────────────────────
alter table public.parts
  add column if not exists merged_into uuid references public.parts(id);

create index if not exists idx_parts_merged_into
  on public.parts (merged_into) where merged_into is not null;

comment on column public.parts.merged_into is
  'Set when this part was merged into another (the survivor). Non-null implies
   deleted_at is also set. Resolution is coalesce(merged_into, id); a merge
   target must itself be canonical (merged_into is null), so at most one hop.';

-- ── part_merges: audit trail (owner-only) ───────────────────────────────────
create table if not exists public.part_merges (
  id uuid primary key default gen_random_uuid(),
  source_part_id uuid not null references public.parts(id),
  target_part_id uuid not null references public.parts(id),
  merged_by uuid references public.profiles(id),
  merged_at timestamptz not null default now(),
  note text
);

alter table public.part_merges enable row level security;
revoke all on public.part_merges from anon;
drop policy if exists part_merges_owner_all on public.part_merges;
create policy part_merges_owner_all on public.part_merges
  for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

-- ── fn_merge_parts — catalog identity only; NEVER writes the ledger ─────────
create or replace function public.fn_merge_parts(
  p_source_id uuid,
  p_target_id uuid,
  p_note text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src record;
  v_tgt record;
  v_qty int;
  v_loc text;
  v_transit int;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can merge parts';
  end if;
  if p_source_id = p_target_id then
    raise exception 'A part cannot be merged into itself';
  end if;

  select id, name, deleted_at, merged_into into v_src
  from parts where id = p_source_id;
  if v_src.id is null then raise exception 'Source part not found'; end if;
  if v_src.deleted_at is not null then
    raise exception 'The duplicate is already retired';
  end if;

  select id, name, deleted_at, merged_into into v_tgt
  from parts where id = p_target_id;
  if v_tgt.id is null then raise exception 'Target part not found'; end if;
  -- merged is checked BEFORE retired: a merged part is also soft-deleted, and
  -- "merge into the surviving part" is the message that tells the owner what
  -- to do next (one-hop enforcement).
  if v_tgt.merged_into is not null then
    raise exception 'The target was itself merged — merge into the surviving part instead';
  end if;
  if v_tgt.deleted_at is not null then
    raise exception 'Cannot merge into a retired part';
  end if;

  -- ── preconditions: the source must be safe to RETIRE (ledger stays whole) ──
  -- 1. no live stock anywhere (master + every shop)
  select sl.qty, coalesce(sh.name, 'master') into v_qty, v_loc
  from stock_levels sl
  left join shops sh on sh.id = sl.shop_id
  where sl.part_id = p_source_id and sl.qty > 0
  order by sl.qty desc
  limit 1;
  if v_qty is not null then
    raise exception '% has % on hand at % — sell, return, or count it to zero before merging',
      v_src.name, v_qty, v_loc;
  end if;

  -- 2. nothing in transit
  select coalesce(sum(dl.qty_outstanding), 0) into v_transit
  from delivery_lines dl where dl.part_id = p_source_id;
  if v_transit > 0 then
    raise exception '% has % unit(s) still in transit — confirm or resolve the delivery before merging',
      v_src.name, v_transit;
  end if;

  -- 3. no open (recorded/pending/questioned) sale or loss line
  if exists (
    select 1 from sale_lines sl
    join sales s on s.id = sl.sale_id
    where sl.part_id = p_source_id
      and s.deleted_at is null
      and s.status in ('recorded','pending','questioned')
  ) or exists (
    select 1 from losses l
    where l.part_id = p_source_id
      and l.deleted_at is null
      and l.status in ('recorded','pending','questioned')
  ) then
    raise exception '% is on an unsubmitted or pending sale/loss — resolve it before merging',
      v_src.name;
  end if;

  -- ── effect: retire the source; roll identity up to the survivor ──
  -- carry fitments forward (dedupe) BEFORE the source is soft-deleted
  insert into part_fitments (part_id, engine_model_id)
  select p_target_id, engine_model_id
  from part_fitments where part_id = p_source_id
  on conflict (part_id, engine_model_id) do nothing;

  -- the blessed retirement: soft-delete + drop the (zero) stock_levels rows,
  -- leaving historical stock_movements as tolerated debris. The ledger is
  -- untouched — no movement is written, edited, or deleted.
  delete from stock_levels where part_id = p_source_id;

  update parts
  set merged_into = p_target_id,
      deleted_at = now()
  where id = p_source_id;

  insert into part_merges (source_part_id, target_part_id, merged_by, note)
  values (p_source_id, p_target_id, auth.uid(), nullif(trim(coalesce(p_note,'')),''));
end $$;

revoke all on function public.fn_merge_parts(uuid, uuid, text) from public, anon;
grant execute on function public.fn_merge_parts(uuid, uuid, text) to authenticated;

-- ── views: resolve every price to the CANONICAL (surviving) part ────────────
-- Last price PAID per (supplier × canonical product). A receiving of a merged
-- source now attributes its last-paid price to the survivor via merged_into.
create or replace view public.supplier_product_prices_history
with (security_barrier = true) as
select distinct on (r.supplier_id, coalesce(p.merged_into, rl.part_id, e.engine_model_id))
  r.supplier_id,
  s.name as supplier_name,
  coalesce(p.merged_into, rl.part_id) as part_id,
  e.engine_model_id,
  rl.unit_cost_centavos,
  r.received_at,
  r.id as receiving_id
from public.receiving_lines rl
join public.receivings r on r.id = rl.receiving_id and r.deleted_at is null
join public.suppliers s on s.id = r.supplier_id
left join public.parts p on p.id = rl.part_id
left join public.engines e on e.id = rl.engine_id
where r.supplier_id is not null
  and public.is_owner()
order by r.supplier_id, coalesce(p.merged_into, rl.part_id, e.engine_model_id),
         r.received_at desc, rl.id desc;

revoke all on public.supplier_product_prices_history from anon;
grant select on public.supplier_product_prices_history to authenticated;

-- One row per (canonical product × supplier). latest_quote resolves the
-- quote's part through merged_into so a quote against a merged duplicate lands
-- on the survivor; every window partitions by the canonical id, so
-- supplier_count is DISTINCT suppliers for the surviving product.
create or replace view public.supplier_price_comparison
with (security_barrier = true) as
with latest_quote as (
  select distinct on (q.supplier_id, coalesce(qp.merged_into, q.part_id, q.engine_model_id))
    q.id, q.supplier_id,
    coalesce(qp.merged_into, q.part_id) as part_id,
    q.engine_model_id,
    q.unit_cost_centavos, q.quoted_at, q.valid_until, q.note
  from public.supplier_quotes q
  left join public.parts qp on qp.id = q.part_id
  where q.deleted_at is null
  order by q.supplier_id, coalesce(qp.merged_into, q.part_id, q.engine_model_id),
           q.quoted_at desc, q.created_at desc
),
pairs as (
  select
    coalesce(lp.supplier_id, lq.supplier_id)         as supplier_id,
    coalesce(lp.part_id, lq.part_id)                 as part_id,
    coalesce(lp.engine_model_id, lq.engine_model_id) as engine_model_id,
    lp.unit_cost_centavos as last_paid_centavos,
    lp.received_at        as last_paid_at,
    lp.receiving_id,
    lq.id                 as quote_id,
    lq.unit_cost_centavos as quote_centavos,
    lq.quoted_at,
    lq.valid_until,
    lq.note               as quote_note
  from public.supplier_product_prices_history lp
  full outer join latest_quote lq
    on lq.supplier_id = lp.supplier_id
   and coalesce(lq.part_id, lq.engine_model_id)
     = coalesce(lp.part_id, lp.engine_model_id)
),
enriched as (
  select
    pr.*,
    s.name as supplier_name,
    coalesce(pt.name, em.brand || ' ' || em.model) as product_name,
    pt.sku,
    coalesce(pt.unit, 'unit') as unit,
    pc.name as category_name,
    case when pr.part_id is not null then 'part' else 'engine_model' end as kind,
    coalesce(pt.preferred_supplier_id, em.preferred_supplier_id) as preferred_supplier_id,
    (pr.quote_id is not null and (
       (pr.valid_until is not null and pr.valid_until < public.ph_today())
       or pr.quoted_at < public.ph_today()
          - (select st.quote_stale_days from public.settings st where st.id = 1)
    )) as quote_stale
  from pairs pr
  join public.suppliers s on s.id = pr.supplier_id
  -- pr.part_id is canonical, so this join lands on the SURVIVOR (live) part
  left join public.parts pt on pt.id = pr.part_id and pt.deleted_at is null
  left join public.product_categories pc on pc.id = pt.category_id
  left join public.engine_models em on em.id = pr.engine_model_id
  where (pt.id is not null or em.id is not null)
),
effective as (
  select
    e.*,
    case
      when e.quote_id is not null and not e.quote_stale then e.quote_centavos
      when e.last_paid_centavos is not null            then e.last_paid_centavos
      else e.quote_centavos
    end as effective_centavos,
    case
      when e.quote_id is not null and not e.quote_stale then 'quote'
      when e.last_paid_centavos is not null            then 'paid'
      else 'stale_quote'
    end as effective_source,
    case
      when e.quote_id is not null and not e.quote_stale then e.quoted_at
      when e.last_paid_centavos is not null            then e.last_paid_at::date
      else e.quoted_at
    end as effective_as_of
  from enriched e
)
select
  f.*,
  (f.supplier_id = f.preferred_supplier_id) as is_preferred,
  min(f.effective_centavos)
    over (partition by coalesce(f.part_id, f.engine_model_id)) as cheapest_centavos,
  (f.effective_centavos = min(f.effective_centavos)
    over (partition by coalesce(f.part_id, f.engine_model_id))) as is_cheapest,
  min(case when f.supplier_id = f.preferred_supplier_id then f.effective_centavos end)
    over (partition by coalesce(f.part_id, f.engine_model_id)) as preferred_effective_centavos,
  count(*) over (partition by coalesce(f.part_id, f.engine_model_id)) as supplier_count
from effective f
where public.is_owner();

revoke all on public.supplier_price_comparison from anon;
grant select on public.supplier_price_comparison to authenticated;

-- ── fn_receive_stock — reuse an existing part instead of minting a duplicate ─
-- Byte-identical to 0048 EXCEPT: a new_part line now first looks for a live,
-- non-merged part with the same barcode or SKU and reuses it (stock lands on
-- the existing catalog row, no second parts row). This is the root-cause fix
-- for split price comparisons — the merge tool cleans up pre-existing dupes,
-- this stops new ones being created. Never dedups on name alone (too risky).
create or replace function public.fn_receive_stock(
  p_supplier_id uuid,
  p_note text,
  p_parts jsonb default '[]'::jsonb,
  p_engines jsonb default '[]'::jsonb,
  p_payment_status text default 'paid',
  p_amount_paid bigint default null,
  p_due_date date default null,
  p_override boolean default false,
  p_override_reason text default null
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_receiving_id uuid;
  r record;
  v_part_id uuid;
  v_model_id uuid;
  v_engine_id uuid;
  v_np jsonb;
  v_barcode text;
  v_sku text;
  v_count int := 0;
  v_total bigint := 0;
  v_paid bigint;
  v_status text;
  v_unpaid bigint;
  v_out_before bigint := 0;
  v_limit bigint;
  v_terms int;
  v_due date;
  v_name text;
begin
  if not public.is_owner() then
    raise exception 'Only the owner can receive stock';
  end if;
  if p_payment_status not in ('unpaid','partial','paid') then
    raise exception 'Invalid payment status: %', p_payment_status;
  end if;

  -- capture BEFORE we insert anything, so the projection excludes this receiving
  if p_supplier_id is not null then
    select credit_limit, payment_terms_days, name
      into v_limit, v_terms, v_name
    from suppliers where id = p_supplier_id and deleted_at is null;
    v_out_before := public.fn_supplier_outstanding(p_supplier_id);
  end if;

  insert into receivings (supplier_id, note, created_by)
  values (p_supplier_id, p_note, auth.uid())
  returning id into v_receiving_id;

  for r in
    select * from jsonb_to_recordset(coalesce(p_parts, '[]'::jsonb))
      as x(part_id uuid, qty int, unit_cost_centavos bigint, new_part jsonb)
  loop
    v_part_id := r.part_id;

    if v_part_id is null and r.new_part is not null then
      v_np := r.new_part;
      if coalesce(trim(v_np->>'name'), '') = '' then
        raise exception 'New product line missing name';
      end if;

      v_barcode := nullif(trim(coalesce(v_np->>'barcode', '')), '');
      v_sku := nullif(trim(coalesce(v_np->>'sku', '')), '');

      -- 0052: reuse a live, non-merged part by barcode (then SKU) before
      -- creating one. Name alone is never enough.
      if v_barcode is not null then
        select id into v_part_id from parts
        where barcode = v_barcode and deleted_at is null and merged_into is null
        limit 1;
      end if;
      if v_part_id is null and v_sku is not null then
        select id into v_part_id from parts
        where lower(sku) = lower(v_sku) and deleted_at is null and merged_into is null
        limit 1;
      end if;

      if v_part_id is null then
        -- no match → create it (barcode minting + friendly errors as 0048)
        if v_barcode is null
           and coalesce((v_np->>'generate_barcode')::boolean, false) then
          v_barcode := 'JM' || lpad(nextval('public.internal_barcode_seq')::text, 8, '0');
        end if;
        begin
          insert into parts
            (name, category_id, sku, barcode, unit,
             cost_centavos, price_centavos, reorder_level,
             preferred_supplier_id, notes)
          values
            (trim(v_np->>'name'),
             (v_np->>'category_id')::uuid,
             v_sku,
             v_barcode,
             coalesce(nullif(trim(coalesce(v_np->>'unit', '')), ''), 'pc'),
             coalesce(r.unit_cost_centavos, 0),
             coalesce((v_np->>'price_centavos')::bigint, 0),
             coalesce((v_np->>'reorder_level')::int, 0),
             coalesce((v_np->>'preferred_supplier_id')::uuid, p_supplier_id),
             nullif(trim(coalesce(v_np->>'notes', '')), ''))
          returning id into v_part_id;
        exception when unique_violation then
          raise exception 'Barcode % is already in use', v_barcode;
        end;
      end if;
    end if;

    if v_part_id is null then
      raise exception 'Part line missing part_id';
    end if;
    if r.qty is null or r.qty <= 0 then
      raise exception 'Part line qty must be positive';
    end if;

    insert into receiving_lines (receiving_id, part_id, qty, unit_cost_centavos)
    values (v_receiving_id, v_part_id, r.qty, coalesce(r.unit_cost_centavos, 0));

    insert into stock_levels (part_id, shop_id, qty)
    values (v_part_id, null, r.qty)
    on conflict (part_id, shop_id)
    do update set qty = stock_levels.qty + excluded.qty;

    insert into stock_movements
      (movement_type, part_id, qty_change, shop_id, actor, receiving_id, note)
    values
      ('received', v_part_id, r.qty, null, auth.uid(), v_receiving_id, p_note);

    v_total := v_total + (coalesce(r.unit_cost_centavos, 0) * r.qty);
    v_count := v_count + 1;
  end loop;

  for r in
    select * from jsonb_to_recordset(coalesce(p_engines, '[]'::jsonb))
      as x(serial_number text, engine_model_id uuid, condition text,
           cost_centavos bigint, price_centavos bigint, warranty_months int,
           margin_floor_pct numeric, margin_mid_pct numeric, margin_asking_pct numeric,
           new_model jsonb)
  loop
    if r.serial_number is null or length(trim(r.serial_number)) = 0 then
      raise exception 'Engine line missing serial_number';
    end if;

    v_model_id := r.engine_model_id;

    if v_model_id is null and r.new_model is not null then
      v_np := r.new_model;
      if coalesce(trim(v_np->>'brand'), '') = ''
         or coalesce(trim(v_np->>'model'), '') = '' then
        raise exception 'New engine model line missing brand/model';
      end if;

      select id into v_model_id
      from engine_models
      where lower(brand) = lower(trim(v_np->>'brand'))
        and lower(model) = lower(trim(v_np->>'model'))
        and deleted_at is null;

      if v_model_id is null then
        insert into engine_models
          (brand, model, horsepower, stroke, default_warranty_months,
           preferred_supplier_id)
        values
          (trim(v_np->>'brand'),
           trim(v_np->>'model'),
           (v_np->>'horsepower')::numeric,
           nullif(trim(coalesce(v_np->>'stroke', '')), ''),
           coalesce((v_np->>'default_warranty_months')::int, 12),
           coalesce((v_np->>'preferred_supplier_id')::uuid, p_supplier_id))
        returning id into v_model_id;
      end if;
    end if;

    if v_model_id is null then
      raise exception 'Engine line missing engine_model_id';
    end if;

    begin
      insert into engines
        (serial_number, engine_model_id, condition, cost_centavos,
         price_centavos, warranty_months, status,
         margin_floor_pct, margin_mid_pct, margin_asking_pct)
      values
        (trim(r.serial_number), v_model_id,
         coalesce(r.condition, 'brand_new'),
         coalesce(r.cost_centavos, 0), coalesce(r.price_centavos, 0),
         r.warranty_months, 'in_master',
         r.margin_floor_pct, r.margin_mid_pct, r.margin_asking_pct)
      returning id into v_engine_id;
    exception when unique_violation then
      raise exception 'Serial % already exists', trim(r.serial_number);
    end;

    insert into receiving_lines (receiving_id, engine_id, qty, unit_cost_centavos)
    values (v_receiving_id, v_engine_id, 1, coalesce(r.cost_centavos, 0));

    insert into stock_movements
      (movement_type, engine_id, qty_change, shop_id, actor, receiving_id, note)
    values
      ('received', v_engine_id, 1, null, auth.uid(), v_receiving_id, p_note);

    v_total := v_total + coalesce(r.cost_centavos, 0);
    v_count := v_count + 1;
  end loop;

  if v_count = 0 then
    raise exception 'Receiving must contain at least one line';
  end if;

  -- ── payment state ──
  if p_amount_paid is null then
    v_paid := case p_payment_status when 'paid' then v_total else 0 end;
  else
    v_paid := p_amount_paid;
  end if;
  if v_paid < 0 then
    raise exception 'Amount paid cannot be negative';
  end if;
  if v_paid > v_total then
    raise exception 'Amount paid (₱%) cannot exceed the receiving total (₱%)',
      to_char(v_paid / 100.0, 'FM999,999,990.00'),
      to_char(v_total / 100.0, 'FM999,999,990.00');
  end if;
  -- no supplier = nobody to owe
  if p_supplier_id is null then
    v_paid := v_total;
  end if;

  v_status := case
    when v_paid >= v_total then 'paid'
    when v_paid = 0 then 'unpaid'
    else 'partial'
  end;
  v_unpaid := v_total - v_paid;

  -- ── credit limit: warn + explicit override, never a silent block ──
  if v_unpaid > 0 and v_limit is not null and v_limit > 0
     and (v_out_before + v_unpaid) > v_limit then
    if not coalesce(p_override, false) then
      raise exception
        'CREDIT_LIMIT_EXCEEDED: this puts % at ₱% against a ₱% limit. Confirm with an override reason to proceed.',
        coalesce(v_name, 'this supplier'),
        to_char((v_out_before + v_unpaid) / 100.0, 'FM999,999,990.00'),
        to_char(v_limit / 100.0, 'FM999,999,990.00');
    end if;
    if coalesce(trim(p_override_reason), '') = '' then
      raise exception 'Going over the credit limit needs a reason';
    end if;
  end if;

  -- ── due date: from the supplier's terms unless told otherwise ──
  if v_unpaid > 0 then
    v_due := coalesce(
      p_due_date,
      case when v_terms is not null then public.ph_today() + v_terms else null end
    );
  else
    v_due := null;  -- nothing owed, nothing due
  end if;

  update receivings
  set total_amount = v_total,
      amount_paid = v_paid,
      payment_status = v_status,
      due_date = v_due,
      settled_at = case when v_unpaid = 0 then now() else null end,
      limit_override = coalesce(p_override, false) and v_unpaid > 0
                       and v_limit is not null and (v_out_before + v_unpaid) > v_limit,
      limit_override_reason = case
        when coalesce(p_override, false) and v_unpaid > 0
             and v_limit is not null and (v_out_before + v_unpaid) > v_limit
        then nullif(trim(coalesce(p_override_reason, '')), '') end,
      limit_override_by = case
        when coalesce(p_override, false) and v_unpaid > 0
             and v_limit is not null and (v_out_before + v_unpaid) > v_limit
        then auth.uid() end,
      limit_override_at = case
        when coalesce(p_override, false) and v_unpaid > 0
             and v_limit is not null and (v_out_before + v_unpaid) > v_limit
        then now() end
  where id = v_receiving_id;

  if p_supplier_id is not null then
    perform public.fn_check_supplier_limit_alerts(p_supplier_id);
  end if;

  return v_receiving_id;
end $$;

revoke all on function public.fn_receive_stock(uuid, text, jsonb, jsonb, text, bigint, date, boolean, text) from public, anon;
grant execute on function public.fn_receive_stock(uuid, text, jsonb, jsonb, text, bigint, date, boolean, text) to authenticated;
