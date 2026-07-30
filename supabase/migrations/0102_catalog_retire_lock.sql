-- ---------------------------------------------------------------------------
-- 0102 — Catalog retire & merge lock: removing a product is Gerry's alone.
--
-- The catalog slice of the 0099 owner/admin split, after 0100 (price lock) and
-- 0101 (utang void). NUMBERED 0102, not 0101: this work was specified as
-- "0099 pt 3", but 0101_void_utang_gerry_only.sql already holds that number
-- and that label. Nothing here depends on 0101 — only on 0099's
-- is_primary_owner() — so the order between them is free.
--
-- WHY. A retire is the one catalog action that removes evidence. A retired
-- part vanishes from Master Inventory, every picker, Stock Alerts and the
-- purchase list, while its stock_movements history stays behind as the
-- "orphaned debris" the reconciliation invariant already tolerates and
-- excludes (0045). A merge is worse: it retires the source AND redirects its
-- supplier prices onto another product (supplier_price_comparison resolves
-- through merged_into, 0052). Since the admin encodes cost at entry (0100),
-- an unlocked retire/merge is a way to make a product's cost trail disappear
-- from view. 0100 locked the numbers; this locks the disappearing.
--
-- ===========================================================================
-- THE DISCRIMINATOR: deleted_at is NOT price_centavos
-- ===========================================================================
-- 0100 could use a blanket "raise unless is_primary_owner()" because no
-- definer function updates the money columns on an existing row. The opposite
-- is true for engines.deleted_at. Verified, not assumed:
--
--   grep -n "update parts\|update public.parts\|update engines\|update public.engines\
--            \|update engine_models\|update public.engine_models\
--            \|update product_categories\|update public.product_categories" \
--        supabase/migrations/*.sql
--   grep -n "deleted_at = now()" supabase/migrations/*.sql
--
-- Findings:
--   • engines.deleted_at is written by FOUR definer functions at FIVE sites,
--     all as a normal part of operations the ADMIN must be able to run:
--       fn_approve_loss                  0008:186  approved engine loss
--       fn_resolve_delivery_discrepancy  0029:323  transit write-off
--                                        0054:383  (current redefinition)
--       fn_return_stock                  0058:334  damaged engine on return
--       fn_approve_return                0065:217  same, shop-initiated path
--     (The spec for this change said "five functions" and listed four —
--      fn_resolve_delivery_discrepancy appears twice because 0054 redefines
--      it. Four distinct functions, five sites.)
--   • SECURITY DEFINER changes the effective privilege, NOT auth.uid() — it
--     still returns the calling admin's id inside all four. A naive trigger
--     would therefore break loss approval, discrepancy resolution and return
--     approval for the admin: the entire office workflow.
--   • parts.deleted_at has exactly ONE definer writer, fn_merge_parts
--     (0052:155), which this migration gates anyway.
--   • engine_models.deleted_at and product_categories.deleted_at have NO
--     definer writer at all.
--
-- The discriminator is a real business rule, not a workaround: every
-- operational soft-delete happens to an engine that has ALREADY LEFT MASTER.
-- fn_approve_loss and both return paths require status='delivered'; the
-- write-off paths act on status='in_transit'. The catalog action
-- softDeleteEngine already scopes itself with .eq("status","in_master").
--
--   An engine still sitting in master — unsold, undelivered, sellable — may
--   only be removed from the catalog by Gerry. An engine consumed by an
--   approved loss, a transit write-off or a damaged return is not a catalog
--   deletion at all.
--
-- ===========================================================================
-- WHY TRIGGERS AND A REVOKE, NOT RLS
-- ===========================================================================
-- RLS is row-level: it cannot express "this role may UPDATE every column
-- except deleted_at". That is exactly why 0100 reached for a trigger, and the
-- same reasoning applies here. No policy changes in this migration.
--
-- Hard DELETE was a live loophole and closes here too. 0049 revoked only
-- INSERT; parts_owner_all is FOR ALL with is_owner(), and DELETE was still
-- granted to `authenticated`. FK back-references block a part that has
-- history, but a freshly-created, history-less part or engine model could be
-- hard-deleted by an admin today — which defeats a deleted_at trigger
-- entirely. Verified safe: every hard delete in scripts/ runs through the
-- service-role client, and `revoke ... from authenticated` does not touch
-- service_role.
--
-- ===========================================================================
-- OUT OF SCOPE (deliberate)
-- ===========================================================================
--   • softDeleteSupplier — a supplier is a counterparty, not a catalog
--     product. Retiring one hides no stock and erases no cost trail. Stays
--     office-tier.
--   • part_fitments deletes inside setPartFitments — a join table, not a
--     product.
--   • No request-and-approve flow. Consistent with 0100: the office calls
--     Gerry. No "request retirement" queue.
--   • No deleted_by audit column. Only Gerry can retire now, so attribution
--     is unambiguous; merges are already audited in part_merges (0052).
--
-- NO BACKFILL. Nothing about existing rows changes — this migration only
-- removes an ability.
--
-- NO LEDGER, RECONCILIATION OR P&L IMPACT. Nothing here writes, edits or
-- deletes a stock_movements row. A merge already moves no stock and writes no
-- movement (0052); this only narrows who may call it.
-- Σ movements = stock_levels per product × location is untouched, lib/pnl.ts
-- is untouched, and no report query changes. Don't go looking for one.
--
-- Error messages deliberately do NOT reuse 0100's wording — test-price-lock
-- matches /only the owner can change/i, and these must not collide with it.
-- ---------------------------------------------------------------------------

-- ── 1. engine_models + product_categories: plain retire gate ────────────────
-- Gated in the RETIRE DIRECTION ONLY (null → not-null). Un-retiring makes
-- something visible again — that is not the cheat, and createCategory
-- legitimately restores a retired category by name as a normal admin action.
-- A symmetric IS DISTINCT FROM gate would break that restore.
create or replace function public.enforce_catalog_retire_lock()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.deleted_at is null
     and new.deleted_at is not null
     and auth.uid() is not null
     and not public.is_primary_owner()
  then
    raise exception 'Only the owner can retire a product';
  end if;
  return new;
end;
$$;
comment on function public.enforce_catalog_retire_lock() is
  'Retiring an engine model or product category is Gerry-only (0102). Retire
   direction only, so restoring stays office-tier. Service role and JWT-less
   contexts exempt.';

drop trigger if exists trg_engine_models_retire_lock on public.engine_models;
create trigger trg_engine_models_retire_lock
  before update on public.engine_models
  for each row execute function public.enforce_catalog_retire_lock();

drop trigger if exists trg_product_categories_retire_lock on public.product_categories;
create trigger trg_product_categories_retire_lock
  before update on public.product_categories
  for each row execute function public.enforce_catalog_retire_lock();

-- ── 2. parts: retire gate + the merged_into redirect ───────────────────────
-- merged_into needs its OWN clause. fn_merge_parts sets merged_into and
-- deleted_at together, so the deleted_at gate already catches the RPC — but a
-- direct `update parts set merged_into = <other>` with no deleted_at would
-- silently roll one product's supplier price history onto another while
-- leaving it live. Covered separately, and symmetrically (any change to the
-- pointer, in either direction, is a redirect).
create or replace function public.enforce_part_retire_lock()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is not null and not public.is_primary_owner() then
    if old.deleted_at is null and new.deleted_at is not null then
      raise exception 'Only the owner can retire a product';
    end if;
    if new.merged_into is distinct from old.merged_into then
      raise exception 'Only the owner can merge products';
    end if;
  end if;
  return new;
end;
$$;
comment on function public.enforce_part_retire_lock() is
  'Retiring a part, or repointing its merged_into, is Gerry-only (0102).
   Retire is gated in the null -> not-null direction; merged_into is gated in
   both, since any change to the pointer redirects supplier price history.';

drop trigger if exists trg_parts_retire_lock on public.parts;
create trigger trg_parts_retire_lock
  before update on public.parts
  for each row execute function public.enforce_part_retire_lock();

-- ── 3. engines: retire gate, ONLY while the unit is still in master ────────
-- ===========================================================================
-- DO NOT "SIMPLIFY" THE status CLAUSE AWAY. It is what keeps the admin's
-- daily work running. Four definer functions soft-delete an engine at five
-- sites as normal operations, and auth.uid() is the ADMIN inside all of them:
--
--   fn_approve_loss                  (0008:186) engine status 'delivered'
--   fn_resolve_delivery_discrepancy  (0054:383) engine status 'in_transit'
--   fn_return_stock                  (0058:334) engine status 'delivered'
--   fn_approve_return                (0065:217) engine status 'delivered'
--
-- Removing `old.status = 'in_master'` breaks loss approval, discrepancy
-- resolution and return approval for the admin. See the migration header.
-- ===========================================================================
create or replace function public.enforce_engine_retire_lock()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if old.deleted_at is null
     and new.deleted_at is not null
     and old.status::text = 'in_master'   -- catalog removal, not consumption
     and auth.uid() is not null
     and not public.is_primary_owner()
  then
    raise exception 'Only the owner can remove an engine from the catalog';
  end if;
  return new;
end;
$$;
comment on function public.enforce_engine_retire_lock() is
  'Removing an IN-MASTER engine from the catalog is Gerry-only (0102). Engines
   consumed by an approved loss, transit write-off or damaged return have
   already left master and pass — that is operations, not a catalog deletion.';

drop trigger if exists trg_engines_retire_lock on public.engines;
create trigger trg_engines_retire_lock
  before update on public.engines
  for each row execute function public.enforce_engine_retire_lock();

-- ── 4. Close the hard-DELETE loophole ─────────────────────────────────────
-- Soft-delete-everywhere means nobody legitimately needs this; service_role
-- (harness cleanup, seeds) is unaffected by a revoke from `authenticated`.
revoke delete on public.parts              from public, anon, authenticated;
revoke delete on public.engines            from public, anon, authenticated;
revoke delete on public.engine_models      from public, anon, authenticated;
revoke delete on public.product_categories from public, anon, authenticated;

-- ── 5. Table comments stay the honest summary (extends 0049's text) ────────
comment on table public.parts is
  'Product catalog (quantity-tracked). NO direct INSERT for app roles since
   0049 — parts are born inside fn_receive_stock (receiving is the single
   stock entry point). NO DELETE for app roles, and RETIRING (deleted_at) or
   REDIRECTING (merged_into) one is the primary owner''s alone since 0102.
   Other UPDATEs stay office-editable via RLS; cost + selling price are
   owner-only since 0100.';
comment on table public.engines is
  'Serialized engines, one row per physical unit. NO direct INSERT for app
   roles since 0049 — serials are born inside fn_receive_stock. NO DELETE for
   app roles, and removing an IN-MASTER serial from the catalog is the primary
   owner''s alone since 0102 (units consumed by a loss, transit write-off or
   damaged return have already left master and are unaffected).';
comment on table public.engine_models is
  'Engine type definitions. NO direct INSERT for app roles since 0049 —
   created inline at receiving; edited from Master Inventory. NO DELETE for
   app roles, and RETIRING one is the primary owner''s alone since 0102.';
comment on table public.product_categories is
  'Product categories (reference data that shapes report grouping). NO DELETE
   for app roles, and RETIRING one is the primary owner''s alone since 0102;
   creating, renaming and RESTORING a retired name stay office-tier.';

-- ── 6. fn_merge_parts — the in-body guard becomes is_primary_owner() ───────
-- Redefined whole (the newest migration holds the authoritative body, as this
-- codebase does everywhere). Copied from 0052 with EXACTLY two changes: the
-- guard function and its message. The three preconditions, the fitment
-- carry-forward, the delete from stock_levels and the part_merges audit row
-- are byte-identical — and it still writes NO ledger row.
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
  if not public.is_primary_owner() then
    raise exception 'Only the owner can merge products';
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

comment on function public.fn_merge_parts(uuid, uuid, text) is
  'Fold a duplicate part into a survivor — catalog identity only, writes NO
   ledger row (0052). Primary-owner-only since 0102.';

revoke all on function public.fn_merge_parts(uuid, uuid, text) from public, anon;
grant execute on function public.fn_merge_parts(uuid, uuid, text) to authenticated;
