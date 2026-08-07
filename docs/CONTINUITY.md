# Continuity — running Gerwin Trading without the original developer

**Who this is for:** Gerry Mitante (the owner), and any developer who takes this
system over — including at short notice.

**What it is:** a map of every account the system depends on, what breaks
without each one, and where its credential is kept.

**What it deliberately is NOT:** a place where credentials are written down.
Not one password, key, or connection string appears in this file, and none ever
should. See *Where the credentials live* below.

> **Last reviewed: 2026-08-03.** Re-read it once a year — passwords rotate,
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
   approval pipeline and the security model.
2. `docs/DEPLOYMENT.md` — the environment split, and the runbook for the
   production database.
3. `npm test` — 57 suites, ~1,800 assertions, against **staging**. If it passes,
   the system is behaving.

### Deploy a change
Documented in `docs/DEPLOYMENT.md` §1 and §3. In short: branch → preview URL →
`staging` → `main`. Schema changes travel separately, staging first.

### Restore data
`.github/workflows/db-backup.yml` explains it in its header: download the
artifact, gunzip, re-insert with the service role in FK order (the reverse of
`scripts/db-fresh-start.mjs`'s `WIPE_ORDER`).

**Practise this once before you need it.** A restore nobody has rehearsed is a
hope, not a plan.

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
- [ ] This document reviewed within the last 12 months
