import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

/**
 * Where every emailed auth link lands (password reset today, email-change
 * confirmation too).
 *
 * The browser client uses PKCE, so Supabase's verify endpoint bounces the user
 * here with a one-time `code`. Exchanging it establishes the session, and only
 * then can /auth/reset call updateUser.
 *
 * This route lives under /auth on purpose — proxy.ts treats /auth/* as an auth
 * route and lets it through unauthenticated, which it has to be: the entire
 * point is to help someone who cannot sign in.
 *
 * PKCE keeps the code verifier in a cookie set by the browser that ASKED for
 * the reset, so the link has to be opened in that same browser. Opening it on a
 * phone when it was requested on a laptop fails — hence the plain-language
 * error rather than a stack trace.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const errorDescription = searchParams.get("error_description");

  // Only ever redirect somewhere inside this app. `//evil.com` is a valid URL
  // that a browser reads as another host, so checking for a leading "/" alone
  // is not enough — that is the open-redirect bug this rejects.
  const rawNext = searchParams.get("next") ?? "/";
  const next = rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/";

  const fail = (message: string) =>
    NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(message)}`);

  if (errorDescription) return fail(errorDescription);
  if (!code) return fail("That link is incomplete. Request a new password reset email.");

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return fail(
      "That reset link didn't work — it may have expired, already been used, or " +
        "been opened in a different browser from the one that requested it. " +
        "Request a new one."
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
