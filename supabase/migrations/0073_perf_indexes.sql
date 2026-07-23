-- 0073 — performance indexes on child-table FK columns.
--
-- Postgres does NOT auto-index foreign-key columns. At demo scale that was
-- invisible; the 300k-row load test exposed it hard: `sale_lines.sale_id` had
-- NO index (the only sale_lines index, idx_sale_lines_cost, was dropped in
-- 0053), so any per-row aggregation over sale_lines — the `description`
-- string_agg in the `receivables` view, the summary/search_text in
-- `reviewed_items` — became a sequential scan of ~60k rows PER driving row.
-- Two owner pages timed out to EMPTY as a result (Receivables, Approvals →
-- Reviewed History), the errors swallowed by `data ?? []`.
--
-- These are the missing FK indexes on the hot child tables. Non-destructive
-- (create-if-not-exists), and each turns an O(rows) seq scan into an index
-- seek. `utang_payments.sale_id`, `sale_line_costs.sale_id`, and the
-- stock_movements composites (0045) were already indexed and stayed fast — this
-- brings the rest in line.

-- THE critical one: every join/aggregation of a sale's lines.
create index if not exists idx_sale_lines_sale on public.sale_lines (sale_id);
create index if not exists idx_sale_lines_part on public.sale_lines (part_id) where part_id is not null;
create index if not exists idx_sale_lines_engine on public.sale_lines (engine_id) where engine_id is not null;

-- delivery / return / receiving lines — each read by their parent's detail +
-- the reports/deliveries pages (delivery_lines is ~23k rows).
create index if not exists idx_delivery_lines_delivery on public.delivery_lines (delivery_id);
create index if not exists idx_delivery_lines_part on public.delivery_lines (part_id) where part_id is not null;
create index if not exists idx_return_lines_return on public.return_lines (return_id);
create index if not exists idx_receiving_lines_receiving on public.receiving_lines (receiving_id);
create index if not exists idx_delivery_request_lines_req on public.delivery_request_lines (delivery_request_id);

-- stock_movements source-document FKs the movement_journal joins on. part/engine
-- + the (part,shop,time) composites already exist (0001/0045); these cover the
-- per-document lookups (a sale/delivery/receiving's own ledger rows).
create index if not exists idx_movements_shop on public.stock_movements (shop_id);
create index if not exists idx_movements_sale on public.stock_movements (sale_id) where sale_id is not null;
create index if not exists idx_movements_delivery on public.stock_movements (delivery_id) where delivery_id is not null;
create index if not exists idx_movements_receiving on public.stock_movements (receiving_id) where receiving_id is not null;

-- sales/losses submission-queue reads: status + business_date filters.
create index if not exists idx_sales_status on public.sales (status) where deleted_at is null;
create index if not exists idx_sales_business_date on public.sales (business_date) where deleted_at is null;
create index if not exists idx_losses_status on public.losses (status) where deleted_at is null;
