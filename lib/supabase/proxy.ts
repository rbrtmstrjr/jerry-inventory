import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Refreshes the Supabase auth session on every request and redirects
 * unauthenticated users to /login. Used by the root proxy.ts.
 */
export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  // IMPORTANT: do not add logic between createServerClient and getUser() —
  // it can cause hard-to-debug session bugs.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthRoute =
    request.nextUrl.pathname.startsWith("/login") ||
    request.nextUrl.pathname.startsWith("/auth");

  if (!user && !isAuthRoute) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  // NOTE: this redirect only fires when the browser actually ASKS for the page,
  // so it cannot police a history navigation the browser satisfies from its own
  // HTTP cache. In `next dev` that is observable: dev serves pages
  // `Cache-Control: no-cache, must-revalidate`, `no-cache` still permits reuse
  // for a back/forward navigation, and after signing out one press of Back
  // re-displays the last authenticated page. It does NOT reach users — a
  // production build serves `private, no-cache, no-store, max-age=0,
  // must-revalidate` (next/dist/build/templates/app-page.js), and `no-store`
  // forbids exactly that reuse; verified against `next build && next start`.
  // Do not "fix" this with a Cache-Control header here: Next overwrites the
  // header on its own page responses, and a next.config.ts `headers()` entry
  // REPLACES the stronger production header with a weaker one (it drops
  // `private`, which is what keeps a shared proxy from storing an
  // authenticated page). See bug B6 in the 2026-08-01 QA log B.
  return supabaseResponse;
}
