# Supabase auth email templates — Gerwin Trading

Paste these into **Authentication → Emails → Templates** in *both* Supabase
projects. They are not decoration: the default templates are unbranded Supabase
boilerplate that reads as phishing, and — more importantly — their
`{{ .ConfirmationURL }}` routes through Supabase's own verify endpoint, which
returns its result in a URL **fragment** that no server can read. Every
"Access denied" seen on 2026-08-03 came from that.

**The load-bearing line in every template below:**

```
{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=<type>
```

That sends the recipient straight to `/auth/confirm` (or `/auth/callback`) with
the token in the QUERY STRING, where the route handler can verify it server-side
and show a real message.

`{{ .RedirectTo }}` is whatever `emailRedirectTo` the app passed, so it points at
`localhost:3000` when testing locally and the real domain in staging/production.
**The app must therefore pass a bare URL with no query string of its own** — see
`account-section.tsx`.

## `{{ .Email }}` is NOT the new address

In the Change Email template:

| Variable | Is |
|---|---|
| `{{ .Email }}` | the **current** address — the one being changed *away from* |
| `{{ .NewEmail }}` | the **new** address |

Using `.Email` produces an email that says "change your address to
<old address>", which reads as broken and cost an afternoon on 2026-08-03.
The templates below use `.NewEmail`.

## "Secure email change" — the setting, not the code

While **Authentication → Sign In / Providers → Email → Secure email change** is
ON (Supabase's default), Supabase mails BOTH the old and the new address and
does not swap until both are confirmed. No template or application code changes
that; it is the only lever.

Gerwin runs with it **OFF**: the app already re-authenticates with the current
password before calling `updateUser`, so a link to the old inbox adds friction
without adding protection for a single-owner business.

`/auth/confirm` handles either setting correctly — it re-reads the user after
verifying and only claims success when `new_email` has actually cleared.

## Why the markup looks like 2005

Email clients are not browsers. Gmail strips `<style>` blocks, Outlook renders
with Word's engine, and neither supports flexbox, grid, or CSS variables. So:
tables for layout, inline styles only, one 600px column, web-safe font stack.
The result is deliberately conservative — it renders the same in Gmail, Outlook,
Apple Mail and every Android client.

Two details that matter and are easy to miss:

- **The preheader** (the hidden span after `<body>`) is the grey preview text in
  the inbox list. Without it, clients scrape the first visible text, which is
  usually the heading repeated — or worse, the footer.
- **The plain-text link at the bottom.** Some clients strip anchors, and some
  people rightly refuse to click a button in an email. Without a visible URL
  they are stuck.

---

## 1. Change Email Address

**Subject:** `Confirm your new Gerwin Trading sign-in email`

```html
<body style="margin:0;padding:0;background-color:#f1f5f9;">
  <span style="display:none;font-size:1px;color:#f1f5f9;max-height:0;overflow:hidden;">
    Confirm {{ .NewEmail }} as your new sign-in address.
  </span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

          <tr>
            <td style="background-color:#1e293b;padding:24px 32px;">
              <div style="color:#ffffff;font-size:18px;font-weight:700;">Gerwin Trading</div>
              <div style="color:#94a3b8;font-size:13px;margin-top:2px;">Inventory &amp; Approvals</div>
            </td>
          </tr>

          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;color:#0f172a;">
                Confirm your new sign-in email
              </h1>
              <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#334155;">
                A request was made to change the Gerwin Trading sign-in address to
                <strong style="color:#0f172a;">{{ .NewEmail }}</strong>.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
                <tr>
                  <td style="border-radius:8px;background-color:#2563eb;">
                    <a href="{{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email_change"
                       style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                      Confirm this address
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#64748b;">
                This link works once and expires. Once confirmed you'll be signed
                out everywhere and will sign in with the new address.
              </p>
              <p style="margin:0;font-size:14px;line-height:1.6;color:#64748b;">
                If you didn't request this, ignore this email — nothing changes
                and your current address keeps working.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:0 32px 28px;">
              <div style="border-top:1px solid #e2e8f0;padding-top:16px;">
                <p style="margin:0 0 6px;font-size:12px;color:#94a3b8;">
                  If the button doesn't work, paste this into your browser:
                </p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:#2563eb;word-break:break-all;">
                  {{ .RedirectTo }}?token_hash={{ .TokenHash }}&type=email_change
                </p>
              </div>
            </td>
          </tr>

          <tr>
            <td style="background-color:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                Gerwin Trading · Inventory &amp; Approvals
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
```

---

## 2. Reset Password

**Subject:** `Reset your Gerwin Trading password`

### This one keeps `{{ .ConfirmationURL }}` — do NOT convert it to a token hash

Password reset and email change use **different mechanisms**, and only one of
them was broken:

| Flow | Called by | Supabase returns | Handled by |
|---|---|---|---|
| **Reset password** | `resetPasswordForEmail` (PKCE) | `?code=…` in the **query** | `/auth/callback` ✅ always worked |
| **Change email** | `updateUser({ email })` | result in the **fragment** | nothing could read it ❌ |

Reset is a PKCE flow: the browser that asked for it holds a code verifier in a
cookie, Supabase hands back a one-time `code` in the query string, and
`/auth/callback` exchanges it. `{{ .ConfirmationURL }}` produces exactly that.

Rewriting it to `{{ .RedirectTo }}?token_hash=…` breaks it twice over:
`{{ .RedirectTo }}` here is already `…/auth/callback?next=/auth/reset` — it has a
query string, so appending `?` makes a malformed URL — and `/auth/callback`
reads `code`, not `token_hash`.

**So: restyle the reset email, don't re-plumb it.**

```html
<body style="margin:0;padding:0;background-color:#f1f5f9;">
  <span style="display:none;font-size:1px;color:#f1f5f9;max-height:0;overflow:hidden;">
    Choose a new password for your Gerwin Trading account.
  </span>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

          <tr>
            <td style="background-color:#1e293b;padding:24px 32px;">
              <div style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-0.01em;">Gerwin Trading</div>
              <div style="color:#94a3b8;font-size:13px;margin-top:2px;">Inventory &amp; Approvals</div>
            </td>
          </tr>

          <tr>
            <td style="padding:32px;">
              <h1 style="margin:0 0 16px;font-size:20px;line-height:1.4;color:#0f172a;font-weight:700;">
                Reset your password
              </h1>

              <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#334155;">
                A password reset was requested for your Gerwin Trading account.
                Choose a new password using the link below.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px;">
                <tr>
                  <td style="border-radius:8px;background-color:#2563eb;">
                    <a href="{{ .ConfirmationURL }}"
                       style="display:inline-block;padding:13px 28px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">
                      Choose a new password
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#64748b;">
                This link works once and expires in one hour. Open it in the same
                browser you requested it from.
              </p>

              <p style="margin:0;font-size:14px;line-height:1.6;color:#64748b;">
                If you didn't request this, ignore this email — your password
                stays exactly as it is.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:0 32px 28px;">
              <div style="border-top:1px solid #e2e8f0;padding-top:16px;">
                <p style="margin:0 0 6px;font-size:12px;color:#94a3b8;">
                  If the button doesn't work, paste this into your browser:
                </p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:#2563eb;word-break:break-all;">
                  {{ .ConfirmationURL }}
                </p>
              </div>
            </td>
          </tr>

          <tr>
            <td style="background-color:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#94a3b8;">
                Gerwin Trading · Inventory &amp; Approvals<br />
                This is an automated message — please don't reply.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
```

**"Open it in the same browser you requested it from"** is not filler. PKCE keeps
the code verifier in a cookie belonging to the requesting browser, so a link
requested on a laptop and opened on a phone genuinely cannot work — and without
that line it looks like a broken link.

---

## 3. Confirm Signup

Not used today — Gerry creates every account from inside the app, and admin
creation auto-confirms. Left at the default deliberately; if invites are ever
added, copy the shell and use `type=signup`.

---

## Testing

Do this on **staging** first, with a real inbox:

1. Trigger the email from the app.
2. Check it renders in Gmail **and** on a phone — the 600px table should
   collapse to full width.
3. Confirm the sender reads **Gerwin Trading**, not *Supabase Auth*. That name
   comes from SMTP settings, not the template.
4. Click the button and confirm it lands on the app, not on a Supabase URL.
5. Check the preview text in the inbox list is the preheader, not the heading.

Only then paste the same templates into production.
