// Task 1 — Authentication, recovery, and routing gates. Steps 1–6.
//
// Step 6 needs a DEACTIVATED admin. It mints its own `ZZ-QB Admin` rather than
// deactivating a shared one: a second agent is signed in as ADMIN right now, and
// `profiles.active=false` cuts app AND database access instantly (0099), so
// borrowing their account would break their run mid-task.
import {
  launch, login, goto, bodyText, shot, dbAuth,
  step, check, summary, toast, clearToasts, APP, CREDS,
} from "./qa-lib.mjs";

const STAMP = Date.now().toString(36).toUpperCase().slice(-5);
const ADM_NAME = `ZZ-QB Admin ${STAMP}`;
const ADM_EMAIL = `zzqb-admin-${STAMP.toLowerCase()}@gerwin-test.ph`;
const ADM_PASS = "zzqbadmin123";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner");

/** Real alerts only. Next injects `#__next-route-announcer__` with role="alert"
 *  and empty text on every page, so `[role="alert"].first()` reads "". */
async function alertTexts(p = page) {
  return (await p.locator('[role="alert"]').allTextContents())
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Sign in fresh and report where we landed. Waits on the URL change, never a
 *  fixed timeout — `next dev` compiles routes on demand. */
async function signIn(email, pass, { expectStay = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  try {
    await p.goto(`${APP}/login`, { waitUntil: "load", timeout: 60000 });
    await p.locator('input[type="email"]').fill(email);
    await p.locator('input[type="password"]').fill(pass);
    await p.locator('button[type="submit"]').click();
    if (expectStay) {
      await p.locator('[role="alert"]').filter({ hasText: /\S/ })
        .first().waitFor({ state: "visible", timeout: 20000 }).catch(() => {});
    } else {
      await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 })
        .catch(() => {});
      await p.waitForLoadState("load").catch(() => {});
    }
    return {
      url: new URL(p.url()).pathname,
      alerts: await alertTexts(p),
      email: await p.locator('input[type="email"]').inputValue().catch(() => ""),
      pass: await p.locator('input[type="password"]').inputValue().catch(() => ""),
      ctx, p,
    };
  } catch (e) {
    await ctx.close();
    throw e;
  }
}

/** Visit `path` inside an already-signed-in context and report the landing. */
async function visitAs(sess, path) {
  await sess.p.goto(`${APP}${path}`, { waitUntil: "load", timeout: 60000 });
  await sess.p.waitForTimeout(2500);
  return new URL(sess.p.url()).pathname;
}

try {
  // ── Step 1: login page chrome ─────────────────────────────────────────────
  step("Step 1: login page chrome");
  await goto(page, "/login");
  await page.waitForTimeout(1200);
  let t = await T();
  check(/Gerwin Trading/.test(t), "brand header names the business",
    (t.match(/Gerwin[^\n]*/) || ["absent"])[0]);
  check(/Inventory & Approvals/.test(t), "brand subtitle 'Inventory & Approvals'");
  check(/Welcome back/.test(t), "form heading 'Welcome back'");
  check(/Sign in with the account the owner created for you\./.test(t), "subtitle copy");
  check((await page.locator('input[type="email"]').count()) === 1, "Email field present");
  check((await page.locator("#password").count()) === 1, "Password field present");
  check((await page.getByRole("button", { name: "Forgot password?" }).count()) === 1,
    "'Forgot password?' link present");
  check(
    (await page.locator('input[type="email"]').getAttribute("placeholder")) === "you@example.com",
    "email placeholder 'you@example.com'"
  );
  await shot(page, "task1-step1-login");

  // ── Step 2: validation and failure copy ───────────────────────────────────
  step("Step 2: validation and failure copy");
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(1200);
  t = await T();
  check(/required|Enter|valid/i.test(t), "empty submit shows inline errors",
    (t.match(/[^\n]*(required|valid)[^\n]*/i) || ["absent"])[0]);
  const emailInvalid = await page.locator('input[type="email"]').getAttribute("aria-invalid");
  const passInvalid = await page.locator("#password").getAttribute("aria-invalid");
  check(emailInvalid === "true", "email field is aria-invalid", String(emailInvalid));
  check(passInvalid === "true", "password field is aria-invalid", String(passInvalid));

  await page.locator('input[type="email"]').fill("notanemail");
  await page.locator("#password").fill("something");
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(1200);
  t = await T();
  check(/valid email|Enter a valid/i.test(t), "'notanemail' shows an email-format error",
    (t.match(/[^\n]*valid[^\n]*/i) || ["absent"])[0]);

  const wrong = await signIn(CREDS.shop.email, "definitely-wrong-password", { expectStay: true });
  check(wrong.url === "/login", "wrong password does not redirect", wrong.url);
  check(wrong.alerts.some((a) => /Wrong email or password\./.test(a)),
    "server error 'Wrong email or password.'", wrong.alerts.join(" | ") || "(none)");
  check(wrong.email === CREDS.shop.email, "email field keeps its value", wrong.email);
  check(wrong.pass === "definitely-wrong-password", "password field keeps its value",
    wrong.pass ? "(kept)" : "(cleared)");
  await wrong.ctx.close();

  // ── Step 3: role routing ──────────────────────────────────────────────────
  step("Step 3: role routing");
  const gerry = await signIn(CREDS.owner.email, CREDS.owner.pass);
  check(gerry.url === "/dashboard", "GERRY lands on /dashboard", gerry.url);
  const admin = await signIn(CREDS.admin.email, CREDS.admin.pass);
  check(admin.url === "/dashboard", "ADMIN lands on /dashboard", admin.url);
  const shop = await signIn(CREDS.shop.email, CREDS.shop.pass);
  check(shop.url === "/shop", "SHOP lands on /shop", shop.url);

  // signed in, visiting /login must bounce back home
  check((await visitAs(gerry, "/login")) === "/dashboard",
    "signed-in GERRY visiting /login bounces to /dashboard");
  check((await visitAs(shop, "/login")) === "/shop",
    "signed-in SHOP visiting /login bounces to /shop");

  // ── Step 4: cross-role URL gates (all ❌) ──────────────────────────────────
  step("Step 4: cross-role URL gates");
  for (const path of ["/reports", "/settings", "/expenses/reports"]) {
    const landed = await visitAs(admin, path);
    check(landed === "/dashboard", `❌ ADMIN ${path} → /dashboard`, landed);
  }
  for (const path of ["/dashboard", "/master-inventory", "/settings"]) {
    const landed = await visitAs(shop, path);
    check(landed === "/shop", `❌ SHOP ${path} → /shop`, landed);
  }
  const anon = await browser.newContext();
  const ap = await anon.newPage();
  await ap.goto(`${APP}/dashboard`, { waitUntil: "load", timeout: 60000 });
  await ap.waitForTimeout(2500);
  check(new URL(ap.url()).pathname === "/login", "❌ signed-out /dashboard → /login",
    new URL(ap.url()).pathname);
  await anon.close();
  await shot(page, "task1-step4-gates");

  // ── Step 5: forgot-password dialog ────────────────────────────────────────
  step("Step 5: forgot-password dialog");
  await goto(page, "/login");
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "Forgot password?" }).click();
  await page.waitForTimeout(900);
  t = await T();
  check(/Reset your password/.test(t), "dialog title 'Reset your password'");
  check(/We'll email you a link to set a new one\./.test(t), "dialog description");
  check((await page.locator("#forgot-email").count()) === 1, "visible Email label + field");
  check(
    (await page.locator("#forgot-email").getAttribute("placeholder")) === "you@example.com",
    "forgot-email placeholder 'you@example.com'"
  );
  // The plan says "submit blank → inline error". The app instead DISABLES Send
  // while the field is empty, so blank can't be submitted; the inline error is
  // reachable with a malformed address.
  const sendBtn = page.getByRole("button", { name: /Send reset link/ });
  check(await sendBtn.isDisabled(),
    "Send is disabled while the field is blank (plan expected an inline error)");
  await page.locator("#forgot-email").fill("notanemail");
  await sendBtn.click();
  await page.waitForTimeout(900);
  const al = await alertTexts();
  check(al.some((a) => /Enter a valid email address/.test(a)),
    "malformed address shows role='alert' 'Enter a valid email address'",
    al.join(" | ") || "(none)");
  await page.locator("#forgot-email").fill(CREDS.shop.email);
  await sendBtn.click();
  await page.waitForTimeout(5000);
  t = await T();
  const sentOk = /has an account, a reset link is on its way/.test(t);
  const blocked = await alertTexts();
  if (sentOk) {
    check(true, "success state names the address without confirming it exists",
      (t.match(/If[^\n]*account[^\n]*/) || [""])[0]);
    check(/Open the link in this same browser/.test(t), "success state explains the browser tie");
  } else {
    // Staging runs on Supabase's default mailer: `.test` addresses are rejected
    // outright (email_address_invalid) and the hourly quota is tiny (429). The
    // send itself is therefore not exercisable here — but the ERROR copy is, and
    // that is what a locked-out employee actually sees.
    console.log("  send blocked by the staging mailer — asserting the refusal copy instead");
    check(
      blocked.some((a) => /Wait a few minutes and try again|isn't one we can send to/.test(a)),
      "B4 — provider errors are rewritten in the app's own voice",
      blocked.join(" | ") || "(none)"
    );
    check(
      !blocked.some((a) => /rate limit exceeded|Email address ".*" is invalid/.test(a)),
      "❌ no raw Supabase error string reaches the user",
      blocked.join(" | ") || "(none)"
    );
  }
  await shot(page, "task1-step5-forgot");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // ── Step 6: a deactivated account is refused ──────────────────────────────
  step("Step 6: deactivated account is refused");
  await goto(page, "/login");
  await login(page, "owner");
  await goto(page, "/settings?tab=admins");
  await page.waitForTimeout(3000);
  check(/Admins|Admin accounts/i.test(await T()), "Settings → Admins reachable as GERRY");

  await page.getByRole("button", { name: /Add admin/ }).click();
  await page.waitForTimeout(1000);
  await page.locator("#adm-name").fill(ADM_NAME);
  await page.locator("#adm-email").fill(ADM_EMAIL);
  await page.locator("#adm-pass").fill(ADM_PASS);
  await page.getByRole("button", { name: /^Create|^Add/ }).last().click();
  const tAdd = await toast(page);
  check(new RegExp(`Admin account created for ${ADM_NAME}`).test(tAdd),
    "fixture admin created", tAdd);
  await page.waitForTimeout(3000);
  await clearToasts(page);

  // it works while active
  const before = await signIn(ADM_EMAIL, ADM_PASS);
  check(before.url === "/dashboard", "the fixture admin can sign in while active", before.url);
  await before.ctx.close();

  // deactivate it
  await goto(page, "/settings?tab=admins");
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: `Actions for ${ADM_NAME}`, exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /Deactivate/ }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Deactivate", exact: true }).last().click();
  const tOff = await toast(page);
  check(/Admin deactivated/.test(tOff), "toast 'Admin deactivated'", tOff);
  await page.waitForTimeout(2500);
  const prof = (await q(`profiles?select=active&full_name=eq.${encodeURIComponent(ADM_NAME)}`))[0];
  check(prof?.active === false, "profiles.active is false", String(prof?.active));
  await clearToasts(page);

  const after = await signIn(ADM_EMAIL, ADM_PASS, { expectStay: true });
  check(after.url === "/login", "❌ a deactivated account cannot sign in", after.url);
  check(after.alerts.some((a) => /This account has been disabled\. Talk to the owner\./.test(a)),
    "refusal copy 'This account has been disabled. Talk to the owner.'",
    after.alerts.join(" | ") || "(none)");
  await after.ctx.close();

  // reactivate, confirm it works, then delete the fixture (no history yet)
  await goto(page, "/settings?tab=admins");
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: `Actions for ${ADM_NAME}`, exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /Reactivate/ }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Reactivate", exact: true }).last().click();
  const tOn = await toast(page);
  check(/Admin reactivated/.test(tOn), "toast 'Admin reactivated'", tOn);
  await page.waitForTimeout(2500);
  await clearToasts(page);
  const again = await signIn(ADM_EMAIL, ADM_PASS);
  check(again.url === "/dashboard", "reactivated admin signs in again", again.url);
  await again.ctx.close();

  await goto(page, "/settings?tab=admins");
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: `Actions for ${ADM_NAME}`, exact: true }).click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /Delete account/ }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  const tDel = await toast(page);
  check(/Admin account deleted/.test(tDel), "fixture admin deleted (no history)", tDel);
  await page.waitForTimeout(2500);
  const gone = await q(`profiles?select=id&full_name=eq.${encodeURIComponent(ADM_NAME)}`);
  check(gone.length === 0, "fixture admin row removed", `${gone.length} rows`);

  await gerry.ctx.close();
  await admin.ctx.close();
  await shop.ctx.close();
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task1-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 8) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
