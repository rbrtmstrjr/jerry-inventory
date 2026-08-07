-- ---------------------------------------------------------------------------
-- 0125 — the two quantity columns 0116 missed. Completes the fractional series.
--
--     delivery_discrepancies.qty
--     delivery_request_lines.qty_requested
--
-- HOW THEY WERE MISSED, because the mechanism matters more than the fix: 0116's
-- column list was taken from the plan doc's inventory table, and that table was
-- built by listing the tables in the STOCK PIPELINE. Both of these hang off the
-- pipeline rather than sitting in it — one is an audit trail, one is a request
-- that has not moved anything yet — so neither was in the list, and neither is
-- named anywhere in 0116 or in the plan.
--
-- Grepping the schema for quantity columns (rather than reasoning about which
-- tables "carry stock") finds both immediately. That is the check that should
-- have run.
--
-- WHY IT MATTERS
--
-- 1. delivery_discrepancies.qty — `int not null check (qty > 0)`.
--    fn_resolve_delivery_discrepancy books the stock movement with the numeric
--    p_qty and THEN writes this audit row, in one transaction. So:
--
--      qty < 0.5   rounds to 0, the CHECK fires, the whole resolve ROLLS BACK.
--                  A 0.4 kg shortfall can NEVER be resolved: the delivery is
--                  stuck in `discrepancy` and the 0.4 is stranded in transit
--                  forever, with no UI path out. Found by driving the actual
--                  Resolve dialog; the RPC-level suite never resolves one.
--
--      qty >= 0.5  rounds to the nearest whole number and SUCCEEDS. The ledger
--                  moves 1.4 while the audit trail records 1. The two records
--                  of the same decision disagree, silently, forever. This is
--                  the worse half.
--
-- 2. delivery_request_lines.qty_requested — `int not null check (> 0)`.
--    fn_create_delivery_request already parses `qty_requested numeric` (0120)
--    and validates it, then inserts into this int column. A shop asking for
--    2.5 kg of nails silently files a request for 3; asking for 0.4 is refused
--    with a constraint error that names nothing the shop can act on.
--
-- Reorder levels stay integer on purpose (Gerry: "alert me at 5 kg, not 5.5") —
-- shop_reorder_levels and parts.reorder_level are NOT touched here.
--
-- THE VIEW: shop_delivery_request_lines (0081) selects qty_requested, so
-- Postgres refuses the ALTER while it exists. It is snapshotted FROM THE LIVE
-- CATALOG and restored, for 0116's reason: reconstructing a view from migration
-- text risks silently reverting a later redefinition. Grants, reloptions
-- (security_barrier) AND the anon revoke are all restored — the anon revoke is
-- the 0122 lesson: Supabase's default privileges re-grant anon on any newly
-- created object, so a recreated view comes back anon-readable unless you
-- explicitly take it away again.
--
-- delivery_discrepancies has no dependent view and no generated column, so it
-- is a plain ALTER.
--
-- Safe to run while the shops are open: both tables are small and neither is on
-- the hot read path.
-- ---------------------------------------------------------------------------

do $mig$
declare
  v_def      text;
  v_opts     text[];
  v_comment  text;
  v_grants   text[];
  g          text;
begin
  ------------------------------------------------------------------
  -- 1. delivery_discrepancies.qty — no dependents, straight through.
  ------------------------------------------------------------------
  alter table public.delivery_discrepancies
    alter column qty type numeric(12,1);

  alter table public.delivery_discrepancies
    drop constraint if exists delivery_discrepancies_qty_tenths;
  alter table public.delivery_discrepancies
    add constraint delivery_discrepancies_qty_tenths check (qty = round(qty, 1));

  ------------------------------------------------------------------
  -- 2. Snapshot the one dependent view before touching its column.
  ------------------------------------------------------------------
  select pg_get_viewdef(c.oid, true),
         c.reloptions,
         obj_description(c.oid, 'pg_class'),
         (select coalesce(
                   array_agg(format('grant %s on public.%I to %I',
                                    g2.privilege_type, c.relname, g2.grantee)),
                   '{}')
            from information_schema.role_table_grants g2
           where g2.table_schema = 'public'
             and g2.table_name   = c.relname
             and g2.grantee <> current_user)
    into v_def, v_opts, v_comment, v_grants
    from pg_class c
   where c.relname = 'shop_delivery_request_lines'
     and c.relnamespace = 'public'::regnamespace
     and c.relkind = 'v';

  if v_def is null then
    raise exception '0125: shop_delivery_request_lines not found — refusing to '
                    'continue rather than drop a column a view may still need';
  end if;

  drop view public.shop_delivery_request_lines;

  ------------------------------------------------------------------
  -- 3. The column.
  ------------------------------------------------------------------
  alter table public.delivery_request_lines
    alter column qty_requested type numeric(12,1);

  alter table public.delivery_request_lines
    drop constraint if exists delivery_request_lines_qty_tenths;
  alter table public.delivery_request_lines
    add constraint delivery_request_lines_qty_tenths
    check (qty_requested = round(qty_requested, 1));

  ------------------------------------------------------------------
  -- 4. Put the view back exactly as it was: definition, reloptions,
  --    comment, grants — and then the revoke that grants cannot express.
  ------------------------------------------------------------------
  execute format('create view public.shop_delivery_request_lines as %s', v_def);

  if v_opts is not null then
    execute format('alter view public.shop_delivery_request_lines set (%s)',
                   array_to_string(v_opts, ', '));
  end if;

  if v_comment is not null then
    execute format('comment on view public.shop_delivery_request_lines is %L',
                   v_comment);
  end if;

  foreach g in array v_grants loop
    execute g;
  end loop;

  -- 0122: a newly created view picks up Supabase's default privileges, so anon
  -- comes back unless it is explicitly revoked. A revoke is the ABSENCE of a
  -- grant and cannot be snapshotted, so it is restated here rather than restored.
  revoke all on public.shop_delivery_request_lines from anon;

  ------------------------------------------------------------------
  -- 5. Prove it, rather than trusting the steps above.
  ------------------------------------------------------------------
  perform 1
    from pg_class c
   where c.relname = 'shop_delivery_request_lines'
     and c.relnamespace = 'public'::regnamespace
     and c.relkind = 'v'
     and c.reloptions is not distinct from v_opts;

  if not found then
    raise exception '0125: the view did not come back with its reloptions '
                    '(security_barrier). Rolling back.';
  end if;

  perform 1
    from information_schema.role_table_grants
   where table_schema = 'public'
     and table_name = 'shop_delivery_request_lines'
     and grantee = 'anon';

  if found then
    raise exception '0125: anon still holds a privilege on '
                    'shop_delivery_request_lines. Rolling back.';
  end if;

  raise notice '0125: OK — delivery_discrepancies.qty and '
               'delivery_request_lines.qty_requested are numeric(12,1)';
end
$mig$;
