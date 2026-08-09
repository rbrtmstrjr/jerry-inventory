# Continuity — running Gerwin Trading without the original developer

**Who this is for:** Gerry Mitante (the owner), and any developer who takes this
system over — including at short notice.

**What it is:** a map of every account the system depends on, what breaks
without each one, and where its credential is kept.

**What it deliberately is NOT:** a place where credentials are written down.
Not one password, key, or connection string appears in this file, and none ever
should. See *Where the credentials live* below.

> **Last reviewed: 2026-08-06.** Re-read it once a year — passwords rotate,
> people change, and a continuity plan nobody has checked is a guess.

---

## 1. If the developer is unavailable — the first hour

**The system keeps running.** Nothing here needs a human daily. Sales, approvals
and stock all continue; the two cron jobs and the nightly backup keep firing.

What actually has a deadline:

| Urgency | Item | Why |
|---|---|---|
| **Weeks** | Domain renewal (`gerwintrading.com`, Porkbun) | If it lapses, the site stops resolving. Everything else is intact but unreachable. |
| **Weeks** | Nightly backups run in the developer's GitHub | They stop when that account does. The data is safe; the *safety net* is not. |
| **Months** | Nothing else | No licence expires, no certificate needs a human (Vercel renews TLS). |

So: **do not panic, and do not rebuild anything.** Secure the domain and the
backups first, then take your time over the rest.

---

## 2. The systems map

Five services. Only three can take the business down.

```
Customer ──► gerwintrading.com (Porkbun DNS)
                  │
                  ▼
            Vercel  (Next.js app, region sin1)
                  │
                  ▼
            Supabase PRODUCTION  ◄── the business's actual data
                  ▲
                  │ nightly dump
            GitHub Actions ──► backup artifacts (90 days)

            Resend ──► password-reset + email-change messages
```

| Service | Holds | If it is lost |
|---|---|---|
| **Porkbun** | the domain | Site unreachable. **Recoverable only by controlling the account** — this is the single most important item on this page. |
| **Supabase (production)** | every sale, product, ledger row | The business's records. Backups exist, but this is the live copy. |
| **Vercel** | the running app | Site down until redeployed elsewhere. Recoverable from the repo in ~an hour. |
| **GitHub** | source + nightly backups | No deploys, no fixes, no new backups. |
| **Resend** | outbound auth email | Password reset stops working. Nobody is locked out who is already signed in. |

**Note the asymmetry:** Vercel and GitHub are *recoverable* — the code can be
redeployed. The **domain and the database are not**. Prioritise accordingly.

---

## 3. Accounts, and what each one is for

Identifiers only. No credentials.

### Porkbun — domain registrar
- **Holds:** `gerwintrading.com`, and the DNS records for the app (`A`/`CNAME`
  → Vercel), for email authentication (Resend's DKIM/SPF/DMARC on the `send`
  subdomain) and for `staging.` and `www.`
- **Breaks without it:** the site, and all outbound email authentication
- **Should ultimately belong to:** Gerry. It is his brand, not a technical asset.

### Supabase — TWO separate projects, in different accounts
- **PRODUCTION** `wjvkrkbojnemfiuuitmu` — *"Gerwin Trading (Production)"*, region
  ap-southeast-1. **This is the business's real data.**
- **STAGING** `pruhoaqaurhzyvwwnjdk` — *"Inventory"*, disposable. Contains only
  generated test data. Losing it costs nothing.
- The split is documented in `docs/DEPLOYMENT.md`. **Never point tooling at
  production**; `scripts/_env-guard.mjs` enforces this and must not be bypassed.

### Vercel — hosting
- Project `maccky-marine-inventory`, Hobby plan, functions in `sin1` (Singapore)
- Serves `www.gerwintrading.com` (production, branch `main`) and
  `staging.gerwintrading.com` (branch `staging`)
- **Per the service agreement, the developer pays for and manages hosting for
  three years from delivery.** After that it becomes the client's.

### GitHub — source and backups
- Repository `jerry-inventory`. **Must be PRIVATE** — the developer retains
  resale rights and the client is contractually barred from redistributing it.
- Also runs `.github/workflows/db-backup.yml`: a nightly dump of production at
  2:00 AM Manila, kept 90 days as workflow artifacts.
- **This is why repo access matters to the client**, even though the source is
  not theirs to redistribute: their backups live inside it.

### Resend — transactional email
- Sends from `noreply@gerwintrading.com`
- Separate API keys for staging and production, both scoped to the domain
- **Breaks without it:** "Forgot password?" silently stops working. Nobody
  already signed in is affected.

---

## 4. Where the credentials live

**Not in this file, and not in any file.**

Credentials for every account above are kept in **[PASSWORD MANAGER — e.g. a
1Password vault named "Gerwin Trading"]**, which holds the passwords *and* the
two-factor seeds.

- **Emergency access is nominated to: [NAME, CONTACT]**, with a **[N]-day**
  waiting period.
- **Alternative / additional:** a sealed break-glass envelope held by
  **[LAWYER OR SAFE LOCATION]**, refreshed annually.

> **Two-factor is what actually breaks continuity plans.** A successor holding
> only passwords is still locked out, because the codes go to a phone that is no
> longer answered. Whatever mechanism is used, it MUST carry the 2FA seeds or
> recovery codes, or it does not work.

**Fill the bracketed values in before this document is of any use.** An unfilled
continuity plan is worse than none, because it looks like one.

---

## 5. Taking the system over

### Get oriented (about an hour)
1. `CLAUDE.md` — what the business does and how the system models it. Read the
   approval pipeline and the security model. It is long, and it is the single
   most valuable file here: it records not just what the system does but *why*
   each rule is the way it is, which is what stops a successor "fixing"
   something deliberate.
2. `docs/DEPLOYMENT.md` — the environment split, and the runbook for the
   production database.
3. `npm test` — 59 suites against **staging** (the run prints the assertion
   total). If it passes, the system is behaving.

### Which documents to trust

| File | Status |
|---|---|
| `CLAUDE.md` | **Current.** Kept in step with the code; the page inventory is also the commercial record of what was delivered. |
| `docs/DEPLOYMENT.md` | Current. Environments, schema promotion, the production build. |
| `docs/CONTINUITY.md` | This file. Accounts and survival. |
| `docs/RELEASE-fractional-quantities.md` | The worked example of a large schema release — backup, pre-flight, push, verify, rollback. Use it as the template for the next one. |
| `docs/superpowers/plans/*` | Point-in-time working notes. Useful history, not specifications. |
| **`build-prompt.md`** | ⚠️ **STALE — do not orient from it.** |

**`build-prompt.md` is the prompt the system was originally built from, and it
has not been maintained.** It still calls the business "Jerry's Marine"
(renamed in 0060), says deliveries auto-land in shop stock (0028 replaced that
with shop confirmation and a discrepancy queue), lists warranty-certificate
PDFs (retired in 0103), and describes 3–5 branches where there are now ten. A
successor reading it would build a mental model of a system that no longer
exists. It is kept for provenance only.

### Deploy a change
Documented in `docs/DEPLOYMENT.md` §1 and §3. In short: branch → preview URL →
`staging` → `main`. Schema changes travel separately, staging first.

> ⚠️ **The Supabase CLI in the working tree is linked to PRODUCTION**
> (`supabase/.temp/project-ref` = `wjvkrkbojnemfiuuitmu`). That is correct only
> during a deliberate production migration. On any other day, `npx supabase db
> push` from this repo applies migrations straight to the client's live books.
>
> `scripts/_env-guard.mjs` **cannot** stop it: the guard reads `SUPABASE_ENV`
> from `.env.local`, which the CLI never looks at. The guard protects the write
> scripts and leaves the CLI open. Check the link before every push.

### Restore data
`.github/workflows/db-backup.yml` explains it in its header: download the
artifact, gunzip, re-insert with the service role in FK order (the reverse of
`scripts/db-fresh-start.mjs`'s `WIPE_ORDER`).

**Practise this once before you need it.** A restore nobody has rehearsed is a
hope, not a plan.

### The constraints a successor must not "fix"

Several things look like omissions and are not. Changing any of them without
understanding why will break something that currently holds:

- **`stock_movements` is append-only.** No INSERT/UPDATE/DELETE policy exists
  for anyone, owner included. There is a `correction` movement type with zero
  rows and no function that can write one. Do not add an edit path — a
  contra-entry would be a new control decision, not a reporting one.
- **Stock moves only on approval.** Recording a sale deducts nothing. That is
  the entire point of the business model, not a bug.
- **COGS is frozen at approval** in `sale_line_costs`, never read live from
  `parts.cost_centavos`. A live read would let one cost edit silently rewrite
  past profit.
- **Cost is owner-only, with one deliberate narrowing** — a shop sees the cost
  of its own on-hand stock (the *tawad* floor) and nothing else. Never put a
  cost column on an employee-readable table; column grants cannot fix it,
  because owner and employees are both `authenticated`.
- **`movement_journal` reports transit write-offs at a synthetic `transit`
  location.** It is the one movement type that debits a bucket it never
  occupied. Move it back to `master` and the ledger stops reconciling to the
  shelf — `test-movements.mjs` asserts both directions.
- **Quantities are `numeric`, never float.** The ledger invariant is an
  equality, and 0.1 + 0.2 is not 0.3 in binary floating point.

`CLAUDE.md` explains each of these in full. If a change seems to require
breaking one, that is the moment to stop and ask.

### If Vercel is lost but the repo survives
The app is a standard Next.js application with no Vercel-specific APIs. Any
Node host works. What must be reproduced:
- the three environment variables (see `docs/DEPLOYMENT.md` §1)
- the function region — keep it near Singapore, or every page pays the latency
- the domain's DNS pointing at the new host

---

## 6. Known scheduled events

| When | What |
|---|---|
| Annually | Domain renewal (Porkbun). **The one bill that can take the site down.** |
| Daily 01:00 / 01:15 UTC | pg_cron: warranty-expiry and supplier-overdue alerts |
| Daily 02:00 PH | Nightly production backup (GitHub Actions) |
| **3 years from delivery** | Hosting stops being the developer's responsibility and becomes the client's. Agree the handover of billing *before* this date. |

---

## 7. Open items for the owner

- [ ] Domain moved to, or contractually promised to, the client
- [ ] Client holds his own production Supabase credentials — not only the developer
- [ ] Client can reach the nightly backup artifacts independently
- [ ] Password manager emergency access nominated, or sealed envelope lodged
- [ ] Source-escrow clause agreed: the developer retains resale rights while
      living; on death or permanent incapacity the client receives a perpetual
      licence to the delivered source. *(Wording is a matter for a lawyer.)*
- [ ] A named successor developer who has agreed, in principle, to take over
- [ ] Agreed which documents transfer to the client and which sit in escrow —
      `CONTINUITY.md` and `DEPLOYMENT.md` are operational and belong with the
      client; `CLAUDE.md` doubles as the developer's commercial record. Decide
      this deliberately rather than by default.
- [ ] A restore from a backup artifact rehearsed at least once
- [ ] Supabase CLI re-linked to staging, or a written rule that it is only ever
      linked to production during a migration window
- [ ] This document reviewed within the last 12 months
