# Owner-Only Password Reset — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "Forgot password?" work only for the owner's registered email, and make shop/admin logins structurally unresettable by giving them mailboxes that cannot receive mail.

**Architecture:** Two layers. A server action compares the submitted address against the owner's stored address and returns an identical result on every path, so the dialog leaks nothing. Underneath, shop and admin logins are forced onto `@gerwintrading.invalid` — an RFC 2606 reserved TLD that can never resolve — so even a request that bypasses our UI and hits Supabase's public `/auth/v1/recover` endpoint directly generates mail that is delivered nowhere.

**Tech Stack:** Next.js 16 (App Router, server actions), React 19, TypeScript, Zod 4, Supabase (GoTrue auth + service-role admin API), Node test scripts (`scripts/test-*.mjs`).

**Spec:** [`docs/superpowers/specs/2026-08-02-owner-only-password-reset-design.md`](../specs/2026-08-02-owner-only-password-reset-design.md)

## Global Constraints

- **Never run `git commit` or `git push`.** This project's owner runs every commit himself. Commit steps below state exactly what to stage and the message to use — surface the command, do not execute it.
- **Money, dates, soft-delete conventions are untouched by this work.** No migration, no RLS change, no ledger impact.
- **Zod 4 API**: this codebase uses `z.email()` / `z.uuid()`, not `z.string().email()`. Match it.
- **The designated login domain is exactly `gerwintrading.invalid`.** Defined once in `lib/login-email.ts`; never hardcode it elsewhere.
- **The server action must return the identical value on every path.** Any branch that varies its output turns it into an oracle for the owner's email address.
- **Never send reset mail to the submitted string.** Only ever to the owner's stored address, read server-side.
- Run `npx tsc --noEmit` after any TypeScript change; it must exit 0.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `lib/login-email.ts` | **Create.** The domain constant + two pure predicates. Single source of truth for the rule. | 1 |
| `scripts/test-lib-unit.mjs` | **Modify.** Unit coverage for the predicates — no DB. | 1 |
| `app/(auth)/login/actions.ts` | **Create.** `requestOwnerPasswordReset` — the only place the owner match happens. | 2 |
| `app/(auth)/login/login-form.tsx` | **Modify.** `ForgotPasswordDialog` calls the action; copy states the owner-only rule. | 3 |
| `app/(owner)/shops/actions.ts` | **Modify.** Domain rule on `employeeSchema` + `credentialsSchema`. | 4 |
| `app/(owner)/settings/actions.ts` | **Modify.** Domain rule on `createAdminSchema` + `updateCredsSchema`. | 4 |
| `app/(owner)/settings/account-section.tsx` | **Modify.** `ResetCard` routes through the shared action. | 5 |
| `scripts/migrate-login-emails.mjs` | **Create.** One-off, dry-run-by-default migration of the 15 existing accounts. | 6 |
| `scripts/test-owner-reset.mjs` | **Create.** Static wiring check + the live invariant. Auto-discovered by `test-all.mjs`. | 7 |

**Two predicates, deliberately.** `isLoginEmailDomain` is strict (exactly `gerwintrading.invalid`) and guards the credential write paths so Gerry cannot get creative. `isNonRoutableEmail` is broad (any RFC 2606 reserved TLD plus `.local`) and backs the invariant check, which must tolerate the harness's own `@test.local` fixtures — `scripts/_harness.mjs` provisions throwaway accounts on that domain via the service role, and those are legitimate.

---

### Task 1: The domain rule as a pure, tested module

**Files:**
- Create: `lib/login-email.ts`
- Test: `scripts/test-lib-unit.mjs` (modify — append a new section)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `LOGIN_EMAIL_DOMAIN: string` — the literal `"gerwintrading.invalid"`
  - `isLoginEmailDomain(email: string): boolean` — strict, exact-domain match
  - `isNonRoutableEmail(email: string): boolean` — broad, reserved-TLD match

- [ ] **Step 1: Write the failing test**

Append to `scripts/test-lib-unit.mjs`. Add the import at the top of the file, next to the existing `lib/format.ts` and `lib/ph-date.ts` imports:

```js
import {
  LOGIN_EMAIL_DOMAIN, isLoginEmailDomain, isNonRoutableEmail,
} from "../lib/login-email.ts";
```

Append this section at the end of the file, **before** the final `console.log` summary and `process.exit`:

```js
console.log("\nisLoginEmailDomain — strict: only the designated login domain:");
check("constant is gerwintrading.invalid", LOGIN_EMAIL_DOMAIN === "gerwintrading.invalid", LOGIN_EMAIL_DOMAIN);
check("shop-ternate@gerwintrading.invalid", isLoginEmailDomain("shop-ternate@gerwintrading.invalid"));
check("uppercase domain accepted", isLoginEmailDomain("A@GERWINTRADING.INVALID"));
check("surrounding space tolerated", isLoginEmailDomain(" a@gerwintrading.invalid "));
check("gmail rejected", !isLoginEmailDomain("shop@gmail.com"));
check("lookalike subdomain rejected", !isLoginEmailDomain("a@x.gerwintrading.invalid"));
check("suffix-only match rejected", !isLoginEmailDomain("a@notgerwintrading.invalid"));
check("other .invalid domain rejected", !isLoginEmailDomain("a@other.invalid"));
check("no @ rejected", !isLoginEmailDomain("gerwintrading.invalid"));
check("empty local part rejected", !isLoginEmailDomain("@gerwintrading.invalid"));
check("empty string rejected", !isLoginEmailDomain(""));

console.log("\nisNonRoutableEmail — broad: any address that cannot receive mail:");
check(".invalid", isNonRoutableEmail("a@gerwintrading.invalid"));
check(".test (harness fixtures)", isNonRoutableEmail("zz-admin@test.local") || isNonRoutableEmail("zz@x.test"));
check(".local (harness fixtures)", isNonRoutableEmail("zz-admin@test.local"));
check(".example", isNonRoutableEmail("a@foo.example"));
check("gmail.com is routable", !isNonRoutableEmail("a@gmail.com"));
check("gerwin-test.ph is routable", !isNonRoutableEmail("shop@gerwin-test.ph"));
check("test.com is routable (real domain)", !isNonRoutableEmail("gerry@test.com"));
check("no @ rejected", !isNonRoutableEmail("nope"));
check("empty string rejected", !isNonRoutableEmail(""));
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
node scripts/test-lib-unit.mjs
```
Expected: FAIL — `Cannot find module '../lib/login-email.ts'`.

- [ ] **Step 3: Write the implementation**

Create `lib/login-email.ts`:

```ts
/**
 * The one domain shop and admin logins may use.
 *
 * Email is a USERNAME for those accounts, never a contact channel — nobody
 * mails a branch. Giving them an address that cannot receive mail is what
 * makes Supabase's public /auth/v1/recover endpoint harmless: a request that
 * bypasses our UI still produces mail, and that mail is delivered nowhere.
 *
 * `.invalid` is reserved by RFC 2606 as permanently unresolvable, so nobody
 * can ever register it. A domain we merely do not own today (gerwin-test.ph)
 * can be bought tomorrow, at which point every shop reset lands in the
 * buyer's inbox.
 */
export const LOGIN_EMAIL_DOMAIN = "gerwintrading.invalid";

/** RFC 2606 reserved TLDs, plus `.local` (mDNS, never routable on the internet). */
const RESERVED_TLDS = new Set(["invalid", "test", "example", "localhost", "local"]);

/** Lowercased domain part, or null when the string is not shaped like an email. */
function domainOf(email: string): string | null {
  const at = email.trim().lastIndexOf("@");
  const trimmed = email.trim();
  if (at <= 0 || at === trimmed.length - 1) return null;
  return trimmed.slice(at + 1).toLowerCase();
}

/**
 * STRICT — exactly the designated login domain. Guards the credential write
 * paths so a shop or admin login can never be minted on a real mailbox.
 */
export function isLoginEmailDomain(email: string): boolean {
  return domainOf(email) === LOGIN_EMAIL_DOMAIN;
}

/**
 * BROAD — any address that cannot receive mail. Backs the invariant check,
 * which must tolerate the test harness's own `@test.local` fixtures
 * (scripts/_harness.mjs provisions those through the service role, which
 * bypasses the Zod rule above by design).
 */
export function isNonRoutableEmail(email: string): boolean {
  const domain = domainOf(email);
  if (!domain) return false;
  const dot = domain.lastIndexOf(".");
  if (dot < 0) return false;
  return RESERVED_TLDS.has(domain.slice(dot + 1));
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
node scripts/test-lib-unit.mjs
```
Expected: PASS — every new check ✓, exit 0.

- [ ] **Step 5: Typecheck**

```bash
npx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 6: Stage for commit (do not run `git commit` — surface it to the user)**

```bash
git add lib/login-email.ts scripts/test-lib-unit.mjs
git commit -m "feat: add login email domain rule as a pure, tested module"
```

---

### Task 2: The owner-match server action

**Files:**
- Create: `app/(auth)/login/actions.ts`

**Interfaces:**
- Consumes: `createAdminClient()` from `lib/supabase/admin` (existing)
- Produces: `requestOwnerPasswordReset(input: unknown): Promise<{ ok: true }>` — used by Task 3 and Task 5

- [ ] **Step 1: Write the implementation**

There is no unit test for this task — the action is a Next server action and cannot be invoked from a Node script. Its security property (identical output on every path) is enforced by the single `return DONE` and asserted structurally in Task 7. Its comparison logic is the already-tested predicate style from Task 1.

Create `app/(auth)/login/actions.ts`:

```ts
"use server";

import { headers } from "next/headers";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Owner-only password reset.
 *
 * WHY THIS EXISTS: Gerry mints and can change every shop and admin credential,
 * so email-based self-service reset gives those accounts no capability the
 * system lacks — only attack surface. Compromise a branch's shared inbox and
 * you have that branch's login. This narrows the reset path to the one account
 * nobody else can rescue.
 *
 * WHY THE SERVICE ROLE WITH NO SIGNED-IN CALLER: lib/supabase/admin.ts carries
 * the rule "every caller must verify the current user is the owner BEFORE
 * touching this client". This action cannot — being locked out is the entire
 * premise. It is a deliberate exception, and it is safe ONLY because this
 * function is a sealed box: one string in, one constant out, and its sole side
 * effect is Supabase mailing the owner's own stored address.
 *
 * >>> INVARIANT: every path returns the SAME value. <<<
 * The moment this returns different data, shapes, or errors depending on the
 * input, it becomes an oracle that confirms the owner's email address to
 * anyone who can POST to it. Do not add a branch that reports failure.
 *
 * KNOWN, ACCEPTED LIMITATION: the matching path makes one extra network call,
 * so a determined attacker could in principle time the difference. Closing
 * that would mean issuing a decoy request on every miss; it is not worth the
 * complexity when Supabase already rate-limits recovery and the address being
 * protected is guessable anyway.
 */

const schema = z.object({ email: z.string().trim().min(1).max(200) });

export type OwnerResetResult = { ok: true };

/** The one and only return value. Never construct another. */
const DONE: OwnerResetResult = { ok: true };

export async function requestOwnerPasswordReset(
  input: unknown
): Promise<OwnerResetResult> {
  try {
    const parsed = schema.safeParse(input);
    if (!parsed.success) return DONE;

    const submitted = parsed.data.email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(submitted)) return DONE;

    const admin = createAdminClient();

    // The owner is a single account: profiles.role = 'owner'.
    const { data: ownerProfile } = await admin
      .from("profiles")
      .select("id")
      .eq("role", "owner")
      .eq("active", true)
      .is("deleted_at", null)
      .limit(1)
      .maybeSingle();
    if (!ownerProfile) return DONE;

    const { data: ownerUser } = await admin.auth.admin.getUserById(ownerProfile.id);
    const ownerEmail = ownerUser?.user?.email?.trim() ?? "";
    if (!ownerEmail) return DONE;
    if (ownerEmail.toLowerCase() !== submitted) return DONE;

    // Origin from the request, not an env var, so preview deploys keep working.
    // Supabase's redirect allowlist is the real guard against a spoofed Host.
    const h = await headers();
    const host = h.get("host");
    if (!host) return DONE;
    const proto = h.get("x-forwarded-proto") ?? "https";
    const origin = `${proto}://${host}`;

    // A bare anon client: no cookies, no session, nothing to leak. Sends to the
    // STORED address — never the caller-supplied string.
    const anon = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );

    const { error } = await anon.auth.resetPasswordForEmail(ownerEmail, {
      redirectTo: `${origin}/auth/callback?next=/auth/reset`,
    });

    // Logged, never returned. A rate-limit or send failure is invisible to the
    // caller by design — surfacing it would confirm the address matched.
    if (error) {
      console.error("[owner-reset] send failed:", error.code ?? error.message);
    }
  } catch (e) {
    console.error("[owner-reset] unexpected:", e);
  }
  return DONE;
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```
Expected: exit 0.

- [ ] **Step 3: Verify the build compiles the new server action**

```bash
npx next build
```
Expected: compiles successfully. A `"use server"` file that exports a non-async value fails here, so this is the real gate.

- [ ] **Step 4: Stage for commit (do not run `git commit`)**

```bash
git add "app/(auth)/login/actions.ts"
git commit -m "feat: owner-only password reset server action"
```

---

### Task 3: Rewrite the login dialog

**Files:**
- Modify: `app/(auth)/login/login-form.tsx` (the `ForgotPasswordDialog` component, currently lines 197-296)

**Interfaces:**
- Consumes: `requestOwnerPasswordReset` from Task 2
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the import**

At the top of `app/(auth)/login/login-form.tsx`, alongside the existing imports:

```ts
import { requestOwnerPasswordReset } from "./actions";
```

- [ ] **Step 2: Replace the whole `ForgotPasswordDialog` component**

Replace the component (its doc comment through its closing brace) with:

```tsx
/**
 * The way back in — OWNER ONLY.
 *
 * Shop and admin credentials are minted and changed by the owner, so a reset
 * path for them is attack surface with no matching capability: whoever reads a
 * branch's shared inbox would own that branch's login. Only the owner's
 * registered address can produce a link, and the server decides that — this
 * dialog never learns whether the address matched.
 *
 * If it breaks, Gerry is locked out of his own business with no support desk
 * to call, so it stays as simple as it can possibly be.
 */
function ForgotPasswordDialog({
  onOpenChange,
  defaultEmail,
}: {
  onOpenChange: (v: boolean) => void;
  defaultEmail?: string;
}) {
  const [email, setEmail] = React.useState(defaultEmail ?? "");
  const [busy, setBusy] = React.useState(false);
  const [sent, setSent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function onSend() {
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError("Enter a valid email address");
      return;
    }
    setError(null);
    setBusy(true);
    // Deliberately ignores the result: the action returns the same value
    // whether or not the address matched. There is nothing to branch on.
    await requestOwnerPasswordReset({ email });
    setBusy(false);
    setSent(true);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset owner password</DialogTitle>
          <DialogDescription>
            Only the owner&apos;s registered email can receive a reset link.
            Shop and admin passwords are changed by the owner directly — contact
            him.
          </DialogDescription>
        </DialogHeader>

        {sent ? (
          <div className="grid gap-2 text-sm">
            {/* Says the same thing whether or not the address matched. Telling
                the user "that is not the owner's email" would turn this form
                into an oracle for locating his mailbox. */}
            <p>
              If that address matches the owner&apos;s, a reset link is on its
              way. It lasts about an hour.
            </p>
            <p className="text-muted-foreground">
              No other address will receive a link. If nothing arrives, check
              the spelling and try again.
            </p>
            <p className="text-muted-foreground">
              Open the link in this same browser — for security the link is tied
              to the browser that asked for it.
            </p>
          </div>
        ) : (
          <div className="grid gap-2">
            <Label htmlFor="forgot-email">Owner email</Label>
            <Input
              id="forgot-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@example.com"
            />
            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {sent ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <Button onClick={onSend} disabled={busy || !email}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Send reset link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Remove the now-unused client import if it is orphaned**

`createClient` from `@/lib/supabase/client` is still used by `LoginForm.onSubmit` for `signInWithPassword`. **Leave the import in place.** Verify with:

```bash
grep -n "createClient" "app/(auth)/login/login-form.tsx"
```
Expected: at least one remaining usage inside `onSubmit`.

- [ ] **Step 4: Typecheck and lint**

```bash
npx tsc --noEmit && npx next lint --file "app/(auth)/login/login-form.tsx"
```
Expected: exit 0. An unused import would fail lint here.

- [ ] **Step 5: Verify in the browser**

```bash
npm run dev
```
Open `/login`, click **Forgot password?**. Confirm: title reads "Reset owner password", the description names the owner-only rule, and submitting *any* syntactically valid address shows the same "If that address matches the owner's…" panel.

- [ ] **Step 6: Stage for commit (do not run `git commit`)**

```bash
git add "app/(auth)/login/login-form.tsx"
git commit -m "feat: forgot-password dialog is owner-only and leaks nothing"
```

---

### Task 4: Enforce the domain on every credential write

**Files:**
- Modify: `app/(owner)/shops/actions.ts` — `employeeSchema` (line ~184), `credentialsSchema` (line ~283)
- Modify: `app/(owner)/settings/actions.ts` — `createAdminSchema` (line ~175), `updateCredsSchema` (line ~258)

**Interfaces:**
- Consumes: `LOGIN_EMAIL_DOMAIN`, `isLoginEmailDomain` from Task 1
- Produces: nothing consumed by later tasks

- [ ] **Step 1: Add the import to `app/(owner)/shops/actions.ts`**

```ts
import { LOGIN_EMAIL_DOMAIN, isLoginEmailDomain } from "@/lib/login-email";
```

- [ ] **Step 2: Apply the rule to both shop schemas**

Replace `employeeSchema`:

```ts
// Shop logins use email as a USERNAME, never a contact channel — see
// lib/login-email.ts. Forcing a non-routable domain is what makes Supabase's
// public recover endpoint harmless for these accounts.
const employeeSchema = z.object({
  email: z
    .email("Valid email required")
    .refine(isLoginEmailDomain, `Shop logins must use @${LOGIN_EMAIL_DOMAIN}`),
  password: z.string().min(8, "Password needs at least 8 characters"),
  full_name: z.string().trim().min(1, "Name is required"),
  shop_id: z.uuid("Pick a shop"),
});
```

Replace `credentialsSchema`:

```ts
const credentialsSchema = z.object({
  id: z.uuid(),
  email: z
    .email("Valid email required")
    .refine(isLoginEmailDomain, `Shop logins must use @${LOGIN_EMAIL_DOMAIN}`),
  password: z
    .string()
    .min(8, "Password needs at least 8 characters")
    .optional()
    .or(z.literal("")),
  active: z.boolean(),
});
```

- [ ] **Step 3: Add the import to `app/(owner)/settings/actions.ts`**

```ts
import { LOGIN_EMAIL_DOMAIN, isLoginEmailDomain } from "@/lib/login-email";
```

- [ ] **Step 4: Apply the rule to both admin schemas**

Replace `createAdminSchema`:

```ts
const createAdminSchema = z.object({
  full_name: z.string().trim().min(1, "Name is required"),
  email: z
    .email("Valid email required")
    .refine(isLoginEmailDomain, `Admin logins must use @${LOGIN_EMAIL_DOMAIN}`),
  password: z.string().min(8, "Password needs at least 8 characters"),
});
```

Replace `updateCredsSchema`. Note the `.refine` sits on the email **before** `.optional()`, so an omitted email is still allowed but a supplied one is checked:

```ts
const updateCredsSchema = z
  .object({
    id: z.uuid(),
    full_name: z.string().trim().min(1).optional(),
    email: z
      .email("Valid email required")
      .refine(isLoginEmailDomain, `Admin logins must use @${LOGIN_EMAIL_DOMAIN}`)
      .optional(),
    password: z.string().min(8, "Password needs at least 8 characters").optional(),
  })
  .refine((v) => v.full_name || v.email || v.password, {
    message: "Nothing to change",
  });
```

- [ ] **Step 5: Add hint text to both credential dialogs**

The two components are:
- `app/(owner)/shops/shops-view.tsx` — renders `createEmployee` + `updateShopCredentials`
- `app/(owner)/settings/admin-accounts-section.tsx` — renders `createAdminAccount` + `updateAdminCredentials`

In each, add this import:

```ts
import { LOGIN_EMAIL_DOMAIN } from "@/lib/login-email";
```

Then, directly below each email `<Input>` in those files, add:

```tsx
<p className="text-xs text-muted-foreground">
  Must end in <code>@{LOGIN_EMAIL_DOMAIN}</code> — these logins sign in with an
  email but never receive one.
</p>
```

Find the exact input elements with:

```bash
grep -n 'type="email"' "app/(owner)/shops/shops-view.tsx" "app/(owner)/settings/admin-accounts-section.tsx"
```

- [ ] **Step 6: Typecheck and build**

```bash
npx tsc --noEmit && npx next build
```
Expected: both exit 0.

- [ ] **Step 7: Verify by hand**

`npm run dev`, sign in as the owner. Shops & Employees → create a shop login with `x@gmail.com` → expect **"Shop logins must use @gerwintrading.invalid"**. Retry with `x@gerwintrading.invalid` → accepted. Repeat in Settings → Admins.

- [ ] **Step 8: Stage for commit (do not run `git commit`)**

```bash
git add "app/(owner)/shops/actions.ts" "app/(owner)/settings/actions.ts" app
git commit -m "feat: shop and admin logins must use the non-routable domain"
```

---

### Task 5: Route the Settings reset card through the shared action

**Files:**
- Modify: `app/(owner)/settings/account-section.tsx` — the `ResetCard` component, `onSend` at line ~334

**Interfaces:**
- Consumes: `requestOwnerPasswordReset` from Task 2
- Produces: nothing

- [ ] **Step 1: Add the import**

```ts
import { requestOwnerPasswordReset } from "@/app/(auth)/login/actions";
```

- [ ] **Step 2: Replace `onSend`**

The card passes the signed-in user's own email. That page is gated by `requirePrimaryOwner()`, so it is always the owner's address and satisfies the same match — no special case needed.

```ts
  async function onSend() {
    if (!email) return;
    setBusy(true);
    // Same path as the login dialog (app/(auth)/login/actions.ts): one code
    // path for password recovery. Returns the same value regardless, so there
    // is nothing to branch on — this page is requirePrimaryOwner()-gated, so
    // `email` is always the owner's address.
    await requestOwnerPasswordReset({ email });
    setBusy(false);
    setSent(true);
  }
```

- [ ] **Step 3: Leave the existing imports alone — verified still in use**

`createClient` is used at lines 86 and 127 (the change-password and change-email forms), and `toast` is used throughout that file. **Both imports stay.** Confirm nothing was orphaned:

```bash
npx next lint --file "app/(owner)/settings/account-section.tsx"
```
Expected: exit 0, no unused-import warnings.

- [ ] **Step 4: Typecheck and lint**

```bash
npx tsc --noEmit && npx next lint --file "app/(owner)/settings/account-section.tsx"
```
Expected: exit 0.

- [ ] **Step 5: Stage for commit (do not run `git commit`)**

```bash
git add "app/(owner)/settings/account-section.tsx"
git commit -m "refactor: settings reset card uses the shared owner-reset action"
```

---

### Task 6: Migrate the 15 existing shop and admin accounts

**Files:**
- Create: `scripts/migrate-login-emails.mjs`

**Interfaces:**
- Consumes: `LOGIN_EMAIL_DOMAIN` from Task 1, `assertWritableEnv` from `scripts/_env-guard.mjs`
- Produces: nothing

- [ ] **Step 1: Write the script**

Create `scripts/migrate-login-emails.mjs`:

```js
/**
 * ONE-OFF — move every shop and admin login onto the non-routable domain.
 *
 * Email is a USERNAME for these accounts (see lib/login-email.ts). Once they
 * cannot receive mail, Supabase's public /auth/v1/recover endpoint is harmless
 * for them and password recovery is exclusively "ask the owner" — which is how
 * the system was already designed to work.
 *
 * The OWNER is deliberately skipped: his mailbox must stay real and reachable,
 * because his is the one account nobody else can rescue.
 *
 *   node scripts/migrate-login-emails.mjs          # dry run (default)
 *   node scripts/migrate-login-emails.mjs --yes    # apply
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// Refuse to touch a non-disposable database (see scripts/_env-guard.mjs).
import { assertWritableEnv } from "./_env-guard.mjs";
assertWritableEnv("migrate-login-emails");

// Imported, never re-declared — one source of truth for the rule. Node strips
// the .ts types the same way scripts/test-lib-unit.mjs already relies on.
import { LOGIN_EMAIL_DOMAIN } from "../lib/login-email.ts";

const APPLY = process.argv.includes("--yes");

const env = Object.fromEntries(
  readFileSync(new URL("../.env.local", import.meta.url), "utf8")
    .split(/\r?\n/).filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])
);
const a = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: profiles, error: pErr } = await a
  .from("profiles").select("id, role, active").is("deleted_at", null);
if (pErr) { console.error("profiles read failed:", pErr.message); process.exit(1); }

const { data: userPage, error: uErr } = await a.auth.admin.listUsers({ page: 1, perPage: 1000 });
if (uErr) { console.error("auth listUsers failed:", uErr.message); process.exit(1); }
const emailById = new Map(userPage.users.map((u) => [u.id, u.email ?? ""]));

// Owner is skipped on purpose — see the header.
const targets = profiles
  .filter((p) => p.role !== "owner")
  .map((p) => ({ ...p, email: emailById.get(p.id) ?? "" }))
  .filter((p) => p.email && !p.email.toLowerCase().endsWith(`@${LOGIN_EMAIL_DOMAIN}`));

const localPart = (e) => e.slice(0, e.lastIndexOf("@")).toLowerCase();
const planned = targets.map((t) => ({
  ...t, next: `${localPart(t.email)}@${LOGIN_EMAIL_DOMAIN}`,
}));

// Uniqueness across the WHOLE computed set, checked before anything is written
// — a half-applied rename would leave accounts nobody can sign in as.
const seen = new Map();
const collisions = [];
for (const p of planned) {
  if (seen.has(p.next)) collisions.push(`${p.next}  (${seen.get(p.next)} and ${p.email})`);
  else seen.set(p.next, p.email);
}
const existing = new Set(
  userPage.users.map((u) => (u.email ?? "").toLowerCase())
    .filter((e) => e.endsWith(`@${LOGIN_EMAIL_DOMAIN}`))
);
for (const p of planned) {
  if (existing.has(p.next)) collisions.push(`${p.next}  (already in use by another account)`);
}
if (collisions.length) {
  console.error("REFUSED — the rewrite would create duplicate addresses:");
  for (const c of collisions) console.error("  " + c);
  console.error("\nNothing was written. Resolve the local parts first.");
  process.exit(1);
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${planned.length} account(s) to migrate\n`);
console.log("role      before                              after");
for (const p of planned) {
  console.log(String(p.role).padEnd(9), p.email.padEnd(35), p.next);
}
const ownerCount = profiles.filter((p) => p.role === "owner").length;
console.log(`\nowner accounts skipped: ${ownerCount}`);

if (!APPLY) {
  console.log("\nNothing written. Re-run with --yes to apply.");
  process.exit(0);
}

let done = 0;
for (const p of planned) {
  const { error } = await a.auth.admin.updateUserById(p.id, {
    email: p.next, email_confirm: true,
  });
  if (error) { console.error(`  ✗ ${p.email}: ${error.message}`); continue; }
  done++;
  console.log(`  ✓ ${p.email} → ${p.next}`);
}
console.log(`\n${done}/${planned.length} migrated.`);
process.exit(done === planned.length ? 0 : 1);
```

- [ ] **Step 2: Run the dry run**

```bash
node scripts/migrate-login-emails.mjs
```
Expected: a table of 15 rows (13 shop + 2 admin), `owner accounts skipped: 1`, and "Nothing written."

**STOP HERE and show the dry-run output to the user before applying.** This writes to the database Vercel Production points at.

- [ ] **Step 3: Apply, once the user approves the dry run**

```bash
node scripts/migrate-login-emails.mjs --yes
```
Expected: `15/15 migrated.`

- [ ] **Step 4: Verify sign-in still works**

`npm run dev`, sign in with one migrated shop login using its **new** address and its unchanged password. Expected: lands on `/shop`.

- [ ] **Step 5: Stage for commit (do not run `git commit`)**

```bash
git add scripts/migrate-login-emails.mjs
git commit -m "chore: one-off migration of shop and admin logins to the non-routable domain"
```

---

### Task 7: Lock the rule in with tests

**Files:**
- Create: `scripts/test-owner-reset.mjs` (auto-discovered — `test-all.mjs` globs `test-*.mjs`, no registration needed)

**Interfaces:**
- Consumes: `isNonRoutableEmail` from Task 1, `owner`/`check`/`section`/`summary` from `scripts/_harness.mjs`
- Produces: nothing

- [ ] **Step 1: Write the suite**

Create `scripts/test-owner-reset.mjs`:

```js
/**
 * Owner-only password reset — the two things that can silently regress.
 *
 * 1. STATIC: the domain rule is actually wired into all four credential write
 *    paths. Zod schemas live in server actions, which a Node script cannot
 *    invoke — so this asserts over the SOURCE, the same way
 *    test-definer-guards.mjs asserts over migration SQL. It fails the moment
 *    someone edits a schema and drops the refine.
 *
 * 2. LIVE: every active non-owner account has a non-routable address. This is
 *    the assertion that catches an account created through a path this design
 *    did not anticipate.
 *
 * Run: node scripts/test-owner-reset.mjs
 */
import { readFileSync } from "node:fs";
import { owner, admin, check, section, summary } from "./_harness.mjs";
import { isNonRoutableEmail } from "../lib/login-email.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

section("The domain rule is wired into every credential write path");
{
  const shops = read("app/(owner)/shops/actions.ts");
  const settings = read("app/(owner)/settings/actions.ts");

  check("shops/actions.ts imports the rule", shops.includes("isLoginEmailDomain"));
  check("settings/actions.ts imports the rule", settings.includes("isLoginEmailDomain"));

  // One refine per schema: employee + credentials, createAdmin + updateCreds.
  const shopRefines = (shops.match(/refine\(isLoginEmailDomain/g) ?? []).length;
  const settingsRefines = (settings.match(/refine\(isLoginEmailDomain/g) ?? []).length;
  check(`shops: 2 schemas guarded (found ${shopRefines})`, shopRefines === 2, `${shopRefines}`);
  check(`settings: 2 schemas guarded (found ${settingsRefines})`, settingsRefines === 2, `${settingsRefines}`);
}

section("The reset action cannot become an oracle");
{
  const action = read("app/(auth)/login/actions.ts");
  // Every early exit returns the same constant. A literal object return would
  // be a second shape and is the regression this catches.
  const returns = (action.match(/return\s+DONE;/g) ?? []).length;
  check(`all exits return DONE (found ${returns})`, returns >= 5, `${returns}`);
  check("no literal { ok: ... } returns", !/return\s*\{\s*ok:/.test(action));
  check("sends to the stored address, not the submitted one",
    action.includes("resetPasswordForEmail(ownerEmail"));
}

section("Live: every active non-owner login is non-routable");
{
  const { data: profiles, error } = await owner
    .from("profiles").select("id, role, active").is("deleted_at", null);
  check("read profiles", !error, error?.message);

  const { data: page } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const emailById = new Map((page?.users ?? []).map((u) => [u.id, u.email ?? ""]));

  const offenders = (profiles ?? [])
    .filter((p) => p.role !== "owner" && p.active)
    .map((p) => ({ role: p.role, email: emailById.get(p.id) ?? "" }))
    .filter((p) => p.email && !isNonRoutableEmail(p.email));

  check(
    `no active non-owner account can receive mail (${offenders.length} offender(s))`,
    offenders.length === 0,
    offenders.map((o) => `${o.role}:${o.email}`).join(", ")
  );

  // The owner is the deliberate exception and MUST stay reachable.
  const ownerProfile = (profiles ?? []).find((p) => p.role === "owner" && p.active);
  const ownerEmail = ownerProfile ? emailById.get(ownerProfile.id) ?? "" : "";
  check("owner still has a routable address", !!ownerEmail && !isNonRoutableEmail(ownerEmail),
    ownerEmail || "(none)");
}

summary();
```

- [ ] **Step 2: Run the suite**

```bash
node scripts/test-owner-reset.mjs
```
Expected: all checks ✓, exit 0. If the live section reports offenders, Task 6's migration has not been applied yet — apply it, then re-run.

- [ ] **Step 3: Confirm it is picked up by the full run**

```bash
node scripts/test-all.mjs --only=owner-reset
```
Expected: the suite appears in the results table and passes.

- [ ] **Step 4: Run the neighbouring suites for regressions**

```bash
node scripts/test-all.mjs --only=admin-accounts
node scripts/test-lib-unit.mjs
```
Expected: both pass. `test-admin-accounts` provisions accounts through the service role, which bypasses Zod by design, so it must be unaffected.

- [ ] **Step 5: Stage for commit (do not run `git commit`)**

```bash
git add scripts/test-owner-reset.mjs
git commit -m "test: lock in the owner-only reset rule and the non-routable invariant"
```

---

## Final verification

- [ ] `npx tsc --noEmit` — exit 0
- [ ] `npx next build` — compiles
- [ ] `node scripts/test-all.mjs` — full suite green
- [ ] Manual: `/login` → Forgot password → any address shows the same panel
- [ ] Manual: the owner's real address produces an email that lands on `/auth/reset`
- [ ] Manual: Shops & Employees rejects a `@gmail.com` shop login

## Follow-ups (NOT in this plan)

- **Gerry's account email is `@test.com`, a domain a stranger owns.** This design does nothing until that is a mailbox he controls. Operational, not code.
- **`SUPABASE_ENV=staging` while the project is production.** The migration script's guard passes because of it; so would `db-fresh-start`, which deletes everything. Tracked separately.
- **Custom SMTP.** Supabase's built-in mailer is development-grade and rate-limited, and owner lockout recovery now depends entirely on it.
