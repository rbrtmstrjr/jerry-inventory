-- ---------------------------------------------------------------------------
-- 0116 — quantities become numeric(12,1). THE RISKY ONE. Read this header.
--
-- Gerry sells nails, lead, fasteners, welding materials and powders BY THE KILO
-- and customers buy a *tingi*. Quantity therefore has to hold 0.1, 2.3, 10.2 —
-- tenths only, never hundredths.
--
-- WHY numeric AND NOT float: binary floating point cannot represent 0.1
-- exactly. The ledger invariant `Σ movements(product, location) =
-- stock_levels(product, location)` (see CLAUDE.md, asserted by
-- test-movements.mjs) would drift by fractions that accumulate over hundreds of
-- thousands of rows. numeric is exact decimal; the invariant survives to the
-- digit. Do not "optimise" this to real/double precision, ever.
--
-- WHY THIS MIGRATION IS AWKWARD — three obstacles, all unavoidable:
--
--   1. Postgres refuses ALTER COLUMN TYPE while any VIEW depends on the column,
--      and many do (shop_stock, stock_in_transit, movement_journal, the slips…).
--   2. delivery_lines.qty_outstanding is a GENERATED column over qty; a
--      generated column blocks altering what it reads.
--   3. Dropping a view silently discards its GRANTS and its reloptions —
--      including `security_barrier`, which the shop-facing safe views rely on.
--      Recreating them without it would weaken RLS with nothing failing loudly.
--
-- HOW IT HANDLES THEM: it snapshots every view in `public` FROM THE LIVE
-- DATABASE (definition, reloptions, grants, comment), drops them, alters the
-- columns, then restores them. Capturing from the catalog rather than
-- reconstructing from migration files is deliberate: several views were
-- redefined more than once (shop_stock in 0053 then 0064), and hand-rewriting
-- them risks silently reverting a later fix.
--
-- Recreation uses a retry loop rather than a computed topological order —
-- views depend on other views (shop_low_stock_safe on shop_low_stock), and
-- retrying until no further progress is both shorter and harder to get wrong
-- than a dependency sort.
--
-- It is ONE `do` block, so it is ATOMIC however it is run: SQL editor or CLI,
-- a failure anywhere rolls the whole thing back. There is no half-migrated
-- state to clean up.
--
-- ⚠️  BEFORE RUNNING THIS ON PRODUCTION:
--   * shops closed — it takes ACCESS EXCLUSIVE locks and rewrites
--     stock_movements (~208k rows). Seconds, but the app is blocked throughout.
--   * run the backup workflow BY HAND and download the artifact first. This is
--     the only migration in the project's history that rewrites the ledger.
--   * prove it on staging, with the full suite green, first.
--
-- Reorder levels are deliberately NOT touched. Gerry asked for whole-number
-- thresholds ("alert me at 5 kg", not 5.5), so parts.reorder_level and
-- shop_reorder_levels stay integer.
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
  raise notice '0116: snapshotted % views', v_before;

  if v_before = 0 then
    raise exception '0116: snapshotted zero views — refusing to continue, '
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
  -- 4. The type change itself. numeric(12,1) = up to 11 integer digits and
  --    exactly one decimal. Existing integers become x.0, values preserved.
  ------------------------------------------------------------------
  alter table public.stock_levels        alter column qty           type numeric(12,1);
  alter table public.sale_lines          alter column qty           type numeric(12,1);
  alter table public.receiving_lines     alter column qty           type numeric(12,1);
  alter table public.delivery_lines      alter column qty           type numeric(12,1);
  alter table public.delivery_lines      alter column qty_received  type numeric(12,1);
  alter table public.delivery_lines      alter column qty_resolved  type numeric(12,1);
  alter table public.delivery_lines      alter column qty_damaged   type numeric(12,1);
  alter table public.return_lines        alter column qty           type numeric(12,1);
  alter table public.return_lines        alter column qty_damaged   type numeric(12,1);
  alter table public.losses              alter column qty           type numeric(12,1);
  alter table public.stock_movements     alter column qty_change    type numeric(12,1);
  alter table public.count_snapshot_lines alter column expected_qty type numeric(12,1);
  alter table public.count_snapshot_lines alter column counted_qty  type numeric(12,1);

  ------------------------------------------------------------------
  -- 5. Restore the generated column — same expression as 0028.
  ------------------------------------------------------------------
  alter table public.delivery_lines
    add column qty_outstanding numeric(12,1)
    generated always as (qty - coalesce(qty_received, 0) - qty_resolved) stored;

  ------------------------------------------------------------------
  -- 6. Tenths only, enforced at rest.
  --
  --    numeric(12,1) ROUNDS 0.12 to 0.1 rather than rejecting it, which is not
  --    what Gerry asked for — so these CHECKs make the rule true regardless of
  --    caller, and 0117 raises a readable error before it ever gets here.
  ------------------------------------------------------------------
  alter table public.stock_levels        add constraint stock_levels_qty_tenths        check (qty = round(qty, 1));
  alter table public.sale_lines          add constraint sale_lines_qty_tenths          check (qty = round(qty, 1));
  alter table public.receiving_lines     add constraint receiving_lines_qty_tenths     check (qty = round(qty, 1));
  alter table public.delivery_lines      add constraint delivery_lines_qty_tenths      check (qty = round(qty, 1));
  alter table public.return_lines        add constraint return_lines_qty_tenths        check (qty = round(qty, 1));
  alter table public.losses              add constraint losses_qty_tenths              check (qty = round(qty, 1));
  alter table public.stock_movements     add constraint stock_movements_qty_tenths     check (qty_change = round(qty_change, 1));

  ------------------------------------------------------------------
  -- 7. Recreate the views. Retry loop: a view whose dependency has not been
  --    recreated yet simply fails and is retried on the next pass.
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
      raise exception '0116: % view(s) could not be recreated. Last error: %',
                      remaining, last_error;
    end if;
  end loop;

  ------------------------------------------------------------------
  -- 8. Grants. DROP VIEW took them; without this the shop app starts
  --    returning permission errors on every safe view.
  ------------------------------------------------------------------
  for r in select * from _v_snap loop
    for last_error in select unnest(r.grant_stmts) loop
      execute last_error;
    end loop;
  end loop;

  ------------------------------------------------------------------
  -- 9. Prove it. Same number of views out as in, and security_barrier intact.
  ------------------------------------------------------------------
  select count(*) into v_after
    from pg_class
   where relkind = 'v' and relnamespace = 'public'::regnamespace;

  if v_after <> v_before then
    raise exception '0116: view count changed (% -> %). Rolling back.',
                    v_before, v_after;
  end if;

  perform 1
    from _v_snap s
    join pg_class c on c.relname = s.view_name
                   and c.relnamespace = 'public'::regnamespace
   where s.options is distinct from c.reloptions;

  if found then
    raise exception '0116: reloptions (security_barrier) did not survive. '
                    'Rolling back.';
  end if;

  raise notice '0116: OK — % views restored, quantities are numeric(12,1)', v_after;
end
$mig$;
