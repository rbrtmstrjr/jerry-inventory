# Deployment — staging & production

One repository, one Vercel project, **two Supabase projects**. This document is
the whole path: how the environments stay apart, how schema changes travel from
staging to production, and how a brand-new production database is created.

---

## 1. The environment model

```
feature branch ──► GitHub ──► Vercel  Preview     ──► STAGING Supabase   (disposable)
main           ──► GitHub ──► Vercel  Production  ──► PRODUCTION Supabase (client's real data)
```

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
npx supabase link --project-ref <STAGING-REF>
npx supabase db push                 # applies only 0113
npm test                             # suites run against staging
#    → QA in the Preview deployment

# 3. production, once staging is proven
npx supabase link --project-ref <PROD-REF>
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
- **Enable `pg_cron` before the first push** (Dashboard → Database →
  Extensions), or `0032_warranty_expiry_cron.sql` fails.

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
   password and store it in a password manager.
2. **Enable `pg_cron`**: Database → Extensions.
3. **Push the schema**: `npx supabase link --project-ref <PROD-REF>` then
   `npx supabase db push`.
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
7. **Point Vercel at it** — the three variables in the Production scope, then
   redeploy.

### What NOT to do

Do not clone the staging database into production. Staging holds two years of
generated data — ~40,000 fake sales, ten invented branches, `ZZ-TEST` fixtures.
Production starts from migrations so it starts genuinely empty.

---

## 5. Checklists

**Before the first production deploy**

- [ ] `pg_cron` enabled; all migrations pushed; `db push` reports nothing new
- [ ] Owner profile created and sign-in verified
- [ ] Sample shops renamed or removed; business identity set
- [ ] Vercel Production scope holds the production keys; Preview holds staging
- [ ] `SUPABASE_SERVICE_ROLE_KEY` is **not** `NEXT_PUBLIC_`
- [ ] Owner password is unique and stored in a password manager
- [ ] Supabase → Authentication → Providers → Email: "Secure password change"
      enabled, so a stolen session cannot change credentials
- [ ] Point-in-time recovery / backups reviewed for the production project

**Every schema change**

- [ ] New migration file; no applied file edited
- [ ] Pushed to staging, `npm test` green, QA'd in the Preview deployment
- [ ] Pushed to production; branch merged to `main`

**Whenever `.env.local` changes**

- [ ] `SUPABASE_ENV` matches the project the URL points at
