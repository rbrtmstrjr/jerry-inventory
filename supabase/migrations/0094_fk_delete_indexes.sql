-- ============================================================================
-- 0094_fk_delete_indexes.sql — index the FK columns that gate DELETEs.
--
-- THE BUG THIS FIXES, caught in the act:
--   [cleanup] losses: canceling statement due to statement timeout
--
-- Deleting a row from `losses` forces Postgres to prove nothing still
-- references it. `stock_movements.loss_id` had NO index, so that proof was a
-- SEQUENTIAL SCAN of the whole ledger (~300k rows since the 3-year seed) — per
-- deleted row, via the per-row FK trigger. Two loss rows ≈ two full scans ≈
-- over the statement timeout whenever the cache was cold or the instance busy.
--
-- The symptom was maddeningly indirect: the losses delete died quietly, the
-- surviving loss FK-pinned the recorder's profile, the profile pinned the
-- shop, and a test-suite cleanup reported "left behind: 1 shop(s), 1 part(s)"
-- with the true cause three tables upstream. It looked like an FK-ordering
-- bug and flapped like a race, because it WAS load-dependent — the same
-- deletes succeeded minutes later on a warm cache.
--
-- This is not only a test problem. fn_void_sale, fn_merge_parts' guards, any
-- owner hard-delete, and the harness all pay the same seq-scan tax on every
-- parent-row delete. Indexing the referencing columns is the standard cure.
--
-- All partial (WHERE ... IS NOT NULL) where the column is mostly NULL — the
-- ledger has six mutually-exclusive source-document columns, so a full index
-- on each would be ~85% dead weight.
-- ============================================================================

-- The two missing ledger back-references (their four siblings — sale_id,
-- delivery_id, receiving_id from 0073; part_id/engine_id/shop_id from
-- 0045/0073 — already exist).
create index if not exists idx_movements_loss
  on public.stock_movements (loss_id) where loss_id is not null;
create index if not exists idx_movements_return
  on public.stock_movements (return_id) where return_id is not null;

-- Gates loss deletes the same way (a count shortage points at the loss it
-- raised). Grows with every monthly count line.
create index if not exists idx_snapshot_lines_shortage_loss
  on public.count_snapshot_lines (shortage_loss_id)
  where shortage_loss_id is not null;

-- Gates sale deletes (and serves every balance computation's per-sale sum).
create index if not exists idx_utang_payments_sale
  on public.utang_payments (sale_id);

-- Gates engine deletes: a replace-resolution claim points at the on-hand
-- engine it consumed (0070).
create index if not exists idx_warranty_claims_replacement
  on public.warranty_claims (replacement_engine_id)
  where replacement_engine_id is not null;

-- 0086 tables: append-only forever, and their FKs gate part / engine / shop /
-- profile deletes respectively. actor is already indexed (0086); these are the
-- rest. Cheap now, and they also serve the /oversight filters.
create index if not exists idx_floor_attempts_part
  on public.price_floor_attempts (part_id) where part_id is not null;
create index if not exists idx_floor_attempts_engine
  on public.price_floor_attempts (engine_id) where engine_id is not null;
create index if not exists idx_floor_attempts_shop
  on public.price_floor_attempts (shop_id) where shop_id is not null;
create index if not exists idx_credential_events_actor
  on public.credential_events (actor) where actor is not null;
create index if not exists idx_credential_events_subject
  on public.credential_events (subject) where subject is not null;
create index if not exists idx_owner_requests_reviewer
  on public.owner_requests (reviewed_by) where reviewed_by is not null;

-- Gates profile deletes once admin-directed notifications exist (0086).
create index if not exists idx_notifications_recipient_profile
  on public.notifications (recipient_profile_id)
  where recipient_profile_id is not null;
