-- 0110 — Targeted indexes for the two heavy fn_dashboard_summary sub-aggregates.
--
-- At the 3-year dataset (41k sales, 208k stock_movements) fn_dashboard_summary
-- ran ~765ms warm / ~1653ms cold. Sub-query timing pinned the cost to two
-- computed views it counts over:
--   • shop_low_stock  ~699ms — its engine arm is shops×engine_models LEFT JOIN
--     engines(status='delivered'); with no index on (engine_model_id, shop_id)
--     each group re-scanned engines.
--   • receivables (balance>0)  ~566ms — filters sales to payment_type='partial'
--     with no index on payment_type → seq scan of all 41k sales.
-- These indexes are additive and change NO query results — verification is
-- purely re-timing. They also speed the nav badges, /stock-alerts, /receivables,
-- and /shop/low-stock, which read the same views.

-- receivables: find the partial (utang) sales without scanning every sale.
create index if not exists idx_sales_partial
  on public.sales (id)
  where payment_type = 'partial' and deleted_at is null;

-- shop_low_stock engine arm: per (model, shop) delivered-engine counts.
create index if not exists idx_engines_model_shop_delivered
  on public.engines (engine_model_id, shop_id)
  where status = 'delivered' and deleted_at is null;

-- shop_low_stock parts arm: the stock_levels→parts join + reorder lookups.
create index if not exists idx_stock_levels_part
  on public.stock_levels (part_id);

create index if not exists idx_shop_reorder_part
  on public.shop_reorder_levels (shop_id, part_id)
  where deleted_at is null;

create index if not exists idx_shop_reorder_model
  on public.shop_reorder_levels (shop_id, engine_model_id)
  where deleted_at is null;
