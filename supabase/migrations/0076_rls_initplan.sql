-- 0076 — wrap auth-helper calls in RLS policies with (select …), so Postgres
-- evaluates them ONCE per query (an InitPlan) instead of once per row.
--
-- THE PROBLEM (confirmed by measurement): a policy like
--     using (public.is_owner() or shop_id = public.auth_shop_id())
-- calls is_owner() for EVERY row scanned. Counting pending sales therefore fired
-- ~29,000 is_owner() lookups and forced a sequential scan — 2.3s for the owner
-- vs 270ms bypassing RLS. It is O(rows): ~10s at five years, and it slows every
-- owner query that filters/counts a big table (sales, sale_lines, stock_movements).
--
-- THE FIX (documented Supabase best practice): wrap the STABLE auth helpers in a
-- scalar subquery — `(select public.is_owner())` — which the planner hoists into
-- an InitPlan, evaluates a single time, and treats as a constant, so the index
-- gets used. Logic and security are IDENTICAL; only evaluation frequency changes.
--
-- This does it for EVERY policy in the public schema that references one of the
-- three helpers, by REWRITING THE LIVE POLICY DEFINITIONS (pg_policies) — so it
-- can never drift from whatever the policies actually are now, across all the
-- migrations that defined and redefined them. Storage-schema policies are not
-- touched. Idempotent: re-running is a no-op once applied. test-rls proves the
-- access rules are byte-for-byte unchanged.

do $$
declare
  r record;
  v_qual text;
  v_check text;
  v_cmd text;
  v_roles text;
  v_sql text;
  v_count int := 0;
begin
  -- already applied? sales_select would carry the wrapped form. Postgres
  -- re-renders `(select public.is_owner())` as `( SELECT is_owner())` (schema
  -- dropped, keyword upper-cased), so match on the subquery shape, not literal.
  if exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'sales' and policyname = 'sales_select'
      and qual ~* '\(\s*select\s+(public\.)?is_owner'
  ) then
    raise notice '0076 already applied — nothing to do';
    return;
  end if;

  for r in
    select schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (
        qual ~ '(is_owner|auth_shop_id)\s*\(\s*\)' or qual ~ 'auth\.uid\s*\(\s*\)'
        or with_check ~ '(is_owner|auth_shop_id)\s*\(\s*\)' or with_check ~ 'auth\.uid\s*\(\s*\)'
      )
  loop
    v_qual := r.qual;
    v_check := r.with_check;

    -- wrap the three helpers wherever they appear, using each expression's own text
    if v_qual is not null then
      v_qual := regexp_replace(v_qual, '(public\.)?is_owner\(\s*\)', '(select public.is_owner())', 'g');
      v_qual := regexp_replace(v_qual, '(public\.)?auth_shop_id\(\s*\)', '(select public.auth_shop_id())', 'g');
      v_qual := regexp_replace(v_qual, 'auth\.uid\(\s*\)', '(select auth.uid())', 'g');
    end if;
    if v_check is not null then
      v_check := regexp_replace(v_check, '(public\.)?is_owner\(\s*\)', '(select public.is_owner())', 'g');
      v_check := regexp_replace(v_check, '(public\.)?auth_shop_id\(\s*\)', '(select public.auth_shop_id())', 'g');
      v_check := regexp_replace(v_check, 'auth\.uid\(\s*\)', '(select auth.uid())', 'g');
    end if;

    v_cmd := lower(r.cmd);                              -- SELECT|INSERT|UPDATE|DELETE|ALL
    v_roles := array_to_string(r.roles, ', ');          -- e.g. authenticated

    execute format('drop policy %I on public.%I', r.policyname, r.tablename);

    v_sql := format('create policy %I on public.%I as %s for %s to %s',
                    r.policyname, r.tablename, lower(r.permissive), v_cmd, v_roles);
    if v_qual is not null then
      v_sql := v_sql || format(' using (%s)', v_qual);
    end if;
    if v_check is not null then
      v_sql := v_sql || format(' with check (%s)', v_check);
    end if;

    execute v_sql;
    v_count := v_count + 1;
  end loop;

  raise notice '0076 rewrote % policies with (select …) InitPlan wrapping', v_count;
end $$;
