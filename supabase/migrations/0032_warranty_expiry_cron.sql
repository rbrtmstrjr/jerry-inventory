-- ============================================================================
-- 0032_warranty_expiry_cron.sql — schedule the daily near-expiry check.
--
-- Separate from 0031 on purpose: the extension has to exist (and the function
-- has to be created) before cron.schedule can reference them.
--
-- 01:00 UTC = 09:00 Philippine time — a morning check, so alerts are waiting
-- when the shops open. Warranties expire on a DATE, so once a day is enough;
-- there is no need to evaluate expiry on every request.
--
-- Re-runnable: the job is unscheduled first if it already exists.
-- ============================================================================

create extension if not exists pg_cron;

do $$ begin
  perform cron.unschedule('warranty-expiry-daily');
exception when others then null;  -- not scheduled yet
end $$;

select cron.schedule(
  'warranty-expiry-daily',
  '0 1 * * *',
  $job$select public.fn_check_warranty_expiry()$job$
);
