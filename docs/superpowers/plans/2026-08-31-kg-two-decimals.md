# Two-Decimal Quantities (0134) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a cashier ring up a quarter kilo — quantities go from `numeric(12,1)` to `numeric(12,2)` end to end, and the Dashboard stops rounding fractional quantities.

**Architecture:** One atomic migration (`0134`) modelled line-for-line on `0116`: snapshot every view in `public`, drop them, widen 15 quantity columns, rebuild the `qty_outstanding` generated column, swap 9 `_tenths` CHECKs for `_hundredths`, restore views with their grants / reloptions / `anon` revoke, and verify before committing. Then the three app layers in front of the database each go from one decimal to two — depth only, no layer learns a new rule. `units.allows_fractional` remains the sole authority on *which* products may be split.

**Tech Stack:** Postgres (Supabase), PL/pgSQL, Next.js 16 / React 19 / TypeScript, Zod, plain-Node test scripts (`scripts/test-*.mjs`), Playwright QA (`scripts/qa-browser/`).

## Global Constraints

- **Never `git commit` or `git push`.** The user performs every commit themselves. Tasks end with a verification step, never a commit step.
- **Never apply a migration.** The user runs SQL by hand in the Supabase SQL editor. The plan writes the `.sql` file and stops.
- **Staging only.** `.env.local` must read `SUPABASE_ENV=staging`; `scripts/_env-guard.mjs` refuses anything else. Never point a script at production.
- **Branch:** `feat/kg-two-decimals`, already created from `origin/main` (92b6308).
- **Code comments: two lines maximum**, concise. Detail belongs in this plan and in the migration header, not scattered through the code.
- **Precision is exactly two decimals.** `0.25` accepted, `0.255` refused. Never three.
- **Grams are untouched.** `g` keeps `allows_fractional = false`.
- Files use **CRLF** line endings. An edit written with LF will silently fail to match.
- `numeric`, never float. The ledger invariant `Σ movements = stock_levels` is an equality.

---

### Task 1: Migration `0134` — widen the columns and fix the dashboard

**Files:**
- Create: `supabase/migrations/0134_two_decimal_qty.sql`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: `fn_assert_qty(uuid, numeric, boolean)` refusing anything beyond two decimals; `fmt_qty(numeric)` rendering up to two; `fn_dashboard_top_products(date, date, int)` returning `qty numeric` instead of `bigint`. Tasks 2 and 4 depend on those behaviours.

**Context you need before writing a line of this:**

Read `supabase/migrations/0116_fractional_qty.sql` in full. This migration is that one with `1` changed to `2`, and it must be produced by copying it, not by writing a new one from memory. Three obstacles make it awkward and all three are already solved there:

1. Postgres refuses `ALTER COLUMN TYPE` while a view depends on the column, and many views do.
2. `delivery_lines.qty_outstanding` is a GENERATED column over `qty`, which blocks altering its input.
3. `DROP VIEW` silently discards grants **and** reloptions — including `security_barrier`, which the shop-facing safe views rely on for RLS. Restoring them is the migration, not an afterthought. `0122` exists because `0116` restored grants but not the `anon` revoke, and `public_settings` briefly leaked.

Two columns are in the list that `0116` missed and `0125` had to add later: `delivery_discrepancies.qty` and `delivery_request_lines.qty_requested`. They are here because the column list was built by grepping the schema for quantity columns. Do not re-derive the list by reasoning about which tables carry stock — that reasoning is what missed them.

- [ ] **Step 1: Write the migration file**

Create `supabase/migrations/0134_two_decimal_qty.sql` with exactly this content:

```sql
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
-- ---------------------------------------------------------------------------
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
```

- [ ] **Step 2: Verify the column list is complete**

`fn_dashboard_top_products` changes its return type. Postgres refuses
`create or replace` when a function's OUT columns change, so if the apply fails
with *"cannot change return type of existing function"*, add this line
immediately before that `create or replace`:

```sql
drop function if exists public.fn_dashboard_top_products(date, date, int);
```

Then confirm no quantity column was missed:

Run:
```bash
grep -c "type numeric(12,2)" supabase/migrations/0134_two_decimal_qty.sql
grep -c "_hundredths" supabase/migrations/0134_two_decimal_qty.sql
```
Expected: `15` and `9` — fifteen widened columns and nine new CHECK
constraints. (`grep -c` counts matching LINES; the drop statements use the old
`_tenths` names, so they do not appear in the second count.)

Also confirm the drops match the adds:

```bash
grep -c "_tenths" supabase/migrations/0134_two_decimal_qty.sql
```
Expected: `9`. A mismatch between these two numbers means a constraint is
dropped and never re-added, or added while its predecessor still stands.

- [ ] **Step 3: Verify the file parses as one atomic unit**

Read the file top to bottom and confirm:
- exactly one `do $mig$ … end $mig$;` block, and every `alter table` for the widening is inside it
- the four `create or replace function` statements are **outside** the `do` block (they are separate statements and that is correct)
- no `if not exists` on any `add constraint`

Expected: all three true. There is nothing to run yet — the user applies this.

---

### Task 2: The app's three validation layers go to two decimals

**Files:**
- Modify: `scripts/test-lib-unit.mjs` (assertions first)
- Modify: `lib/format.ts:22-35` (`formatQty`, `sanitizeQtyInput`), `lib/format.ts:46-61` (`parseQty`)
- Modify: `lib/qty-schema.ts:13-18`

**Interfaces:**
- Consumes: nothing at runtime — this is pure JS and needs no database, so it can be done while the user applies Task 1.
- Produces: `parseQty(input, {allowFractional, allowZero})` accepting one or two decimals; `sanitizeQtyInput(raw)` keeping two; `formatQty(qty)` rendering up to two with trailing zeros trimmed; `qtySchema({allowZero})` accepting hundredths. Task 3's dialogs and Task 4's static scan rely on these names and signatures, which are unchanged.

**Why each layer changes depth only:** the three layers deliberately allow a
fraction on *every* product and let `fn_assert_qty` refuse it by name, because
only the database knows the unit. Two places enforcing one business rule is how
they drift apart. Do not add a unit check to any of these.

- [ ] **Step 1: Write the failing assertions**

In `scripts/test-lib-unit.mjs`, replace the three rejection lines in the
`parseQty` block (currently lines 72-74) with:

```js
eq("'0.25' accepted (the quarter kilo)", parseQty("0.25", { allowFractional: true }), 0.25);
eq("'0.05' accepted (10 g granularity)", parseQty("0.05", { allowFractional: true }), 0.05);
eq("'1.25' accepted", parseQty("1.25", { allowFractional: true }), 1.25);
eq("'0.255' rejected (3dp)", parseQty("0.255", { allowFractional: true }), null);
eq("'1.005' rejected (3dp)", parseQty("1.005", { allowFractional: true }), null);
```

Replace the `'.12' still rejected (2dp)` line (currently line 101) with:

```js
eq("'.25' normalised", parseQty(".25", { allowFractional: true }), 0.25);
eq("'.255' still rejected (3dp)", parseQty(".255", { allowFractional: true }), null);
```

In the `formatQty` block (after the existing `0.1` assertion) add:

```js
eq("0.25", formatQty(0.25), "0.25");
eq("0.05", formatQty(0.05), "0.05");
// trailing zeros are trimmed — 0.50 must not read "0.50" beside a "0.5" elsewhere
eq("0.5 not '0.50'", formatQty(0.5), "0.5");
eq("1.2 not '1.20'", formatQty(1.2), "1.2");
```

In the `sanitizeQtyInput` block replace the masking assertion (line 147) with:

```js
eq("'0.25' keeps two decimals", sanitizeQtyInput("0.25"), "0.25");
eq("'0.255' masks the 3rd decimal", sanitizeQtyInput("0.255"), "0.25");
eq("'1.2.3' keeps one dot", sanitizeQtyInput("1.2.3"), "1.23");
```

In the `qtySchema` block replace the `0.12 rejected` line with:

```js
check("0.25 accepted (the quarter kilo)", okQ(0.25) === true);
check("0.05 accepted", okQ(0.05) === true);
// 0.29 * 100 is 28.999999999999996 — an exact check would reject what the
// database accepts, so the tolerance is not optional.
check("0.29 accepted despite the IEEE-754 artifact", okQ(0.29) === true);
check("0.255 rejected", okQ(0.255) === false);
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/test-lib-unit.mjs`
Expected: FAIL — several lines report `got null` for `0.25`, `got 0.2` for the
sanitiser, and `got 0.3` for `formatQty(0.25)`.

- [ ] **Step 3: Widen the three helpers**

In `lib/format.ts`, replace `formatQty`'s return (line 26):

```ts
  if (Number.isInteger(n)) return String(n);
  // Two decimals, trailing zeros trimmed, so 0.5 never renders "0.50" beside a
  // "0.5" elsewhere. toFixed also absorbs the float artifact this exists for.
  return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
```

Replace `sanitizeQtyInput`'s return (line 34):

```ts
  return rest.length ? `${whole}.${rest.join("").slice(0, 2)}` : whole;
```

Replace `parseQty`'s regex line (line 55):

```ts
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null; // hundredths — 0.255 refused
```

Update the two doc comments that say "one decimal" (lines 29 and 44) to say
"two decimals". Keep them to two lines.

In `lib/qty-schema.ts`, replace the final `.refine` (lines 14-18):

```ts
    // Hundredths only. The tolerance is not optional — 0.29 * 100 is
    // 28.999999999999996 in IEEE-754, so an exact check would reject 0.29.
    .refine(
      (n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9,
      "Quantity can have at most two decimals — e.g. 0.25 or 2.5"
    );
```

Update its header comment's "tenths" reference to "hundredths".

- [ ] **Step 4: Run to verify it passes**

Run: `node scripts/test-lib-unit.mjs`
Expected: PASS, zero failures. Every pre-existing assertion (`0.1`, `2.3`,
`10.2`, `.1` normalisation, `2.` normalisation, the `0.1 + 0.2` float artifact,
`2.3 * 3`) must still pass — those are the 2026-08-10 production bug's
regression guards and none of them should have changed.

- [ ] **Step 5: Verify nothing else in the app hardcodes one decimal**

Run:
```bash
grep -rn "slice(0, 1)\|toFixed(1)" lib components app --include=*.ts --include=*.tsx
```
Expected: three hits, all unrelated to quantity — `app/(owner)/reports/pnl-view.tsx`
(a percentage), `lib/product-image.ts` (megabytes), `components/confetti-burst.tsx`
(pixels). If any hit is in `lib/format.ts`, Step 3 was incomplete.

---

### Task 3: Sweep the user-facing one-decimal copy and form regexes

**Files:**
- Modify: `app/(owner)/master-inventory/add-product-dialog.tsx:54`
- Modify: `app/(owner)/master-inventory/correct-stock-dialog.tsx:116`
- Modify: `app/(shop)/shop/record-sale/record-sale-form.tsx:1155-1160`

**Interfaces:**
- Consumes: `parseQty` / `sanitizeQtyInput` from Task 2 (signatures unchanged).
- Produces: no new exports. This is copy and one regex.

**Why this is its own task:** these three sites each carry their *own* copy of
the rule in a message or a regex, so Task 2's helpers do not fix them. A message
that still says "one decimal" while the box accepts two is the silent-refusal
family of bug that cost a real stock discrepancy on 2026-08-10.

- [ ] **Step 1: Fix the Add-product quantity regex**

In `app/(owner)/master-inventory/add-product-dialog.tsx` line 54, replace:

```tsx
    qty: z.string().regex(/^\d*(\.\d)?$/, "Up to one decimal, e.g. 2.5"),
```

with:

```tsx
    qty: z.string().regex(/^\d*(\.\d{1,2})?$/, "Up to two decimals, e.g. 0.25"),
```

- [ ] **Step 2: Fix the Correct-stock hint**

In `app/(owner)/master-inventory/correct-stock-dialog.tsx` line 116, replace:

```tsx
                  Enter a quantity with at most one decimal, e.g. 0.5 or 2.3.
```

with:

```tsx
                  Enter a quantity with at most two decimals, e.g. 0.25 or 2.5.
```

- [ ] **Step 3: Fix the Record-sale refusal message**

In `app/(shop)/shop/record-sale/record-sale-form.tsx`, in `commitQty`, replace
the fractional arm of the message (line 1159):

```tsx
          ? `Enter a quantity like 0.25 or 2.5 — kept ${formatQty(line.qty)} ${line.unit}`
```

Leave the whole-unit arm (`is sold in whole numbers`) exactly as it is — that
branch is correct and its comment above explains why the example must match the
unit. Update that comment's example if it names `0.5`.

- [ ] **Step 4: Verify no one-decimal copy remains**

Run:
```bash
grep -rn "one decimal\|0.5 or 2.3" app lib components --include=*.ts --include=*.tsx
```
Expected: zero hits.

- [ ] **Step 5: Verify the app still compiles**

Run: `npx tsc --noEmit`
Expected: no errors. (Pre-existing errors unrelated to these three files are
acceptable — compare against `git stash`-ing the change if unsure.)

---

### GATE: the user applies `0134` to staging

**This is not a task an agent performs.** Stop here and hand the user:

1. The path `supabase/migrations/0134_two_decimal_qty.sql`, to paste into the
   Supabase SQL editor for the **staging** project (`pruhoaqaurhzyvwwnjdk`).
2. The expected output: `NOTICE: 0134: snapshotted N views` followed by
   `NOTICE: 0134: OK — N views restored, quantities are numeric(12,2)`, with the
   same N both times.
3. A note that a failure anywhere rolls the whole thing back, so a red error
   means nothing was changed and it is safe to fix and re-run.

Do not proceed to Task 4 until the user confirms it applied.

---

### Task 4: Prove it end to end

**Files:**
- Modify: `scripts/test-fractional-qty.mjs` — the gate block (lines 34-42), the
  `Tenths only` section (lines 176-203), the `0.1 is the floor` section (lines
  375-390), and the static section (line 55 onward)

**Interfaces:**
- Consumes: `fn_assert_qty` and `fmt_qty` at two decimals (Task 1, applied);
  `parseQty` / `sanitizeQtyInput` / `qtySchema` at two decimals (Task 2).
- Produces: no exports — this is the suite that proves the feature.

**Read first:** the suite's own header. It proves the rule's three parts
*separately* because each is enforced in a different place and any one can rot
alone. Preserve that structure; do not merge sections.

- [ ] **Step 1: Update the suite header**

The header currently says "only to one decimal" and lists TENTHS ONLY as rule 1.
Replace those two references with two decimals and `0.255`, and add one line
recording why two and not three:

```
 *   1. HUNDREDTHS ONLY — 0.255 is REFUSED, not silently rounded to 0.26.
 *      Two decimals is 10 g granularity, which covers every fraction a customer
 *      asks for; three would be the false precision the `g` unit exists to avoid.
```

Keep the rest of the header — the three-part structure and the two invariants
below it are still exactly right.

- [ ] **Step 2: Rewrite the tenths section as hundredths (this section IS the gate)**

There is no separate migration gate for 0134. The existing gate at the top of
the file probes `units`, and the parts this feature needs are not seeded until
~60 lines later, so an early probe has no product to test against. Instead the
first assertion of this section doubles as the gate — the pattern
`test-price-lock` uses, where a behavioural feature has no catalog query that
could answer "is it applied?".

Replace the whole `section("Tenths only (0.12 is refused, never rounded)")`
block (lines 176-203) with:

```js
section("Hundredths only (0.255 is refused, never rounded)");
{
  // The quarter kilo is the whole point of 0134.
  const quarter = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST quarter ${RUN}`,
    p_parts: [{ part_id: kilo.id, qty: 0.25, unit_cost_centavos: 100 }],
    p_engines: [],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  if (/too many decimals/i.test(quarter.error?.message ?? "")) {
    console.error(
      "test-fractional-qty: migration 0134_two_decimal_qty.sql is not applied — run it in the SQL editor first."
    );
    await cleanup();
    process.exit(2);
  }
  check("receiving 0.25 kg is accepted", !quarter.error, quarter.error?.message);

  const { data: after } = await owner.from("stock_levels")
    .select("qty").eq("part_id", kilo.id).is("shop_id", null).single();
  check("0.25 survives the round trip exactly", Number(after?.qty) === 25.75,
    String(after?.qty));

  const threeDp = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST 3dp ${RUN}`,
    p_parts: [{ part_id: kilo.id, qty: 1.005, unit_cost_centavos: 100 }],
    p_engines: [],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("receiving 1.005 kg is refused", /too many decimals/i.test(threeDp.error?.message ?? ""),
    threeDp.error?.message ?? "it was ACCEPTED");

  // The dangerous failure is the silent one: if 1.005 were accepted, the cast
  // to numeric(12,2) would store 1.00 and nobody would ever see the error.
  const { data: lvl } = await owner.from("stock_levels")
    .select("qty").eq("part_id", kilo.id).is("shop_id", null).single();
  check("the refused 1.005 changed nothing", Number(lvl?.qty) === 25.75, String(lvl?.qty));
}
```

Note the running total: the section before this one leaves master at 25.5, so
0.25 takes it to 25.75. If the preceding sections are edited, re-derive these
two numbers rather than assuming them.

- [ ] **Step 3: Extend the floor section with a quarter-kilo sale**

In `section("0.1 is the floor Gerry asked for")`, after the existing `0.1`
assertions and before the closing brace, add:

```js
  // A quarter kilo sells and the money rounds ONCE, at the line.
  const qtr = await shop.client.rpc("fn_record_sale", {
    p_customer_id: cust.id,
    p_part_lines: [{ part_id: kilo.id, qty: 0.25, unit_price_centavos: 1550 }],
    p_engine_lines: [],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
  });
  check("0.25 kg sells", !qtr.error && !!qtr.data, qtr.error?.message);

  const { data: ql } = await owner.from("sale_lines")
    .select("qty, line_total_centavos").eq("sale_id", qtr.data).single();
  check("0.25 survives the round trip", Number(ql?.qty) === 0.25, String(ql?.qty));
  // ₱15.50 × 0.25 = ₱3.875 — round() at the line gives ₱3.88, never a half centavo.
  check("₱15.50 × 0.25 = ₱3.88", ql?.line_total_centavos === 388,
    String(ql?.line_total_centavos));

  // Grams are untouched by 0134: g has allows_fractional = false.
  const gram = await seedPart({ label: "GramNails", cost: 10, price: 15, unit: "g" });
  const gFrac = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST g frac ${RUN}`,
    p_parts: [{ part_id: gram.id, qty: 0.5, unit_cost_centavos: 10 }],
    p_engines: [],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("0.5 g is still refused — grams are whole",
    /whole numbers only/i.test(gFrac.error?.message ?? ""),
    gFrac.error?.message ?? "it was ACCEPTED");
```

- [ ] **Step 4: Run the suite**

Run: `node scripts/test-fractional-qty.mjs > /tmp/frac.log 2>&1; tail -40 /tmp/frac.log`

Expected: PASS, zero failures. **Never pipe this through `head`** — `head`
closes the pipe, node dies on EPIPE before `cleanup()` runs, and fixtures are
left behind in the database. Redirect to a file and tail it.

If it fails at `the refused 1.005 changed nothing`, the CHECK constraints did
not apply — re-read the migration output with the user.

- [ ] **Step 5: Run the ledger invariant and the full suite**

Run:
```bash
node scripts/test-movements.mjs > /tmp/mv.log 2>&1; tail -20 /tmp/mv.log
node scripts/test-lib-unit.mjs
npm test > /tmp/all.log 2>&1; tail -60 /tmp/all.log
```

Expected: `test-movements` and `test-lib-unit` green. `npm test` green except
for one **known pre-existing** failure — `test-movements` reports 50/1 on
staging for part "Nails 1" at Gerwin-Bacoor, which predates this work and is
unrelated. Any *other* failure is a regression from this change and must be
investigated before proceeding.

Suites run sequentially and several assert on global counts, so do not
parallelise.

---

### Task 5: Browser QA

**Files:**
- Create: `scripts/qa-browser/kq1-quarter-kilo.mjs`

**Interfaces:**
- Consumes: `launch`, `login`, `goto`, `check`, `summary`, `shot`, `ok`,
  `dbAuth` from `scripts/qa-browser/qa-lib.mjs` (same imports as
  `gq1-gram-qty-typed.mjs`).
- Produces: nothing — this is the manual-QA substitute the user relies on
  because they have no time to test by hand.

**Selector gotchas learned the hard way** (from `gq1` and `gp1`): the cart
quantity box is `getByLabel(/^Quantity in /i)`; a fully-committed product stays
visible at `0 left` but **disabled**, so pick an enabled option with the most
stock; there is no `networkidle` — use explicit `waitForTimeout`.

- [ ] **Step 1: Write the QA script**

Create `scripts/qa-browser/kq1-quarter-kilo.mjs`:

```js
/**
 * QA 0134: a kg line takes a quarter kilo, and a third of one is refused.
 *
 * Run: node scripts/qa-browser/kq1-quarter-kilo.mjs   (needs npm run dev)
 */
import { launch, login, goto, check, summary, shot, ok } from "./qa-lib.mjs";

const { browser, page } = await launch();

try {
  await login(page, "shop");
  await goto(page, "/shop/record-sale");

  // Find an enabled kg product with room to type a fraction.
  const options = page.locator("button:not([disabled])", { hasText: /kg\s*left/i });
  const n = await options.count();
  check(n > 0, `the picker lists a kg product (${n} enabled)`);
  if (n === 0) {
    await shot(page, "kq1-no-kg-product");
    throw new Error("no sellable kg product — seed one before running this");
  }

  let best = { i: -1, qty: 0, label: "" };
  for (let i = 0; i < Math.min(n, 25); i++) {
    const txt = await options.nth(i).innerText();
    const q = Number((txt.match(/([\d.]+)\s*kg\s*left/i) ?? [])[1] ?? "0");
    if (q > best.qty) best = { i, qty: q, label: txt.split("\n")[0].trim() };
  }
  check(best.i >= 0 && best.qty >= 1, `found a kg product with stock (${best.qty})`);
  await options.nth(best.i).click();
  await page.waitForTimeout(900);
  ok(`added "${best.label}" — ${best.qty} kg available`);

  const qty = page.getByLabel(/^Quantity in /i).first();
  check(await qty.isVisible().catch(() => false), "the quantity box is editable");

  // 1. the quarter kilo — the entire point of 0134
  await qty.fill("");
  await qty.type("0.25");
  await page.waitForTimeout(700);
  check((await qty.inputValue()) === "0.25",
    `0.25 survives typing (box reads "${await qty.inputValue()}")`);
  await shot(page, "kq1-quarter");

  // 2. the third decimal is masked as you type, not fought with an error
  await qty.fill("");
  await qty.type("0.255");
  await page.waitForTimeout(700);
  check((await qty.inputValue()) === "0.25",
    `a 3rd decimal is masked (box reads "${await qty.inputValue()}")`);

  // 3. the line total tracks the typed quantity, not a stale one
  await qty.fill("");
  await qty.type("0.5");
  await qty.blur();
  await page.waitForTimeout(800);
  check((await qty.inputValue()) === "0.5", "0.5 still works — nothing regressed");

  // 4. and the sale saves
  await qty.fill("");
  await qty.type("0.25");
  await page.waitForTimeout(700);
  const save = page.getByRole("button", { name: /^(save|record sale)/i }).last();
  check(await save.isEnabled().catch(() => false), "Save is enabled at 0.25 kg");
  await shot(page, "kq1-ready-to-save");
} finally {
  await browser.close();
}
summary();
```

- [ ] **Step 2: Run it**

Run: `npm run dev` in one terminal, then
`node scripts/qa-browser/kq1-quarter-kilo.mjs`

Expected: all checks pass. If `next dev` moved off port 3000 (it does that
silently when 3000 is taken), set the base URL the way `qa-lib` expects rather
than assuming the default — a stranger's dev server on 3000 answers happily and
every failure looks like broken code.

- [ ] **Step 3: Verify the Dashboard no longer rounds**

Run: `node scripts/qa-browser/kq1-quarter-kilo.mjs` having saved the 0.25 sale,
approve it as the owner, then load `/dashboard` as the owner and read the
top-products card.

Expected: a fractional quantity renders with its decimal (e.g. `0.25`), not
rounded to `0`. Before 0134 this read as a whole number. Capture a screenshot
for the user.

- [ ] **Step 4: Hand the branch to the user**

Report: what changed, the suite results including the known pre-existing
`test-movements` failure, the QA screenshots, and that `0134` must be applied to
**production** (with shops closed and a manual backup downloaded first) after
they merge. Do not commit, do not push, do not apply anything.

---

## Deferred — not in this plan

These were noticed while working and are deliberately out of scope:

- `/shop/transfers` has the same filter-after-limit defect that was fixed in
  `/shop/deliveries` — a `.limit()` followed by a client-side status filter
  hides a shop's oldest actionable rows.
- `scripts/test-fractional-qty.mjs` has no `try/finally`, so a crash mid-suite
  leaks fixtures into the database.
- Production has no backups configured; `scripts/backup-db.mjs` is blocked from
  reading production by the env guard.
- `qa-lib.mjs`'s `CREDS.admin` is stale on staging.
