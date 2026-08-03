/**
 * /auth/confirm — the landing route for Supabase's TOKEN-HASH email links
 * (email change today; invite/magic-link if they are ever added).
 *
 * WHY THIS SUITE EXISTS. The owner tried to move his sign-in address off the
 * developer's email on the day of handover and got a bare "Access denied".
 * Nothing passed `emailRedirectTo`, so the link went through Supabase's own
 * verify endpoint and, on failure, bounced to the Site URL — the app homepage —
 * with `#error=access_denied` in the fragment, which no page reads.
 *
 * The happy path CANNOT be tested here: a valid token_hash only exists inside
 * an email Supabase just sent, is single-use, and expires. What IS testable is
 * every way the link fails — which is the part that was broken, and the part a
 * real user hits (mail scanners consume one-time links before the human clicks).
 *
 * Unlike the redirect STUBS in test-ia-redirects, this is a Route Handler
 * returning NextResponse.redirect, so it really is a 3xx with a Location
 * header — no meta-refresh special case needed.
 *
 * Goes over HTTP — run with --with-http.
 * Run: npm run dev · TEST_BASE_URL=http://localhost:3001 node scripts/test-auth-confirm.mjs
 */
import { check, section, summary } from "./_harness.mjs";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";

/** Follow nothing — we want the redirect itself. Signed OUT on purpose: an
 *  expired link belongs to someone who cannot sign in. */
async function hit(path) {
  const res = await fetch(`${BASE}${path}`, { redirect: "manual" });
  const loc = res.headers.get("location") ?? "";
  let error = "";
  try {
    error = new URL(loc, BASE).searchParams.get("error") ?? "";
  } catch {
    /* not a URL */
  }
  return { status: res.status, loc, error, path: safePath(loc) };
}
function safePath(loc) {
  try {
    return new URL(loc, BASE).pathname;
  } catch {
    return "";
  }
}

// Refuse a stranger on this port — next dev moves ports silently (CLAUDE.md).
{
  const res = await fetch(`${BASE}/login`);
  const html = await res.text();
  if (!/Gerwin|Sign in|password/i.test(html)) {
    console.error(`\nREFUSED: ${BASE}/login does not look like this app. Set TEST_BASE_URL.`);
    process.exit(2);
  }
}

section("A link that is missing its token is explained, not swallowed");
{
  // Assert INTENT, not exact wording — the copy changed once already when we
  // learned this case usually means the email template still routes through
  // Supabase's verify endpoint (whose result arrives in a URL fragment the
  // server can never see), i.e. the link may actually have worked.
  const r = await hit("/auth/confirm");
  check("bare /auth/confirm redirects to /login", r.path === "/login", `got ${r.path || r.status}`);
  check(
    "it tells the user what to do next",
    r.error.length > 20 && /request a new|other inbox/i.test(r.error),
    r.error || "(no error param)"
  );
  check("it does not claim the link was invalid", !/invalid|denied/i.test(r.error), r.error);

  const noType = await hit("/auth/confirm?token_hash=abc123");
  check(
    "token without type is refused too",
    /request a new|other inbox/i.test(noType.error),
    noType.error
  );
}

section("An expired or already-used link says so");
{
  const r = await hit("/auth/confirm?token_hash=definitely-not-a-real-token&type=email_change");
  check("invalid token redirects to /login", r.path === "/login", `got ${r.path || r.status}`);
  check(
    "message names expiry AND single use — the two real causes",
    /expired/i.test(r.error) && /used/i.test(r.error),
    r.error
  );
  check(
    "message warns that mail apps consume links",
    /mail app|automatic/i.test(r.error),
    r.error
  );
  check("it never says 'access denied'", !/access denied/i.test(r.error), r.error);
}

section("Supabase's own error_description is passed through");
{
  const r = await hit("/auth/confirm?error_description=Email+link+is+invalid+or+has+expired");
  check("provider error surfaces verbatim", /invalid or has expired/i.test(r.error), r.error);
}

section("Open redirect is refused (same guard as /auth/callback)");
{
  // A valid URL a browser reads as ANOTHER HOST — a leading "/" check alone
  // would let this through.
  const r = await hit("/auth/confirm?token_hash=x&type=email_change&next=//evil.com");
  check("never redirects off-origin", !/evil\.com/i.test(r.loc), r.loc);

  const abs = await hit("/auth/confirm?token_hash=x&type=email_change&next=https://evil.com");
  check("absolute URL in next is refused", !/evil\.com/i.test(abs.loc), abs.loc);
}

section("The route is reachable without a session");
{
  // It must be: the whole point is helping someone who cannot sign in. If the
  // middleware ever stops treating /auth/* as public this fails loudly.
  const r = await hit("/auth/confirm?token_hash=x&type=email_change");
  check(
    "not bounced to /login by the auth gate before running",
    r.error !== "",
    "reached the handler and produced its own message"
  );
}

summary();
