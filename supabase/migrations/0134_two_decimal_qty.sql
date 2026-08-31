-- ---------------------------------------------------------------------------
-- 0134 — quantities become numeric(12,2). This is 0116 again; read that first.
--
-- WHY: a customer buys a quarter kilo. numeric(12,1) refuses 0.25, so the
-- cashier rings 0.2 or 0.3 and is wrong by 50 g either way.
--
-- WHY TWO DECIMALS AND NOT THREE: the migration costs the same either way
-- (same 15 columns, same 9 CHECKs), so the choice is only about which values
-- are valid. Two gives 10 g granularity — every fraction a customer actually
-- asks for. Three would let a cashier record a gram of lead as a kg quantity,
-- which is the false precision the `g` unit (0133) exists to avoid.
--
-- WHAT IS NOT HERE: the PL/pgSQL accumulator sweep of 0117-0121/0124. It is
-- genuinely unnecessary. No variable anywhere is declared numeric(12,1); the
-- accumulators are unconstrained `numeric`, which has no scale limit; and the
-- int/bigint ones that caused 0119/0121/0124 were fixed there. The general
-- argument is the one that matters: anything that still rounds at two decimals
-- ALREADY rounds at one, and tenths have been in production since 0116.
--
-- Grams are untouched — `g` has allows_fractional = false, so fn_assert_qty
-- still refuses 2.5 g. Reorder levels stay integer (a threshold, not a
-- measurement). Money stays integer centavos, rounded per line and stored.
--
-- ⚠️  BEFORE RUNNING THIS ON PRODUCTION:
--   * shops closed — ACCESS EXCLUSIVE locks, and stock_movements (~208k rows)
--     is rewritten. Seconds, but the app is blocked throughout.
--   * run the backup workflow BY HAND and download the artifact first.
--   * prove it on staging with the full suite green first.
--
-- The `add constraint` statements have no `if not exists`. Run this ONCE.
-- ---------------------------------------------------------------------------

do $mig$
declare
  r            record;
  v_before     int;
  v_after      int;
  remaining    int;
  progressed   boolean;
  last_error   text;
begin
  ------------------------------------------------------------------
  -- 1. Snapshot every view in public, with everything a DROP destroys.
  ------------------------------------------------------------------
  create temp table _v_snap on commit drop as
  select
    c.relname::text                                   as view_name,
    pg_get_viewdef(c.oid, true)                       as definition,
    c.reloptions                                      as options,
    obj_description(c.oid, 'pg_class')                as comment,
    (select coalesce(
              array_agg(format('grant %s on public.%I to %I',
                               g.privilege_type, c.relname, g.grantee)),
              '{}')
       from information_schema.role_table_grants g
      where g.table_schema = 'public'
        and g.table_name   = c.relname
        and g.grantee <> current_user)                as grant_stmts
  from pg_class c
  where c.relkind = 'v'
    and c.relnamespace = 'public'::regnamespace;

  select count(*) into v_before from _v_snap;
  raise notice '0134: snapshotted % views', v_before;

  if v_before = 0 then
    raise exception '0134: snapshotted zero views — refusing to continue, '
                    'something is wrong with the catalog query';
  end if;

  ------------------------------------------------------------------
  -- 2. Drop them. CASCADE because views depend on views.
  ------------------------------------------------------------------
  for r in select view_name from _v_snap loop
    execute format('drop view if exists public.%I cascade', r.view_name);
  end loop;

  ------------------------------------------------------------------
  -- 3. The generated column has to go before its inputs can change.
  ------------------------------------------------------------------
  alter table public.delivery_lines drop column if exists qty_outstanding;

  ------------------------------------------------------------------
  -- 4. The tenths CHECKs must go before the values they would reject exist.
  ------------------------------------------------------------------
  alter table public.stock_levels           drop constraint if exists stock_levels_qty_tenths;
  alter table public.sale_lines             drop constraint if exists sale_lines_qty_tenths;
  alter table public.receiving_lines        drop constraint if exists receiving_lines_qty_tenths;
  alter table public.delivery_lines         drop constraint if exists delivery_lines_qty_tenths;
  alter table public.return_lines           drop constraint if exists return_lines_qty_tenths;
  alter table public.losses                 drop constraint if exists losses_qty_tenths;
  alter table public.stock_movements        drop constraint if exists stock_movements_qty_tenths;
  alter table public.delivery_discrepancies drop constraint if exists delivery_discrepancies_qty_tenths;
  alter table public.delivery_request_lines drop constraint if exists delivery_request_lines_qty_tenths;

  ------------------------------------------------------------------
  -- 5. The type change. Widening preserves every existing value: 2.5 stays
  --    2.5, an integer stays an integer. All 15 quantity columns.
  ------------------------------------------------------------------
  alter table public.stock_levels           alter column qty            type numeric(12,2);
  alter table public.sale_lines             alter column qty            type numeric(12,2);
  alter table public.receiving_lines        alter column qty            type numeric(12,2);
  alter table public.delivery_lines         alter column qty            type numeric(12,2);
  alter table public.delivery_lines         alter column qty_received   type numeric(12,2);
  alter table public.delivery_lines         alter column qty_resolved   type numeric(12,2);
  alter table public.delivery_lines         alter column qty_damaged    type numeric(12,2);
  alter table public.return_lines           alter column qty            type numeric(12,2);
  alter table public.return_lines           alter column qty_damaged    type numeric(12,2);
  alter table public.losses                 alter column qty            type numeric(12,2);
  alter table public.stock_movements        alter column qty_change     type numeric(12,2);
  alter table public.count_snapshot_lines   alter column expected_qty   type numeric(12,2);
  alter table public.count_snapshot_lines   alter column counted_qty    type numeric(12,2);
  alter table public.delivery_discrepancies alter column qty            type numeric(12,2);
  alter table public.delivery_request_lines alter column qty_requested  type numeric(12,2);

  ------------------------------------------------------------------
  -- 6. Restore the generated column — same expression as 0028.
  ------------------------------------------------------------------
  alter table public.delivery_lines
    add column qty_outstanding numeric(12,2)
    generated always as (qty - coalesce(qty_received, 0) - qty_resolved) stored;

  ------------------------------------------------------------------
  -- 7. Hundredths only, enforced at rest. Renamed rather than reusing the
  --    _tenths name so a half-applied migration is visible in the catalog.
  ------------------------------------------------------------------
  alter table public.stock_levels           add constraint stock_levels_qty_hundredths           check (qty = round(qty, 2));
  alter table public.sale_lines             add constraint sale_lines_qty_hundredths             check (qty = round(qty, 2));
  alter table public.receiving_lines        add constraint receiving_lines_qty_hundredths        check (qty = round(qty, 2));
  alter table public.delivery_lines         add constraint delivery_lines_qty_hundredths         check (qty = round(qty, 2));
  alter table public.return_lines           add constraint return_lines_qty_hundredths           check (qty = round(qty, 2));
  alter table public.losses                 add constraint losses_qty_hundredths                 check (qty = round(qty, 2));
  alter table public.stock_movements        add constraint stock_movements_qty_hundredths        check (qty_change = round(qty_change, 2));
  alter table public.delivery_discrepancies add constraint delivery_discrepancies_qty_hundredths check (qty = round(qty, 2));
  alter table public.delivery_request_lines add constraint delivery_request_lines_qty_hundredths check (qty_requested = round(qty_requested, 2));

  ------------------------------------------------------------------
  -- 8. Recreate the views. Retry loop: a view whose dependency is not back
  --    yet simply fails and is retried on the next pass.
  ------------------------------------------------------------------
  create temp table _v_todo on commit drop as select * from _v_snap;

  loop
    progressed := false;
    for r in select * from _v_todo loop
      begin
        execute format('create view public.%I as %s', r.view_name, r.definition);

        if r.options is not null then
          execute format('alter view public.%I set (%s)',
                         r.view_name, array_to_string(r.options, ', '));
        end if;

        if r.comment is not null then
          execute format('comment on view public.%I is %L', r.view_name, r.comment);
        end if;

        delete from _v_todo where view_name = r.view_name;
        progressed := true;
      exception when others then
        last_error := sqlerrm;   -- dependency probably not back yet; retry
      end;
    end loop;

    select count(*) into remaining from _v_todo;
    exit when remaining = 0;

    if not progressed then
      raise exception '0134: % view(s) could not be recreated. Last error: %',
                      remaining, last_error;
    end if;
  end loop;

  ------------------------------------------------------------------
  -- 9. Grants. DROP VIEW took them; without this the shop app returns
  --    permission errors on every safe view.
  ------------------------------------------------------------------
  for r in select * from _v_snap loop
    for last_error in select unnest(r.grant_stmts) loop
      execute last_error;
    end loop;
  end loop;

  ------------------------------------------------------------------
  -- 10. The revoke grants cannot express. This is 0122's lesson: Supabase
  --     default privileges re-grant anon on newly created objects, and a
  --     revoke is the ABSENCE of a grant, so nothing restores it for us.
  ------------------------------------------------------------------
  for r in select view_name from _v_snap loop
    execute format('revoke all on public.%I from anon', r.view_name);
  end loop;

  ------------------------------------------------------------------
  -- 11. Prove it. Same view count out as in, reloptions intact.
  ------------------------------------------------------------------
  select count(*) into v_after
    from pg_class
   where relkind = 'v' and relnamespace = 'public'::regnamespace;

  if v_after <> v_before then
    raise exception '0134: view count changed (% -> %). Rolling back.',
                    v_before, v_after;
  end if;

  perform 1
    from _v_snap s
    join pg_class c on c.relname = s.view_name
                   and c.relnamespace = 'public'::regnamespace
   where s.options is distinct from c.reloptions;

  if found then
    raise exception '0134: reloptions (security_barrier) did not survive. '
                    'Rolling back.';
  end if;

  -- Step 10's revoke must have taken on every restored view, not just run.
  perform 1
    from information_schema.role_table_grants
   where table_schema = 'public'
     and grantee = 'anon'
     and table_name in (select view_name from _v_snap);

  if found then
    raise exception '0134: anon still holds a privilege on a restored view. '
                    'Rolling back.';
  end if;

  raise notice '0134: OK — % views restored, quantities are numeric(12,2)', v_after;
end
$mig$;

-- ---------------------------------------------------------------------------
-- fn_assert_qty — THE authority on whether a quantity is legal. Body is 0118's
-- byte-for-byte apart from the decimal depth and its message.
-- ---------------------------------------------------------------------------
create or replace function public.fn_assert_qty(
  p_part_id    uuid,
  p_qty        numeric,
  p_allow_zero boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_name text;
  v_unit text;
  v_frac boolean;
begin
  if p_qty is null then
    raise exception 'Quantity is required';
  end if;

  -- Confirming a delivery may legitimately report zero received.
  if p_qty < 0 or (p_qty = 0 and not p_allow_zero) then
    raise exception 'Quantity must be more than zero';
  end if;

  -- Hundredths only. numeric(12,2) would silently ROUND 0.255 to 0.26; Gerry
  -- asked for it to be refused, and a silent round is a wrong receipt.
  if p_qty <> round(p_qty, 2) then
    raise exception
      'Quantity % has too many decimals — two only, e.g. 0.25 or 2.5', p_qty;
  end if;

  -- Engines pass part_id null and are fixed at 1 by their own CHECK.
  if p_part_id is null then
    return;
  end if;

  select p.name, p.unit, coalesce(u.allows_fractional, false)
    into v_name, v_unit, v_frac
    from public.parts p
    left join public.units u on u.code = p.unit
   where p.id = p_part_id;

  -- The unit decides. Nails are sold by the kilo; spark plugs are not sold in
  -- halves. This is the rule 0114/0115 exist to make trustworthy.
  if not v_frac and p_qty <> round(p_qty, 0) then
    raise exception '% is measured in %, so whole numbers only (you entered %)',
      coalesce(v_name, 'That item'), coalesce(v_unit, 'pieces'), p_qty;
  end if;
end
$fn$;

revoke all on function public.fn_assert_qty(uuid, numeric, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- fmt_qty — must agree with formatQty in lib/format.ts, or a printed document
-- disagrees with the screen it was printed from. Explicit per-depth branches
-- rather than relying on FM's trailing-zero behaviour.
-- ---------------------------------------------------------------------------
create or replace function public.fmt_qty(p_qty numeric)
returns text
language sql
immutable
set search_path = ''
as $fn$
  select case
    when p_qty is null then ''
    when p_qty = round(p_qty)    then trim(to_char(p_qty, 'FM9999999999990'))
    when p_qty = round(p_qty, 1) then trim(to_char(p_qty, 'FM9999999999990.0'))
    else                              trim(to_char(p_qty, 'FM9999999999990.00'))
  end;
$fn$;
comment on function public.fmt_qty(numeric) is
  'Render a quantity for humans: whole numbers without a decimal, tenths with '
  'one, hundredths with two. Use anywhere a quantity is concatenated into text.';

-- ---------------------------------------------------------------------------
-- fn_dashboard_top_products — the 0121 failure mode in a function the
-- 0117-0124 sweep missed, because that sweep followed the stock pipeline and
-- this is a dashboard aggregate. `qty bigint` + `::bigint` rounded every
-- fractional quantity: 2.5 kg sold displayed as 3. Wrong at one decimal too.
-- Body is 0074's byte-for-byte apart from the return type and the cast.
--
-- Dropped first: the RETURNS TABLE type is changing (bigint -> numeric), and
-- `create or replace` cannot change a return type.
-- ---------------------------------------------------------------------------

drop function if exists public.fn_dashboard_top_products(date, date, int);

create or replace function public.fn_dashboard_top_products(
  p_from date,
  p_to date,
  p_limit int default 5
)
returns table (name text, qty numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_owner() then
    raise exception 'Only the owner can read the dashboard';
  end if;

  return query
    select coalesce(sl.description, 'Item') as name, sum(sl.qty) as qty
    from sales s
    join sale_lines sl on sl.sale_id = s.id
    where s.status = 'approved'
      and s.business_date between p_from and p_to
      and s.deleted_at is null
    group by 1
    order by 2 desc
    limit greatest(p_limit, 1);
end $$;

revoke all on function public.fn_dashboard_top_products(date, date, int) from public, anon;
grant execute on function public.fn_dashboard_top_products(date, date, int) to authenticated;
