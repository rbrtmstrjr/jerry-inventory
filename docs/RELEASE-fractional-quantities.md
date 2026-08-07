# Production release — fractional quantities (0114–0126)

**Status: NOT RELEASED.** Staging is running it; production is not.

This is the largest schema change in the project's history. `0116` retypes
eleven quantity columns and rewrites every row of `stock_movements` under
`ACCESS EXCLUSIVE`. Read this whole page before opening a terminal.

---

## What ships

| | |
|---|---|
| Migrations | `0114` → `0126` (13 files) |
| Code | the `fix/add-editable-price-quantity` branch |
| Behaviour | quantity accepts one decimal, but only for units marked `allows_fractional` (today: kilogram only) |

---

## The one risk that is specific to this release

`supabase db push` wraps **each migration file in ONE transaction**. The Supabase
SQL editor does not — it commits statement by statement.

Every migration from 0114 to 0126 has only ever been applied **by hand in the
SQL editor on staging**. Production will be the first time any of them runs as a
single transaction. This is exactly how the 2026-08-02 build died at `0099`,
with 0001–0095 applied and recorded and a half-built database
(DEPLOYMENT.md §3).

**Audited for it, 2026-08-06 — this range is clean:**

- no `alter type … add value` (the 0099 failure mode)
- no `CREATE INDEX CONCURRENTLY`, `VACUUM`, or `ALTER SYSTEM`
- `0116` is already a single `do` block, so it is atomic however it is run
- `0115`'s guard raises inside a transaction, which aborts the file — the
  intended behaviour

That audit removes the known trap. It does not make the range *proven* under
`db push`, which is what the optional dress rehearsal in Phase 0 buys.

---

## Phase 0 — before the window (do this days ahead)

### 0.1 Confirm where production actually is

Production tracks applied versions properly (it was built with `db push`).
In the **production SQL editor**:

```sql
select max(version) from supabase_migrations.schema_migrations;
-- expect 0113. Anything else, STOP and reconcile before going further.
```

### 0.2 Run 0115's guard against production — READ ONLY

`0115` **aborts** if any `parts.unit` value is missing from the `units`
vocabulary, and it refuses to guess. It was written against the production
vocabulary read on 2026-08-03 (`pc` 387, `set` 3, and one `'1'` typo). Products
added since may have introduced new values.

```sql
select coalesce(unit, '(null)') as unit, count(*)
from public.parts
group by 1 order by 2 desc;
```

Every value must be one of `pc, kg, set, box, roll, pair, m`.

Check soft-deleted rows too — a foreign key applies to them, and 0115's guard
deliberately covers every row.

**Result, read 2026-08-06** (after the office reclassified the catalogue):

```
pc 518 · unit 7 · meter 6 · feet 5 · set 3 · pcs 2 · 1 1
```

Four spellings out of vocabulary. `0115` would abort with `0114` applied and
recorded.

### 0.2b A new migration CANNOT fix this — it has to be a pre-flight

The obvious move is `0127_map_units.sql`, and it does not work: `db push`
applies in version order, so `0115` runs — and aborts — long before any `0127`.
Renumbering into the gap (`01141_…`) sorts correctly but is a trap for the next
reader.

So the mapping is a **pre-flight data fix, applied by hand to production
immediately before the push**. That is honest about what it is: production-only
data reconciliation of values that never existed on staging, not a schema
change. Nothing to promote, nothing for staging to replay.

Run the SELECT first and eyeball it, then the UPDATEs:

```sql
-- DRY RUN — what would change
select unit as from_unit,
       case
         when lower(btrim(unit)) in ('1','pcs','un','unit','units','piece','pieces') then 'pc'
         when lower(btrim(unit)) in ('meter','metre','meters','metres','m')          then 'm'
         else '*** UNMAPPED — STOP ***'
       end as to_unit,
       count(*)
from public.parts
where coalesce(unit,'') not in ('pc','kg','set','box','roll','pair','m')
group by 1,2 order by 1;
```

Only run the UPDATEs when nothing says `UNMAPPED`:

```sql
update public.parts set unit = 'pc'
 where lower(btrim(unit)) in ('1','pcs','un','unit','units','piece','pieces');

update public.parts set unit = 'm'
 where lower(btrim(unit)) in ('meter','metre','meters','metres','m');
```

Then the gate — **must return zero rows**:

```sql
select coalesce(unit,'(null)') as unit, count(*)
from public.parts
where coalesce(unit,'') not in ('pc','kg','set','box','roll','pair','m')
group by 1;
```

`0115` re-does this work idempotently when it runs (it lower-cases, trims, and
maps `'1'`), so doing it by hand first changes nothing about the migration —
it only stops the guard firing.

### 0.2c The five `feet` products — BLOCKING, needs Gerry

```
Bronze Pipe 3/4  48 · Bronze Pipe 5/8  40 · Ehe 1/2  40
Ehe 3/4 (No Thread)  44 · Ehe 5/8 (No Thread)  45
```

Not a spelling fix. Relabelling feet as metres would leave the quantity alone
and change what it MEANS — 48 becomes 48 metres of pipe instead of 48 feet, a
3.28× overstatement on every document that prints it.

The deciding question: **does a customer ask for "10 feet of Bronze Pipe 3/4",
or for "1 Bronze Pipe 3/4"?**

| Answer | Do this | Cost |
|---|---|---|
| Sold by the foot | add `ft` to the vocabulary — see 0.2d | no data change |
| Fixed lengths sold whole | map to `pc`, add it to the pre-flight above | no data change |
| Wants metres properly | convert unit AND quantity (× 0.3048) | a real stock adjustment, do it separately |

### 0.2d If `ft` is the answer

`ft` must exist in `units` **before** `0115` adds its foreign key — and 0115
runs immediately after 0114 in the same push, so a later migration is too late.

`0114` is idempotent (`create table if not exists`, `insert … on conflict do
nothing`, `drop policy if exists`). So:

1. apply `0114_units.sql` by hand in the production SQL editor
2. apply `0127_add_foot_unit.sql` by hand as well
3. map the five products to `ft` in the pre-flight
4. run `db push` — it re-runs 0114 (harmless) and 0127 at the end (harmless),
   and 0115 finds `ft` present

Apply `0127` to staging too, so the two environments agree.

### 0.3 Measure the ledger

```sql
select count(*) from public.stock_movements;
```

**Production: 629 rows** (read 2026-08-06). Staging carries ~208k from the load
seed, so 0116 will be far quicker here — near-instant. The window is about the
backup and having shops closed, not about duration.

### 0.4 Get the code onto staging properly

```bash
git checkout staging && git merge fix/add-editable-price-quantity
git push origin staging          # Vercel builds staging.gerwintrading.com
```

Then QA the **staging URL**, not localhost. Confirm the fractional flows on the
deployed build.

### 0.5 Optional but recommended — the dress rehearsal

The only way to prove `db push` behaviour without touching production: create a
throwaway Supabase project (free tier), enable `pg_cron` + `btree_gist`, then

```bash
npx supabase link --project-ref <SCRATCH_REF>
npx supabase db push             # applies 0001 → 0126 from scratch
```

If that completes, every file is transaction-safe. Delete the project after.
This is the cheapest insurance available for the one untested property.

---

## Phase 1 — the window

Pick a time the shops are **closed**. 0116 blocks all reads and writes on the
affected tables while it runs.

### 1.1 Tell the branches

They must not be mid-sale. A shop with an unsaved cart loses it.

### 1.2 Back up by hand and DOWNLOAD the artifact

GitHub → Actions → **DB backup (nightly)** → *Run workflow*. Wait for green,
then **download the artifact**. A backup you have not downloaded is not a backup
you have.

The nightly one at 2 AM PH is not enough — you need a dump from immediately
before the change.

### 1.3 Note what is in flight

```sql
select status, count(*) from public.deliveries group by 1;
select status, count(*) from public.sales where deleted_at is null group by 1;
```

Deliveries in transit and pending batches survive the migration untouched —
record the numbers so you can prove that afterwards.

---

## Phase 2 — schema

### 2.1 Verify the link before pushing

```bash
cat supabase/.temp/project-ref
# MUST read wjvkrkbojnemfiuuitmu for this step, and nothing else.
```

> This is the one operation where being linked to production is correct.
> Every other day it is a hazard: `db push` from this tree hits the client's
> books, and `scripts/_env-guard.mjs` cannot stop it — the guard reads
> `SUPABASE_ENV` from `.env.local`, which the CLI never looks at.

### 2.2 Push

```bash
npx supabase db push
```

Watch it apply 0114 → 0126 in order. **If any file fails, it rolls back alone** —
earlier files stay applied and recorded. Do not re-run blindly; read the error,
fix forward with a NEW migration, never by editing an applied file.

### 2.3 Verify on production

```sql
-- the columns 0116 and 0125 retyped
select table_name, column_name, data_type, numeric_scale
from information_schema.columns
where table_schema = 'public'
  and column_name in ('qty','qty_change','qty_requested','qty_received',
                      'qty_outstanding','expected_qty','counted_qty')
order by table_name;
-- every one: numeric, scale 1

-- 0122's revoke survived the view rebuild
select count(*) from information_schema.role_table_grants g
join pg_class c on c.relname = g.table_name
 and c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
where g.table_schema = 'public' and g.grantee = 'anon';
-- expect 0

-- security_barrier survived
select count(*) from pg_class
where relkind = 'v' and relnamespace = 'public'::regnamespace
  and 'security_barrier=true' = any(reloptions);
-- compare against the number you recorded on staging
```

**The invariant** — the reason `numeric` was chosen over float:

```sql
select count(*) from (
  select m.part_id, m.shop_id, sum(m.qty_change) led, max(l.qty) shelf
  from public.stock_movements m
  join public.stock_levels l
    on l.part_id = m.part_id and l.shop_id is not distinct from m.shop_id
  join public.parts p on p.id = m.part_id and p.deleted_at is null
  where m.movement_type <> 'transit_writeoff'
  group by 1,2 having sum(m.qty_change) <> max(l.qty)
) x;
-- expect 0
```

---

## Phase 3 — code

Schema **first**, code second. That order is deliberate:

- *Old code on the new schema* is safe. It sends whole numbers, which `numeric`
  accepts, and PostgREST returns `numeric` as a JSON number so quantities still
  render normally.
- *New code on the old schema* is broken. `UnitSelect` queries a `units` table
  that does not exist, and a 0.5 sent to an `int` column silently rounds.

So a short window of old-code-on-new-schema is fine; the reverse is not.

```bash
git checkout main && git merge staging
git push origin main             # Vercel builds www.gerwintrading.com
```

Watch the Vercel deployment go green before telling anyone the system is back.

---

## Phase 4 — smoke test on the live books

Production holds the client's real data. **Do not seed test fixtures into it.**

Read-only first:

1. `/movements` → Stock Card for any product — the closing balance banner should
   agree with on-hand
2. `/approvals` → reviewed history shows `× 2`, never `× 2.0`
3. A delivery note and a receipt print with sane quantities
4. `/dashboard` loads and the numbers match what Gerry expects

Then one reversible live check, with Gerry watching:

5. Receiving → New product, unit **Kilogram**, qty `2.5`, against a real
   supplier. Confirm it stores 2.5. This creates a genuine catalog row and a
   genuine receiving — agree beforehand whether to keep it or retire it.

Do **not** test the refusal paths (`0.12`, a `pc` product at 2.5) on production.
They are proven on staging by `test-fractional-qty.mjs` and each failed attempt
still writes an audit trail.

---

## Phase 5 — if it goes wrong

| When | What to do |
|---|---|
| A migration file aborts | It rolled back alone. Earlier files stand. Read the error, write `0127_…` to fix forward. Never edit an applied file. |
| Applied, but behaving wrong | Fix forward with a new migration. There is no down-migration in this project and 0116 is not reversible in place. |
| Data damaged | Restore from the Phase 1.2 artifact: gunzip, re-insert with the service role in FK order — the reverse of `scripts/db-fresh-start.mjs`'s `WIPE_ORDER`. **This has never been rehearsed.** |
| Code is bad, schema is fine | Revert `main` to the previous commit and redeploy. The old code runs on the new schema. |

The asymmetry worth internalising: a **code** problem is minutes to undo, a
**schema** problem is a restore. That is why schema goes first, into a window,
behind a fresh backup.

---

## After

- Run `npm test` against staging again — it is the regression net for the next
  change, and `test-fractional-qty.mjs` now covers the columns 0125/0126 fixed
- Fix `seed-states.mjs:234,246` and `seed-load-test.mjs:336` — both stamp
  `at(day, 18)`, so seeding before 6 PM puts fixtures ahead of the clock
- Consider a Units admin page: `allows_fractional` is data by design, but there
  is no screen for it, so switching Meter on today needs SQL
