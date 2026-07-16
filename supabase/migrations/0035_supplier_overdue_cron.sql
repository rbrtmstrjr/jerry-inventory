-- ============================================================================
-- 0035_supplier_overdue_cron.sql — daily overdue sweep for supplier payables.
--
-- Separate migration, same reason as 0032: the function must exist before
-- cron.schedule can reference it.
--
-- 01:15 UTC = 09:15 PH — just after the warranty sweep, so both land before
-- the shops open. Due dates are DATES, so once a day is enough.
-- Re-runnable: unscheduled first if it already exists.
-- ============================================================================

create extension if not exists pg_cron;

do $$ begin
  perform cron.unschedule('supplier-overdue-daily');
exception when others then null;
end $$;

select cron.schedule(
  'supplier-overdue-daily',
  '15 1 * * *',
  $job$select public.fn_check_supplier_overdue()$job$
);
