-- ============================================================================
-- 0095_actor_indexes.sql — the other half of 0094: WHO-columns.
--
-- 0094 indexed the FK columns that gate deleting a DOCUMENT (loss, sale,
-- return…). Applying it moved the timeout one table downstream, exactly as an
-- unindexed-FK problem does: deleting a PROFILE now has to prove nothing
-- references it, and the ledger's `actor` column — ~300k rows, no index — plus
-- every recorded_by / reviewed_by / created_by / approved_by across the schema
-- is checked by sequential scan. Same disease, attribution edition:
--
--   [cleanup] profiles: canceling statement due to statement timeout
--
-- These are not test-only columns. Attribution is the FIRST layer of the
-- insider-threat model, and every surface that answers "which named admin did
-- this?" filters by exactly these columns — the Movements journal's actor
-- filter, the digest's approvals-by-admin rollup, /oversight's per-admin view.
-- Today those are sequential scans of the ledger; after this they are index
-- lookups. The complete column list was enumerated from the schema
-- (`references public.profiles`), not recalled — a missed column here is the
-- next timeout.
--
-- Partial (WHERE ... IS NOT NULL) on nullable columns; the planner can still
-- use them for the FK check, and the index skips every row with nobody in it.
-- ============================================================================

-- The ledger — the one that matters at scale.
create index if not exists idx_movements_actor
  on public.stock_movements (actor) where actor is not null;

-- Documents: who created / recorded them.
create index if not exists idx_receivings_created_by
  on public.receivings (created_by) where created_by is not null;
create index if not exists idx_receivings_limit_override_by
  on public.receivings (limit_override_by) where limit_override_by is not null;
create index if not exists idx_deliveries_created_by
  on public.deliveries (created_by) where created_by is not null;
create index if not exists idx_deliveries_confirmed_by
  on public.deliveries (confirmed_by) where confirmed_by is not null;
create index if not exists idx_deliveries_resolved_by
  on public.deliveries (resolved_by) where resolved_by is not null;
create index if not exists idx_deliveries_requested_by
  on public.deliveries (requested_by) where requested_by is not null;
create index if not exists idx_deliveries_approved_by
  on public.deliveries (approved_by) where approved_by is not null;
create index if not exists idx_returns_created_by
  on public.returns (created_by) where created_by is not null;
create index if not exists idx_returns_requested_by
  on public.returns (requested_by) where requested_by is not null;
create index if not exists idx_returns_approved_by
  on public.returns (approved_by) where approved_by is not null;
create index if not exists idx_delivery_discrepancies_resolved_by
  on public.delivery_discrepancies (resolved_by);

-- The submission pipeline: who recorded, who decided.
create index if not exists idx_sales_recorded_by
  on public.sales (recorded_by);
create index if not exists idx_sales_reviewed_by
  on public.sales (reviewed_by) where reviewed_by is not null;
create index if not exists idx_losses_recorded_by
  on public.losses (recorded_by);
create index if not exists idx_losses_reviewed_by
  on public.losses (reviewed_by) where reviewed_by is not null;
create index if not exists idx_batches_submitted_by
  on public.submission_batches (submitted_by);
create index if not exists idx_utang_recorded_by
  on public.utang_payments (recorded_by);
create index if not exists idx_utang_reviewed_by
  on public.utang_payments (reviewed_by) where reviewed_by is not null;
create index if not exists idx_expenses_recorded_by
  on public.expenses (recorded_by) where recorded_by is not null;
create index if not exists idx_expenses_approved_by
  on public.expenses (approved_by) where approved_by is not null;

-- Service + counts + reference operations.
create index if not exists idx_warranty_claims_requested_by
  on public.warranty_claims (requested_by) where requested_by is not null;
create index if not exists idx_warranty_claims_approved_by
  on public.warranty_claims (approved_by) where approved_by is not null;
create index if not exists idx_count_snapshots_created_by
  on public.count_snapshots (created_by) where created_by is not null;
create index if not exists idx_delivery_requests_requested_by
  on public.delivery_requests (requested_by);
create index if not exists idx_supplier_payments_created_by
  on public.supplier_payments (created_by) where created_by is not null;
create index if not exists idx_supplier_quotes_created_by
  on public.supplier_quotes (created_by) where created_by is not null;
create index if not exists idx_part_merges_merged_by
  on public.part_merges (merged_by) where merged_by is not null;
create index if not exists idx_discount_cards_issued_by
  on public.discount_cards (issued_by) where issued_by is not null;
create index if not exists idx_staff_user_id
  on public.staff (user_id) where user_id is not null;
