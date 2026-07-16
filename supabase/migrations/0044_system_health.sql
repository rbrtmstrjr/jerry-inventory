-- ---------------------------------------------------------------------------
-- 0044 — System health: pg_cron job status for the Settings → System panel
--
-- WHY A FUNCTION AND NOT A VIEW/DIRECT READ:
-- PostgREST only exposes the `public` schema; `cron.job` and
-- `cron.job_run_details` are unreachable from the client (verified against the
-- live DB — both fail schema-cache lookup). test-shop-warranties.mjs already
-- notes this, which is why the pg_cron schedule itself is asserted in SQL.
-- A SECURITY DEFINER function in `public` is the only route.
--
-- THE POINT OF THE PANEL:
-- Two daily jobs raise the alerts this business runs on — warranty-expiry-daily
-- (01:00 UTC = 09:00 PH) and supplier-overdue-daily (01:15 UTC). If either dies
-- the alerts simply stop, silently, and nobody finds out until a warranty
-- lapses or a supplier calls. `stale` is the whole reason this exists.
--
-- WHAT IT DELIBERATELY DOES NOT RETURN:
--   • cron.job.command — a scheduled job's SQL is a well-known place for a
--     service key to live (the pg_net + service-role pattern). Never expose it.
--   • cron.job_run_details.return_message — an error can echo the failing
--     command back, which lands you in the same place. Status is the "last
--     result" the panel needs; the message is not worth the leak surface.
-- Nothing here can be written, and nothing here is a secret.
-- ---------------------------------------------------------------------------

create or replace function public.fn_cron_job_health()
returns table (
  jobname     text,
  schedule    text,
  active      boolean,
  last_run_at timestamptz,
  last_status text,
  stale       boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Definer + no role check is exactly the hole 0042 closed on the
  -- contribution functions. Re-check the caller.
  if not public.is_owner() then
    raise exception 'Only the owner can read system health';
  end if;

  return query
  select
    j.jobname::text,
    j.schedule::text,
    j.active,
    d.start_time,
    d.status::text,
    -- A disabled job is not "stale" — it is off, which is its own signal and is
    -- reported through `active`. Staleness is only meaningful for a job that is
    -- supposed to be running. Both jobs here are daily, so 24h is the bar.
    (j.active and (d.start_time is null or d.start_time < now() - interval '24 hours'))
  from cron.job j
  left join lateral (
    select r.start_time, r.status
    from cron.job_run_details r
    where r.jobid = j.jobid
    order by r.start_time desc
    limit 1
  ) d on true
  order by j.jobname;
end;
$$;

comment on function public.fn_cron_job_health() is
  'Owner-only diagnostic for Settings → System: per-job schedule, active flag,
   last run time, last status, and a >24h stale flag. Returns no job command and
   no run message — both can carry secrets. Read-only.';

revoke all on function public.fn_cron_job_health() from public, anon;
grant execute on function public.fn_cron_job_health() to authenticated;
