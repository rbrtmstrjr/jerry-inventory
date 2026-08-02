# Deployment — staging & production

One repository, one Vercel project, **two Supabase projects**. This document is
the whole path: how the environments stay apart, how schema changes travel from
staging to production, and how a brand-new production database is created.

## The two projects (as built, 2026-08-02)

| | Ref | Region | Role |
|---|---|---|---|
| **PRODUCTION** | `wjvkrkbojnemfiuuitmu` | ap-southeast-1 | the client's real books. Created 2026-08-02 by `supabase db push` (0001→0113). |
| **STAGING** | `pruhoaqaurhzyvwwnjdk` | ap-southeast-1 | disposable. Every script, seed and test suite targets this one. |

Live at **www.gerwintrading.com** (apex `gerwintrading.com` 308s to `www`, so
`window.location.origin` is always the `www` form — which is what the auth
config below has to match). Vercel functions run in **`sin1`**: the app is
server-rendered, so a function in the US would put two ocean crossings in front
of every query no matter where the database sits.

**The refs differ by nothing a human eye catches.** Both are 20 random
lowercase letters. Never identify a project by squinting at the ref — check the
marker (`SUPABASE_ENV`, `supabase/.temp/project-ref`) or the dashboard title.

---

## 1. The environment model

```
feature branch ──► Vercel Preview ──► …-<hash>.vercel.app      ──► STAGING    (disposable)
staging  branch ──► Vercel Preview ──► staging.gerwintrading.com ──► STAGING   (disposable)
main     branch ──► Vercel Prod    ──► www.gerwintrading.com   ──► PRODUCTION (real data)
```

### Domains

| Domain | Serves | Database |
|---|---|---|
| `www.gerwintrading.com` | Production (`main`) | **production** |
| `gerwintrading.com` | 308 → `www` | — |
| `maccky-marine-inventory.vercel.app` | 308 → `www` | — |
| `staging.gerwintrading.com` | Preview, pinned to branch `staging` | staging |
| `…-<hash>.vercel.app` | Preview, any branch | staging |

The two legacy URLs **redirect** rather than serve. Two hostnames answering from
the same production database is a way to get confused at 2am; and pointing the
old `.vercel.app` link at *staging* would have been worse — the owner opening a
stale bookmark would see ten invented branches and 41,000 fake sales, and
reasonably conclude his business had vanished.

`staging.gerwintrading.com` is pinned to the **`staging`** branch, not "all
branches". Note that Vercel will not build `staging` while it points at the same
commit as `main` — it dedupes identical commits — so the domain shows "No
Deployment" until that branch has a commit of its own.

Two Supabase projects are two separate Postgres clusters, on different hosts,
with different credentials. **They share nothing** — there is no network path
between them and no configuration that could let staging reach production. That
isolation is the default; you do not build it.

What you *do* build is the discipline that each deployment — and each script on
your laptop — talks to the intended one.

The app never names a project. `lib/supabase/{client,server,admin,proxy}.ts`
read `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
`SUPABASE_SERVICE_ROLE_KEY` at runtime, so switching environments is purely a
matter of which values are present. No branching logic, no build flags.

### Vercel environment variables

Set the same three names to different values per scope
(Vercel → Project → Settings → Environment Variables):

| Variable | Production scope | Preview scope |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | production project URL | staging project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | production anon key | staging anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | production service key | staging service key |

Two rules that are not negotiable:

- **`SUPABASE_SERVICE_ROLE_KEY` must never carry a `NEXT_PUBLIC_` prefix.** That
  key bypasses RLS and every owner-tier lock in the schema; prefixed, it would
  be shipped to every browser.
- **The service key lives only in Vercel and in your local `.env.local`.** It is
  never committed. `.env.local` is git-ignored; keep it that way.

"Production branch" in Vercel is `main` by default. Every other branch deploys
as a Preview and therefore hits staging.

---

## 2. The guard on your laptop

This is the part that actually protects the client's data, because Vercel was
never the risk.

Twenty-four scripts in `scripts/` authenticate with the **service-role key**.
`db-fresh-start.mjs` deletes every operational row; the seeds write hundreds of
thousands; `npm test` creates and deletes fixtures continuously. All of them
read `.env.local`. Point that file at production once — to debug something, say
— and the next habitual `npm test` writes fixtures into the client's books.

`db-fresh-start`'s own "is there an owner?" safety check does **not** save you:
production has an owner, so the check passes and the wipe proceeds.

So `.env.local` must positively declare what it points at:

```bash
SUPABASE_ENV=staging      # or: local
```

`scripts/_env-guard.mjs` refuses to let any write script continue unless that
value is `staging` or `local`. Production credentials carry
`SUPABASE_ENV=production` and every one of those scripts aborts:

```
REFUSED: db-fresh-start (it DELETES all operational data) must never run
against SUPABASE_ENV=production (project: abcdefghijklm).
```

It is an **allowlist, and it fails closed** — a missing or misspelled marker is
refused too. A blocklist ("refuse if the URL is the prod ref") fails *open* the
day someone forgets to add a project to it. Around irreversible work the
acceptable failure is "stopped for no reason", never "wiped for no reason".

`scripts/test-env-guard.mjs` covers this logic (production refused, typos
refused, missing marker refused, and every write script verified to call the
guard). It runs as part of `npm test`.

**That coverage check is DISCOVERED, not listed — and it was not always.** Until
2026-08-02 it walked a hardcoded array of 11 filenames whose comment claimed
"`_harness.mjs` covers every `test-*.mjs` suite in one place". It did not: **12
scripts read `.env.local` and built their own service-role client without ever
importing the harness**, so they were unguarded while the test reported green.
A hardcoded list fails OPEN the day someone adds a script — the exact failure
mode the guard exists to prevent, sitting inside the test meant to prove it.

It now scans `scripts/` and requires a guard from anything that references
`SERVICE_ROLE` and performs a write, directly or via the harness. Two read-only
exemptions are declared explicitly: `_pnl_capture.mjs`, and **`backup-db.mjs`,
which MUST be able to reach production** — it is the nightly backup.

If you add a script that writes with the service role, do nothing: the test will
fail until you add the guard.

---

## 3. Schema changes: staging first, then production

Migrations in `supabase/migrations/` are numbered and applied in order
(`0001_schema.sql` → `0112_…`). The Supabase CLI accepts this naming as-is and
records what an environment has applied in `supabase_migrations.schema_migrations`,
so `db push` only ever runs what is new.

### One-time setup

```bash
npx supabase init                    # creates supabase/config.toml
```

### Promoting a change

```bash
# 1. write the migration — a NEW file, never an edit to an applied one
#    supabase/migrations/0113_my_change.sql

# 2. staging
npx supabase link --project-ref pruhoaqaurhzyvwwnjdk   # STAGING
npx supabase db push                 # applies only 0113
npm test                             # suites run against staging
#    → QA in the Preview deployment

# 3. production, once staging is proven
npx supabase link --project-ref wjvkrkbojnemfiuuitmu   # PRODUCTION
npx supabase db push                 # applies exactly the same 0113
```

Code and schema promote together: merge the branch to `main` so the Production
deployment and the production database change in the same step.

### Rules

- **Never edit a migration that has been applied anywhere.** The CLI tracks by
  version, so an edited file is silently skipped where it already ran, and the
  environments quietly diverge. Add a new file instead. The codebase already
  works this way — e.g. `0101` supersedes `0026` by redefining the function
  rather than editing it.
- **Prefer additive changes.** The existing migrations are written defensively
  (`if not exists`, `or replace`, `drop policy if exists`), which is what makes
  them safe to re-run. Avoid dropping a column without a deprecation window.
- **Enable `pg_cron` AND `btree_gist` before the first push** (Dashboard →
  Database → Extensions), or `0032_warranty_expiry_cron.sql` (and `0039`) fail.

### `db push` runs each FILE in one transaction — the SQL editor does not

**The single most expensive lesson of the 2026-08-02 production build, and it
will bite again unless you write migrations with it in mind.**

Every migration up to 0113 was applied to staging **by hand in the SQL editor**,
where each statement commits on its own. `supabase db push` wraps each migration
**file** in ONE transaction. SQL that is fine statement-by-statement can fail as
a unit — so a migration can be "proven on staging" and still abort on the first
real push.

It happened at `0099_admin_accounts.sql`, which both ADDS `'admin'` to the
`user_role` enum and USES it in a CHECK constraint. Postgres forbids using an
enum value added in the same transaction (`55P04`), so the push died at file 32
of 100 — with 0001–0095 applied *and recorded*, i.e. a half-built database.

The fix was **not** to edit 0099 (it was already applied on staging; editing an
applied migration is how environments diverge). Instead
`0098_user_role_admin_enum.sql` adds the value alone and commits first; 0099's
own `add value if not exists` then finds it present, adds nothing to its
transaction, and its CHECK becomes legal. Both files stay correct standalone and
the pair is idempotent on a database that already has the value.

The codebase already knew this rule — `0027` and `0069` are standalone enum
migrations for exactly this reason. Hand-application is what hid the 0099 slip.

**So, when writing a migration:** an enum value added in a file may not be used
in that file. Put the `add value` in its own migration. The same applies to
anything Postgres forbids in a transaction block (`CREATE INDEX CONCURRENTLY`,
`VACUUM`, `ALTER SYSTEM`) — none exist in this repo today, and none should be
added without their own file.

**And: staging's `supabase_migrations.schema_migrations` is EMPTY** (everything
was hand-applied), so `db push` against staging would replay from 0001. Either
baseline it (below) or keep applying staging migrations in the SQL editor. Do
not push to staging casually.

### Baselining an existing database

The current project had every migration applied by hand, so its tracking table
is empty and `db push` would try to replay from `0001`. Tell the CLI they are
already applied — once, per such database. `repair` takes many versions at
once, so generate the list from the filenames rather than typing 100 of them:

```bash
npx supabase link --project-ref <REF>

# every version = the filename prefix before the first underscore
VERSIONS=$(ls supabase/migrations/*.sql | xargs -n1 basename | cut -d_ -f1 | tr '\n' ' ')
echo $VERSIONS            # sanity-check: 0001 0002 0003 … (100 of them today)

npx supabase migration repair --linked --status applied $VERSIONS
npx supabase db push      # must now report nothing new to apply
```

Pass `--linked` explicitly so there is no doubt which database is being
marked. That last `db push` reporting "no new migrations" is the confirmation
that the baseline took — if it instead starts applying `0001`, stop: the
repair did not land and replaying would be destructive.

A fresh project needs none of this: everything applies cleanly in order.

---

## 4. Creating the production database

The schema is fully reproducible from migrations. Buckets, cron jobs, the
realtime publication and reference data are all included — the only manual step
is the first account.

1. **Create the project** (Supabase Dashboard). Choose a strong database
   password and store it in a password manager — it is shown once and `db push`
   needs it. Region **ap-southeast-1 (Singapore)**; the region CANNOT be changed
   later, so getting it wrong means deleting the project and starting over.

   **The Security checkboxes on the create form matter, and one of them
   contradicts Supabase's own advice:**

   | Setting | Value | Why |
   |---|---|---|
   | Enable Data API | ✅ on | the app is `supabase-js` / PostgREST |
   | **Automatically expose new tables** | ✅ **ON** | Supabase's UI says "we recommend disabling this". **For this schema that is wrong and breaks every page.** There is not a single base-table `GRANT` in 113 migrations — access comes from Supabase's default privileges and **RLS restricts the rows**. `0002` proves it by *revoking* from `anon`, which is only possible because the grants were there. Disable it and `db push` creates 48 tables `authenticated` cannot read: every query fails with a permission error and RLS is never even consulted. |
   | Enable automatic RLS | ☐ off | matches staging. An event trigger that force-enables RLS on new tables would make the two environments behave differently for any future table — RLS off in staging, deny-all in production. `test-rls` (53 assertions, run against staging) is the real guard; keep staging as strict as production rather than papering over it in one place only. |

2. **Enable `pg_cron` AND `btree_gist`**: Database → Extensions. Before any push
   — see the transaction note in §3.
3. **Push the schema**: `npx supabase link --project-ref wjvkrkbojnemfiuuitmu` then
   `npx supabase db push`.

   Then **verify it landed** — `db push` reporting success does not prove the
   storage half worked, because `storage.objects` is owned by
   `supabase_storage_admin`, not `postgres`:

   ```sql
   select count(*), max(version) from supabase_migrations.schema_migrations; -- 102, 0113
   select jobname, schedule, active from cron.job;          -- 2 rows, both active
   select id, public from storage.buckets;                  -- product-images=t, receipts=f
   select count(*) from pg_policies where schemaname='storage';   -- 13
   select code, enabled from public.notification_channels;  -- in_app=t, sms=f
   select tablename from pg_publication_tables
     where pubname='supabase_realtime';                     -- 7 rows incl. expenses
   ```
4. **Create the owner's auth user**: Authentication → Users → Add user, with
   *auto-confirm* on. Copy the new user's UUID.
5. **Give it the owner profile** — in the SQL editor, because the app cannot do
   this yet (creating a profile requires `is_primary_owner()`, and no owner
   exists to satisfy it; the SQL editor bypasses RLS):

   ```sql
   insert into public.profiles (id, full_name, role, shop_id)
   values ('<UUID-FROM-STEP-4>', 'Gerry', 'owner', null);
   ```

   From here Gerry creates admin accounts (Settings → Admins) and shop logins
   (Shops & Employees) inside the app, normally.
6. **Clean the sample rows**: `0003_seed.sql` inserts two placeholder shops
   ("Branch 1 — Poblacion", "Branch 2 — Fish Port"). Rename them to the real
   branches or delete them. Set the business identity under Settings → Business.
7. **Point Vercel at it** — the three variables in the **Production scope only**
   (Preview keeps staging), Functions → Region **`sin1`**, then deploy.

   Scope them **Production**, never "Production and Preview" — that one dropdown
   would put every branch deploy on the client's live data and undo the whole
   split. Vercel refuses duplicate keys in one environment, so retarget the
   existing entries to **Preview** first, then add the Production set.

   A **push to `main` builds fresh** and picks up the new values. Only a manual
   *Redeploy* of an existing build needs "Use existing Build Cache" unchecked —
   `NEXT_PUBLIC_*` values are compiled into the browser bundle, so a reused build
   keeps the old ones while the dashboard shows the new ones.

   **Verify from outside**, since that failure is silent:

   ```bash
   html=$(curl -s -L https://www.gerwintrading.com/login)
   echo "$html" | grep -oE '/_next/static/chunks/[a-zA-Z0-9._-]+\.js' | sort -u |
     while read -r c; do curl -s "https://www.gerwintrading.com$c" |
       grep -oE "[a-z]{20}\.supabase\.co" | sort -u; done
   # must print the PRODUCTION ref, never pruhoaqaurhzyvwwnjdk
   ```

8. **Authentication → URL Configuration** (production project):
   - **Site URL** `https://www.gerwintrading.com` — the `www` form, because the
     apex 308s before the app renders, so `window.location.origin` is always
     `www`.
   - **Redirect URLs**: `https://www.gerwintrading.com/auth/callback` **and**
     `…/auth/callback?**`. The wildcard is not optional: reset links carry
     `?next=/auth/reset`, the allow-list is glob-matched, and a rejected redirect
     does not error — Supabase silently falls back to Site URL and the user lands
     on the dashboard instead of the password form.

   Both matter, for different flows: password reset passes an explicit
   `redirectTo` (allow-list governs it), while **email change passes none**
   (`settings/account-section.tsx` → `updateUser({ email })`), so it goes
   wherever Site URL points.

9. **SMTP — password reset does not work without it.** A fresh project's built-in
   sender does ~2 emails/hour and, on new projects, only delivers to the project
   owner's own address; a shop employee clicking "Forgot password?" gets silence.
   Custom SMTP via **Resend**: host `smtp.resend.com`, port `465`, username the
   literal `resend`, password = the API key, sender `noreply@gerwintrading.com`.
   DKIM/SPF/DMARC records live at **Porkbun** (the registrar), on the `send`
   subdomain — which is why they do not disturb the root-domain mail forwarding.
   Enabling custom SMTP raises the limit to 30/hour.

10. **Backups — the free tier has none.** `.github/workflows/db-backup.yml` dumps
    nightly at 2:00 AM PH, 90 rolling days, and doubles as a keep-warm against
    the free tier's 7-day inactivity pause. It needs two **repository** secrets
    (GitHub → Settings → Secrets and variables → Actions):
    `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, both pointing at
    **production**. Without them the job fails in ~10s every night, silently —
    it did exactly that for its first ten runs. Trigger it once by hand and
    **open the artifact**: a backup nobody has opened is a hope, and a silently
    broken one produces a small file that looks plausible.

### What NOT to do

Do not clone the staging database into production. Staging holds two years of
generated data — ~40,000 fake sales, ten invented branches, `ZZ-TEST` fixtures.
Production starts from migrations so it starts genuinely empty.

---

## 5. Checklists

**Before the first production deploy**

- [ ] Region is `ap-southeast-1`; "Automatically expose new tables" left **ON**
- [ ] `pg_cron` **and** `btree_gist` enabled *before* the first push
- [ ] All migrations pushed; the six verification queries in §4.3 all correct
- [ ] Owner profile created and sign-in verified
- [ ] Sample shops renamed or removed; business identity set (else all 13
      printed documents carry a name-only letterhead)
- [ ] Vercel Production scope holds the production keys; Preview holds staging —
      **scoped Production, not "Production and Preview"**
- [ ] Vercel Functions region = `sin1`
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is **not** `NEXT_PUBLIC_`
- [ ] The deployed bundle really carries the production ref (curl check in §4.7)
- [ ] Auth Site URL + redirect allow-list set, **including the `?**` variants**
- [ ] Custom SMTP configured and a real password reset received
- [ ] Backup secrets set, workflow run by hand, **artifact opened and checked**
- [ ] Owner password is unique and stored in a password manager
- [ ] Supabase → Authentication → Providers → Email: "Secure password change"
      enabled, so a stolen session cannot change credentials

**Do not smoke-test the stock or sales paths on production.**
`stock_movements` is append-only — there is no contra-entry RPC and nothing hard
-deletes — so a test receiving and a test sale become permanent rows in the
client's ledger and P&L. Exercise the *reversible* surfaces instead (business
identity, a logo upload, creating a branch and a login, Settings → System, print
any document); the logo upload is the cheap way to prove the storage policies
work. Let the first real receiving and sale be genuine business, watched.

**Every schema change**

- [ ] New migration file; no applied file edited
- [ ] Pushed to staging, `npm test` green, QA'd in the Preview deployment
- [ ] Pushed to production; branch merged to `main`

**Whenever `.env.local` changes**

- [ ] `SUPABASE_ENV` matches the project the URL points at
