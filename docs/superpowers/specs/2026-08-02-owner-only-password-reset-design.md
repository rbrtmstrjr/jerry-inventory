# Owner-only password reset — design

**Date:** 2026-08-02
**Status:** approved, awaiting implementation plan
**Touches:** `app/(auth)/login/`, `app/(owner)/shops/actions.ts`, `app/(owner)/settings/actions.ts`, `app/(owner)/settings/account-section.tsx`, `lib/`, `scripts/`

---

## 1. The problem

`/login` offers **Forgot password?**, which calls
`supabase.auth.resetPasswordForEmail(email, { redirectTo })` straight from the
browser — [login-form.tsx:217](../../../app/(auth)/login/login-form.tsx). There
is no role gate. Any account with a reachable mailbox can be reset by whoever
reads that mailbox.

That matters because of who owns credentials in this system. Gerry mints every
shop login ([shops/actions.ts:215](../../../app/(owner)/shops/actions.ts)) and
every admin ([settings/actions.ts:191](../../../app/(owner)/settings/actions.ts)),
and can change either at will
([shops/actions.ts:317](../../../app/(owner)/shops/actions.ts),
[settings/actions.ts:282](../../../app/(owner)/settings/actions.ts)). So for
shops and admins, email-based self-service reset grants **no capability the
system lacks** — it is pure added attack surface. Compromise a branch's inbox
and you have that branch's login; compromise an admin's inbox and you have an
office-tier account that can approve batches and move stock.

Shop logins are the weakest link specifically because they are **shared per
branch**. A shared credential recovered through a shared mailbox is the loosest
root of trust in the application.

### 1.1 State of the accounts (audited 2026-08-02, read-only)

16 live profiles: **1 owner, 2 admins, 13 shop logins**.

| Role | Domain | Business-controlled? |
|---|---|---|
| owner | `@test.com` | No — real domain, third-party owned |
| admin ×2 | `@test.com`, `@gerwin.com` | No — both real, third-party owned |
| shop ×13 | `@gerwin-test.ph` | Almost certainly unregistered |

Every one of these is placeholder data; real client users are not yet onboarded.
Two consequences, both load-bearing for this design:

1. Reset mail for **any** account currently routes to a domain Gerwin does not
   own. For `@test.com` and `@gerwin.com` it reaches a stranger's infrastructure.
2. Restructuring the email scheme is cheap **now** and expensive later. Once
   branch staff sign in daily with these addresses, changing a username is a
   coordinated rollout.

---

## 2. What we are building

**Forgot password becomes owner-only.** The dialog accepts an email, the server
compares it against the owner's registered address, and a reset link is sent only
on a match. Shops and admins recover by contacting Gerry — which is already how
the system is designed to work.

---

## 3. Why one layer is not enough

`resetPasswordForEmail` is not a call to our server. It is a direct browser call
to Supabase's GoTrue API authenticated with the **public anon key**, which ships
in the JS bundle by design. Anyone can reproduce it without loading our page:

```
POST https://<ref>.supabase.co/auth/v1/recover
apikey: <public anon key>
{"email":"ternate@example.com"}
```

It is not a table, so RLS cannot reach it. **Gating the dialog is therefore
theatre** — it stops honest users and zero attackers.

The control needs two layers:

| Layer | Stops | Enforced by |
|---|---|---|
| **App gate** — server-side match against the owner's email | Anyone using our UI | Server action + service role |
| **Non-routable mailboxes** — shop/admin logins have no inbox | Anyone bypassing the UI via the raw endpoint | Physics: `.invalid` never resolves |

Non-routable alone would leave a dialog that appears to work for everyone.
Together the control is both real and legible.

### 3.1 Rejected alternative — Supabase Auth Hook

A Send-Email hook could inspect the account and drop recovery mail for
non-owners. It is genuine enforcement and preserves real mailboxes on shop/admin
accounts. Rejected because it adds a hosted endpoint and a plan-availability
dependency to buy something we get for free once the mailboxes do not exist.

### 3.2 Rejected alternative — in-app MFA

Out of scope. Migrations 0085–0098 were a three-role/2FA/oversight experiment
that was applied and then **fully reverted at the owner's request**; those
migration numbers are retired. This design does not reopen that decision.

---

## 4. Components

### 4.1 Server action — `requestOwnerPasswordReset`

New file `app/(auth)/login/actions.ts`.

1. Zod-validate the email's format.
2. Service-role client → the single `profiles` row with `role='owner'`, `active`,
   `deleted_at is null`.
3. `admin.auth.admin.getUserById(ownerId)` → the owner's stored email.
4. Compare case-insensitively (trim + lowercase) against the submitted string.
5. On match, send the reset **to the stored address**, never to the submitted
   string — the submitted value is attacker-controlled and only ever used for
   comparison.
6. **Always** `return { ok: true }`. Same value on every path, including
   validation failure and internal error.

**Why the service-role client is used with no authenticated caller.**
[admin.ts](../../../lib/supabase/admin.ts) carries the rule *"Every caller must
verify the current user is the owner BEFORE touching this client."* This action
cannot: being locked out is the entire premise. It is a deliberate, documented
exception, and it is safe only because the action is a sealed box — one string
in, one constant out, and its sole side effect is Supabase mailing the owner's
own registered address.

> **Invariant:** `requestOwnerPasswordReset` must never grow a branch that
> returns different data, different shapes, or different error states. The
> moment its output varies with the input, it becomes an oracle for the owner's
> email address. This reasoning belongs in the file header.

**`redirectTo`** derives from the request `Host` header rather than a new env
var, so preview deploys keep working. Supabase's redirect allowlist — configured
2026-08-02 with `https://www.gerwintrading.com/**`,
`https://gerwintrading.com/**`, `https://maccky-marine-inventory.vercel.app/**`
— is the real guard against a spoofed host.

### 4.2 Dialog rewrite — `login-form.tsx`

`ForgotPasswordDialog` calls the server action instead of the Supabase client.
Copy states the rule up front so a locked-out shop employee is not left guessing:

> **Reset owner password**
> Only the owner's registered email can receive a reset link. Shop and admin
> passwords are changed by the owner directly — contact him.

Success state is identical whether or not the address matched:

> If that address matches the owner's, a reset link is on the way.

**Accepted trade-off.** Supabase's `over_email_send_rate_limit` can no longer be
surfaced — showing it would confirm the address matched. Gerry would see the
success message and receive nothing. Mitigation: log the condition server-side.
The existing code has a bespoke message for this error
([login-form.tsx:225](../../../app/(auth)/login/login-form.tsx)), which suggests
it has been hit in practice, so it is worth knowing it now fails quietly.

### 4.3 Enforced domain rule

New `lib/login-email.ts` exports the domain constant and a **pure**
`isNonRoutableLoginEmail()` predicate — pure so
[test-lib-unit.mjs](../../../scripts/test-lib-unit.mjs) can cover it directly
without a database.

Wired into the Zod schemas at all four write points:

- [shops/actions.ts:184](../../../app/(owner)/shops/actions.ts) — create shop login
- [shops/actions.ts:285](../../../app/(owner)/shops/actions.ts) — update shop credentials
- [settings/actions.ts:177](../../../app/(owner)/settings/actions.ts) — create admin
- [settings/actions.ts:262](../../../app/(owner)/settings/actions.ts) — update admin

Both dialogs gain hint text naming the required domain.

**Chosen domain: `gerwintrading.invalid`.** RFC 2606 reserves `.invalid` as
permanently non-resolvable, so no one can ever register it. A domain we merely
do not own today — `gerwin-test.ph` — can be bought tomorrow, at which point
every shop reset email lands in the buyer's inbox.

This follows the codebase's standing preference for enforcement over convention:
0049 revoked catalog `INSERT` rather than removing a button, on the grounds that
a re-added dialog should break at the database rather than fail silently in
production.

### 4.4 Migration script

`scripts/migrate-login-emails.mjs`:

- calls `_env-guard.mjs` like every other write script
- **dry-run by default**, `--yes` to apply
- rewrites the 15 shop/admin addresses to `<localpart>@gerwintrading.invalid`,
  **preserving the local part verbatim**. Local parts are already unique among
  these accounts (auth emails are unique and all shop logins currently share one
  domain), so preserving them cannot introduce a collision.
- **aborts before writing anything** if the rewrite would nonetheless produce a
  duplicate, rather than half-applying. Uniqueness is checked across the whole
  computed set first.
- **skips the owner** — that account must keep a real, reachable mailbox
- prints a before/after table and a summary count

> ⚠️ The env guard will **pass** here because `.env.local` declares
> `SUPABASE_ENV=staging`, while this project (`pruhoaqaurhzyvwwnjdk`) is what
> Vercel Production points at — verified 2026-08-02 by reading
> `NEXT_PUBLIC_SUPABASE_URL` out of the live production bundle. The script does
> the right thing regardless, but the marker is wrong and `db-fresh-start` is
> gated on the same allowlist. Tracked separately; not fixed by this design.

### 4.5 Settings → Account card

[account-section.tsx:338](../../../app/(owner)/settings/account-section.tsx)
routes through the same server action. That page is already gated by
`requirePrimaryOwner()`, so this is consistency rather than security — one code
path for password recovery, one place for tests to target.

The card passes the signed-in user's own email, which on that page is always the
owner's, so it satisfies the same match the login dialog does. No special case
is needed, and the card keeps working unchanged from the user's point of view.

---

## 5. Tests

| Suite | Assertion |
|---|---|
| `test-lib-unit.mjs` | domain validator accepts `.invalid`, rejects real domains, is case-insensitive, rejects malformed input |
| `test-admin-accounts.mjs` | creating or editing a shop/admin login with a routable domain is refused |
| new invariant check | every active non-owner profile's auth email uses the non-routable domain |

The invariant check is the one that matters long-term: it catches an account
created through a path this design did not anticipate.

The server action itself is not directly callable from a Node script. Its
security-critical property — identical output on every path — is covered by
keeping the comparison logic in the pure, unit-tested predicate and keeping the
action's own body branch-free in its return value.

---

## 6. Out of scope

- **In-app MFA** — see §3.2.
- **Supabase Auth Hooks** — see §3.1.
- **Custom SMTP.** Supabase's built-in mailer is development-grade and
  rate-limited. Since owner lockout recovery depends on it, configuring real
  SMTP is worth doing before client handover — but it is independent of this
  change.
- **The `SUPABASE_ENV` marker vs. production mismatch** — see §4.4.

## 7. Blocker for the design to be effective

**Gerry's account email is `@test.com`, a domain a stranger owns.** This entire
design rests on the owner's mailbox being real, reachable, and controlled by
him. Changing it is an operational task, not code, but until it is done the
owner-only reset path delivers to somebody else's infrastructure.

Recommended alongside: 2FA on that mailbox. It is the root of trust for the
whole business — worth more than any control inside the app.
