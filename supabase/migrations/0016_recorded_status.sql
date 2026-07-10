-- ============================================================================
-- 0016_recorded_status.sql — new first stage for shop submissions.
-- 'recorded' = saved at the shop, NOT yet sent to the owner. The shop batches
-- recorded items to the owner ("submit") whenever it chooses.
-- (Kept as its own migration: a new enum value can't be used in the same
--  transaction that adds it.)
-- ============================================================================
alter type public.submission_status add value if not exists 'recorded' before 'pending';
