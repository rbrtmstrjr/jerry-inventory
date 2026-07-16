-- ============================================================================
-- 0027_transit_enums.sql — enum values for the delivery-confirmation flow.
--
-- Kept in its OWN migration on purpose: Postgres will not let a newly added
-- enum value be USED in the same transaction that adds it (same reason 0016
-- stands alone). 0028/0029 then use these freely.
--
--  engine_status.in_transit  — sent, not yet confirmed by the shop
--  movement_type.transit_return   — owner recovered in-transit stock to master
--  movement_type.transit_writeoff — stock lost BETWEEN master and shop
--    (deliberately distinct from 'loss' at a shop and from 'return', so
--     reports can answer "is stock disappearing in transit?")
-- ============================================================================

alter type public.engine_status add value if not exists 'in_transit' after 'in_master';
alter type public.movement_type add value if not exists 'transit_return';
alter type public.movement_type add value if not exists 'transit_writeoff';
