import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/**
 * Where Supabase's TOKEN-HASH email links land — email change today, and any
 * future confirm/invite/magic-link flow.
 *
 * This is NOT the same mechanism as /auth/callback. A password reset is a PKCE
 * flow: the browser asks for it, Supabase returns a one-time `code`, and the
 * callback exchanges it. An email CHANGE is not — Supabase mails a
 * `token_hash` + `type` pair that has to be verified directly.
 *
 * WHY THIS ROUTE EXISTS (production incident, 2026-08-02). Until now nothing
 * passed `emailRedirectTo`, so an email-change link went through Supabase's own
 * /auth/v1/verify endpoint and, on ANY failure, bounced to the Site URL with
 * `#error=access_denied&error_code=otp_expired` in the fragment. That is the
 * app's homepage, which has no idea what that means — so the owner clicked the
 * link in his inbox and got a bare "Access denied" with nothing to act on.
 *
 * Two things make that failure likely rather than exotic:
 *   - these are ONE-TIME tokens, and mail scanners (Gmail, Outlook Safe Links)
 *     fetch links before a human clicks — consuming the token first;
 *   - a delayed email eats into the expiry window.
 * Neither is preventable here. What IS preventable is the dead end: a consumed
 * or expired link should say so and offer the next step.
 *
 * "Secure email change" (Supabase → Authentication → Providers → Email, on by
 * default) sends a link to BOTH the old and the new address and applies the
 * change only when both are confirmed. Confirming one and seeing no change is
 * therefore correct behaviour, not a bug — so the success message says which
 * one was accepted rather than claiming the address has changed.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const errorDescription = searchParams.get("error_description");

  // Same open-redirect guard as /auth/callback: `//evil.com` is a valid URL a
  // browser reads as another host, so a leading "/" alone is not enough.
  const rawNext = searchParams.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  const fail = (message: string) =>
    NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(message)}`);

  if (errorDescription) return fail(errorDescription);
  if (!tokenHash || !type) {
    // Almost always means the email template still uses `{{ .ConfirmationURL }}`,
    // which routes through Supabase's OWN verify endpoint and then redirects
    // here with the outcome in the URL **fragment** (`#message=…`). A fragment
    // is never transmitted to the server, so this handler cannot read it — the
    // link may well have SUCCEEDED and we would still land here.
    //
    // The fix is in the email template, not in this code: point it straight at
    // this route with `?token_hash={{ .TokenHash }}&type=…`. Say so, rather
    // than telling the owner his working link was broken.
    return fail(
      "That link couldn't be read. If you just clicked a confirmation email, " +
        "check the other inbox — an email change needs both links. Otherwise " +
        "request a new one."
    );
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });

  if (error) {
    return fail(
      "That confirmation link didn't work — it may have expired or already " +
        "been used. Email links are single-use, and some mail apps open them " +
        "automatically. Request a new one and open it as soon as it arrives."
    );
  }

  // The sign-in identity just changed, so EVERY existing session is stale —
  // including tabs and devices that are not the one holding this link. Scope
  // 'global' revokes all of the user's refresh tokens, not just this browser's;
  // without it the owner changes his address and his other tab stays signed in
  // under the old one, which is exactly the "did that even work?" confusion the
  // change is meant to end.
  //
  // verifyOtp above established a session for this user in THIS client, so the
  // sign-out reaches them even when the link is opened on another device.
  if (type === "email_change") {
    // A successful verifyOtp does NOT mean the address changed. With Supabase's
    // "Secure email change" enabled (its default), a link goes to BOTH the old
    // and the new address and the swap only happens once both are confirmed —
    // so the first click verifies cleanly while `new_email` is still pending.
    //
    // Claiming success there is worse than saying nothing: it signs the owner
    // out and tells him to use an address that does not exist yet. So ask what
    // actually happened rather than assuming.
    const { data: after } = await supabase.auth.getUser();
    const stillPending = Boolean(after.user?.new_email);

    if (stillPending) {
      // Do NOT sign out — the old address is still the live one.
      return NextResponse.redirect(
        `${origin}/settings?tab=account&emailchange=pending`
      );
    }

    await supabase.auth.signOut({ scope: "global" });
    return NextResponse.redirect(
      `${origin}/login?notice=${encodeURIComponent(
        "Email updated. Sign in with your new address."
      )}`
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
