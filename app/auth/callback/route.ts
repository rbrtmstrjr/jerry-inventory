import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

/** Exchanges the emailed PKCE `code` for a session. Must stay under /auth so
 *  proxy.ts lets it through unauthenticated — the verifier is browser-bound. */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const errorDescription = searchParams.get("error_description");

  // Only redirect inside this app. A leading "/" is not enough — `//evil.com`
  // passes that check and a browser reads it as another host.
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
