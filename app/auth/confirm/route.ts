import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";

/** Where Supabase's TOKEN-HASH email links land (email change). Not PKCE like
 *  /auth/callback — it exists so a consumed/expired link isn't a dead end. */
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
    // Usually means the email template still uses `{{ .ConfirmationURL }}`, which
    // returns the outcome in a fragment the server can never read. Fix the template.
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

  // The sign-in identity changed, so every session is stale. Scope 'global'
  // revokes every refresh token, not just this browser's.
  if (type === "email_change") {
    // A clean verifyOtp does NOT mean the address changed — "Secure email
    // change" needs BOTH addresses confirmed. Report what actually happened.
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
