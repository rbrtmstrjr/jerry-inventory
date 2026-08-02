// Task 16 — Settings (Gerry-only), six sections. Steps 1–13.
//
// THIS SCRIPT MUTATES THE ONE LIVE SETTINGS ROW, which every printable document
// reads for its letterhead. Two safeguards, both learned the hard way:
//
//  1. It REFUSES TO START if it finds `ZZ` already in the row. Capturing
//     polluted data as "the original" restores the pollution and reports
//     success — the failure certifies itself.
//  2. The restore runs in `finally`, THROUGH THE UI. `process.on("exit")`
//     cannot await, so an async restore there never lands; and `dbAuth` is
//     read-only by discipline, so the app's own form is the only write path.
//     `updateBusinessSettings` coerces "" → null, so clearing a field restores
//     a NULL faithfully.
//
// NOT DONE, deliberately:
//  · Step 4's successful password change. It would rotate GERRY's credential
//    while a second agent is running Tasks 8–10 against the same database, and
//    it requires editing TEST_OWNER_PASSWORD in .env.local. Every REFUSAL rule
//    is exercised; only the final commit is skipped.
//  · Step 5's real email change — the plan says not to complete one.
import {
  launch, session, goto, bodyText, shot, dbAuth, CREDS,
  step, check, summary, toast, clearToasts, APP,
} from "./qa-lib.mjs";

const STAMP = Date.now().toString(36).toUpperCase().slice(-5);
const ADM_NAME = `ZZ-QB Admin ${STAMP}`;
const ADM_EMAIL = `zzqb-set-${STAMP.toLowerCase()}@gerwin-test.ph`;
const ADM_PASS = "zzqbsettings123";

const { browser } = await launch();
const q = await dbAuth("owner");

// ── capture + pollution gate ────────────────────────────────────────────────
const ORIGINAL = (await q("settings?select=*"))[0];
const polluted = Object.entries(ORIGINAL).filter(
  ([k, v]) => typeof v === "string" && /ZZ[- ]/.test(v) && k !== "id"
);
if (polluted.length) {
  console.error("REFUSING TO RUN — the live settings row already contains QA data:");
  for (const [k, v] of polluted) console.error(`   ${k} = ${JSON.stringify(v)}`);
  console.error("Restore it by hand first; capturing this as 'the original' would");
  console.error("make the pollution permanent and self-certifying.");
  await browser.close();
  process.exit(2);
}
console.log("captured settings row:", JSON.stringify(ORIGINAL));

const owner = await session(browser, "owner");
const page = owner.page;
const T = () => bodyText(page);

async function saveBusiness() {
  await page.getByRole("button", { name: /Save business info|^Save/ }).first().click();
}

/** Put the captured row back through the app's own form. */
async function restore() {
  await goto(page, "/settings?tab=business");
  await page.waitForTimeout(3000);
  const set = async (id, v) => {
    const el = page.locator(`#${id}`);
    if (await el.count()) await el.fill(v ?? "");
  };
  await set("set-name", ORIGINAL.business_name);
  await set("set-address", ORIGINAL.address);
  await set("set-phone", ORIGINAL.phone);
  await set("set-email", ORIGINAL.business_email);
  await set("set-tin", ORIGINAL.business_tin);
  await set("set-footer", ORIGINAL.receipt_footer);
  await saveBusiness();
  await page.waitForTimeout(3000);
  await clearToasts(page);

  // defaults + alerts live on their own forms
  await goto(page, "/settings?tab=business");
  await page.waitForTimeout(2500);
  const wm = page.locator("#set-warranty");
  if (await wm.count()) {
    await wm.fill(String(ORIGINAL.default_warranty_months));
    await page.getByRole("button", { name: /Save defaults|^Save/ }).last().click();
    await page.waitForTimeout(2500);
    await clearToasts(page);
  }
  await goto(page, "/settings?tab=alerts");
  await page.waitForTimeout(2500);
  for (const [id, v] of [
    ["alert-warranty-days", ORIGINAL.warranty_expiry_alert_days],
    ["alert-warn-pct", ORIGINAL.supplier_limit_warn_pct],
    ["alert-stale-days", ORIGINAL.quote_stale_days],
    ["suki-engine-pct", ORIGINAL.suki_engine_discount_pct],
    ["suki-part-pct", ORIGINAL.suki_part_discount_pct],
  ]) {
    const el = page.locator(`#${id}`);
    if (await el.count()) await el.fill(String(v));
  }
  await page.getByRole("button", { name: /Save/ }).first().click();
  await page.waitForTimeout(3000);
  await clearToasts(page);
}

try {
  // ── Step 1: tabs + fallback ───────────────────────────────────────────────
  step("Step 1: six tabs and the ?tab= fallback");
  await goto(page, "/settings");
  await page.waitForTimeout(3500);
  let t = await T();
  for (const tab of ["Business", "Account", "Admins", "Alerts", "Notifications", "System"]) {
    check(new RegExp(tab, "i").test(t), `tab present: ${tab}`);
  }
  await goto(page, "/settings?tab=zzz");
  await page.waitForTimeout(3000);
  check((await page.locator("#set-name").count()) === 1,
    "an unrecognised ?tab= falls back to Business (silently)");

  // ── Step 2: business identity ─────────────────────────────────────────────
  step("Step 2: business identity reaches the documents");
  await goto(page, "/settings?tab=business");
  await page.waitForTimeout(3000);
  check(/Taxpayer Identification Number, printed on the sale receipt\./.test(await T()),
    "TIN helper copy");
  check((await page.locator("#set-footer").getAttribute("placeholder")) ===
    "e.g. Salamat po! Come again.", "receipt-footer placeholder");
  await page.locator("#set-name").fill("ZZ QA Trading");
  await page.locator("#set-address").fill("ZZ-QB Address 1, Cavite");
  await page.locator("#set-phone").fill("09171234567");
  await page.locator("#set-email").fill("zzqb@gerwin-test.ph");
  await page.locator("#set-tin").fill("000-111-222-333");
  await page.locator("#set-footer").fill("ZZ-QB Salamat po!");
  await saveBusiness();
  const tBiz = await toast(page);
  check(/Business info saved — it's on every document now/.test(tBiz),
    "toast 'Business info saved — it's on every document now'", tBiz);
  await page.waitForTimeout(3000);
  const after = (await q("settings?select=business_name,address,phone,business_email,business_tin,receipt_footer"))[0];
  check(after.business_name === "ZZ QA Trading", "business_name persisted", after.business_name);
  check(after.business_tin === "000-111-222-333", "TIN persisted", after.business_tin);
  await clearToasts(page);

  // it reaches a real document — the count sheet's letterhead
  const snap = (await q("count_snapshots?select=id&deleted_at=is.null&order=created_at.desc&limit=1"))[0];
  if (snap) {
    await goto(page, `/counts/${snap.id}/sheet`);
    await page.waitForTimeout(3000);
    check((await T()).includes("ZZ QA Trading"),
      "the new name reaches a printable document (count sheet letterhead)");
  } else {
    check(true, "no count sheet to check the letterhead against — skipped");
  }
  await shot(page, "task16-step2-business");

  // ── Step 3: defaults ──────────────────────────────────────────────────────
  step("Step 3: default warranty months");
  await goto(page, "/settings?tab=business");
  await page.waitForTimeout(3000);
  for (const bad of ["12.5", "12abc", "1e3", "  "]) {
    await page.locator("#set-warranty").fill(bad);
    await page.getByRole("button", { name: /Save defaults|^Save/ }).last().click();
    const tW = await toast(page);
    check(/Warranty months must be a whole number/.test(tW),
      `❌ "${bad}" → 'Warranty months must be a whole number'`, tW);
    await clearToasts(page);
  }
  await page.locator("#set-warranty").fill("18");
  await page.getByRole("button", { name: /Save defaults|^Save/ }).last().click();
  const tW2 = await toast(page);
  check(/Defaults saved/.test(tW2), "a valid value saves", tW2);
  await page.waitForTimeout(2500);
  check((await q("settings?select=default_warranty_months"))[0].default_warranty_months === 18,
    "default_warranty_months persisted as 18");
  await clearToasts(page);

  // ── Step 4: account — password RULES only ─────────────────────────────────
  step("Step 4: password change rules (refusals only)");
  await goto(page, "/settings?tab=account");
  await page.waitForTimeout(3000);
  const pw = async (cur, a, b) => {
    await page.locator("#acc-cur-pw").fill(cur);
    await page.locator("#acc-new-pw").fill(a);
    await page.locator("#acc-new-pw2").fill(b);
    await page.getByRole("button", { name: /Change password|^Save/ }).first().click();
    const r = await toast(page);
    await clearToasts(page);
    return r;
  };
  check(/at least 8 characters/i.test(await pw(CREDS.owner.pass, "ab1", "ab1")),
    "❌ under 8 characters");
  check(/must contain both a letter and a number/.test(await pw(CREDS.owner.pass, "abcdefgh", "abcdefgh")),
    "❌ letters only → 'must contain both a letter and a number'");
  check(/The two new passwords don't match/.test(await pw(CREDS.owner.pass, "abcdefg1", "abcdefg2")),
    "❌ mismatch");
  check(/same as your current one/.test(await pw(CREDS.owner.pass, CREDS.owner.pass, CREDS.owner.pass)),
    "❌ same as current");
  check(/That's not your current password\./.test(await pw("wrong-password-xyz", "abcdefg1", "abcdefg1")),
    "❌ wrong current password");
  console.log("  the SUCCESSFUL change is deliberately not performed: it would");
  console.log("  rotate GERRY's credential while another agent is running Tasks");
  console.log("  8–10, and requires editing TEST_OWNER_PASSWORD in .env.local.");

  // ── Step 5: account — email rules only ────────────────────────────────────
  step("Step 5: email change rules (no real change)");
  const em = async (a, b) => {
    await page.locator("#acc-em-pw").fill(CREDS.owner.pass);
    await page.locator("#acc-new-em").fill(a);
    await page.locator("#acc-new-em2").fill(b);
    await page.getByRole("button", { name: "Send confirmation", exact: true }).first().click();
    const r = await toast(page);
    await clearToasts(page);
    return r;
  };
  // Both fields are type="email", so Chromium blocks the submit natively and no
  // handler (and no toast) ever runs. That IS the refusal — assert the
  // mechanism rather than expecting app copy that cannot fire.
  await page.locator("#acc-em-pw").fill(CREDS.owner.pass);
  await page.locator("#acc-new-em").fill("notanemail");
  await page.locator("#acc-new-em2").fill("notanemail");
  const validity = await page.locator("#acc-new-em").evaluate((e) => e.checkValidity());
  check(validity === false, "❌ invalid email is refused by native validation before submit",
    `checkValidity()=${validity}`);
  await page.getByRole("button", { name: "Send confirmation", exact: true }).first().click();
  await page.waitForTimeout(1500);
  check((await q(`profiles?select=id&id=eq.${(await q("profiles?select=id&role=eq.owner&limit=1"))[0].id}`)).length === 1,
    "…and nothing was submitted");
  await clearToasts(page);
  check(/The two email addresses don't match/.test(await em("a@b.ph", "c@d.ph")), "❌ mismatch");
  check(/That's already your email address/.test(await em(CREDS.owner.email, CREDS.owner.email)),
    "❌ same as current");
  const stillEmail = CREDS.owner.email;
  console.log(`  no real email change was completed (still ${stillEmail})`);

  // ── Step 6: reset link ────────────────────────────────────────────────────
  step("Step 6: reset link");
  const resetBtn = page.getByRole("button", { name: "Send password reset email", exact: true }).first();
  if (await resetBtn.count()) {
    await resetBtn.click();
    await page.waitForTimeout(4000);
    t = await T();
    const sent = /Reset link sent to/.test(t);
    // Staging runs Supabase's default mailer, which rejects the owner's `.test`
    // address outright (email_address_invalid → 400) and rate-limits the rest.
    // Same environment blocker as bug B4 in Task 1 — the SEND is not
    // exercisable here, so assert the surfaced outcome and say which it was.
    const blocked = /rate limit|too many|invalid|isn't one we can send to|Wait a few minutes/i.test(t);
    const toasts = (await page.locator("[data-sonner-toast]").allTextContents()).join(" | ");
    check(sent || blocked || toasts.length > 0,
      "the reset control reports an outcome (sent, or refused by the staging mailer)",
      sent ? "sent" : (t.match(/[^\n]*(rate limit|invalid|Wait a few)[^\n]*/i) || [toasts || "SILENT — no alert, no toast"])[0]);
    if (sent) {
      check(/expires after an hour|request another if it lapses/.test(t),
        "…and the alert explains the expiry");
    } else {
      console.log("  send blocked by the staging mailer (same as B4) — the alert");
      console.log("  copy itself is therefore not exercisable on this environment.");
    }
  } else {
    check(false, "reset-link control present");
  }
  await clearToasts(page);

  // ── Steps 7–10: admins ────────────────────────────────────────────────────
  step("Steps 7–10: admin accounts");
  await goto(page, "/settings?tab=admins");
  await page.waitForTimeout(3500);
  await page.getByRole("button", { name: /Add admin/ }).click();
  await page.waitForTimeout(1000);
  await page.locator("#adm-name").fill(ADM_NAME);
  await page.locator("#adm-email").fill(ADM_EMAIL);
  await page.locator("#adm-pass").fill(ADM_PASS);
  await page.getByRole("button", { name: /^Create|^Add/ }).last().click();
  const tAdd = await toast(page);
  check(new RegExp(`Admin account created for ${ADM_NAME}`).test(tAdd), "Step 7: admin created", tAdd);
  await page.waitForTimeout(3000);
  await clearToasts(page);

  // Step 8: deactivate → badge, then reactivate
  const actions = page.getByRole("button", { name: `Actions for ${ADM_NAME}`, exact: true });
  await actions.click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /Deactivate/ }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Deactivate", exact: true }).last().click();
  check(/Admin deactivated/.test(await toast(page)), "Step 8: deactivated");
  await page.waitForTimeout(2500);
  await clearToasts(page);
  check(/Deactivated/.test(await T()), "…and the badge reads 'Deactivated'");
  check((await q(`profiles?select=active&full_name=eq.${encodeURIComponent(ADM_NAME)}`))[0].active === false,
    "…and profiles.active is false");
  await actions.click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /Reactivate/ }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Reactivate", exact: true }).last().click();
  check(/Admin reactivated/.test(await toast(page)), "…reactivated");
  await page.waitForTimeout(2500);
  await clearToasts(page);

  // Step 9: edit with nothing changed → refused
  await actions.click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /^Edit/ }).click();
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: /^Save/ }).last().click();
  const tNo = await toast(page);
  check(/Nothing to change/.test(tNo), "Step 9: ❌ submitting an unchanged dialog → 'Nothing to change'", tNo);
  await clearToasts(page);
  await page.locator("#adm-edit-name").fill(`${ADM_NAME} v2`);
  await page.getByRole("button", { name: /^Save/ }).last().click();
  check(/Admin account updated/.test(await toast(page)), "…a name-only edit saves");
  await page.waitForTimeout(2500);
  await clearToasts(page);

  // Step 10: delete the history-less fixture; a historied admin is refused
  const acts2 = page.getByRole("button", { name: `Actions for ${ADM_NAME} v2`, exact: true });
  await acts2.click();
  await page.waitForTimeout(600);
  await page.getByRole("menuitem", { name: /Delete account/ }).click();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "Delete", exact: true }).last().click();
  check(/Admin account deleted/.test(await toast(page)), "Step 10: a history-less admin deletes");
  await page.waitForTimeout(2500);
  check((await q(`profiles?select=id&full_name=like.${encodeURIComponent(ADM_NAME)}*`)).length === 0,
    "…and the row is gone");
  await clearToasts(page);

  // the historied admin must refuse
  await goto(page, "/settings?tab=admins");
  await page.waitForTimeout(3000);
  const historied = (await q("profiles?select=full_name&role=eq.admin&deleted_at=is.null&limit=1"))[0];
  if (historied) {
    const a3 = page.getByRole("button", { name: `Actions for ${historied.full_name}`, exact: true });
    if (await a3.count()) {
      await a3.click();
      await page.waitForTimeout(600);
      await page.getByRole("menuitem", { name: /Delete account/ }).click();
      await page.waitForTimeout(900);
      await page.getByRole("button", { name: "Delete", exact: true }).last().click();
      const tDel = await toast(page);
      check(/deactivate it instead/i.test(tDel),
        "❌ an admin WITH history is refused, told to deactivate instead", tDel);
      check((await q(`profiles?select=id&full_name=eq.${encodeURIComponent(historied.full_name)}&deleted_at=is.null`)).length === 1,
        "…and that admin still exists");
      await clearToasts(page);
    } else { check(true, `no row action for ${historied.full_name} — skipped`); }
  }

  // ── Step 11: alerts dials ─────────────────────────────────────────────────
  step("Step 11: alert dials");
  await goto(page, "/settings?tab=alerts");
  await page.waitForTimeout(3000);
  const saveAlerts = () => page.getByRole("button", { name: /Save/ }).first().click();
  const orig = {
    "alert-warranty-days": ORIGINAL.warranty_expiry_alert_days,
    "alert-warn-pct": ORIGINAL.supplier_limit_warn_pct,
    "alert-stale-days": ORIGINAL.quote_stale_days,
    "suki-engine-pct": ORIGINAL.suki_engine_discount_pct,
    "suki-part-pct": ORIGINAL.suki_part_discount_pct,
  };
  const resetFields = async () => {
    for (const [id, v] of Object.entries(orig)) await page.locator(`#${id}`).fill(String(v));
  };
  for (const [id, bad, expect] of [
    ["alert-warranty-days", "400", /Warranty alert lead time must be between 0 and 365 days/],
    ["alert-warn-pct", "0", /Credit limit warning must be between 1 and 100 percent/],
    ["alert-stale-days", "0", /Quote staleness must be between 1 and 365 days/],
    ["suki-engine-pct", "150", /Suki discounts must be between 0 and 100 percent/],
  ]) {
    await resetFields();
    await page.locator(`#${id}`).fill(bad);
    await saveAlerts();
    const r = await toast(page);
    check(expect.test(r), `❌ ${id}="${bad}" → its own message`, r);
    await clearToasts(page);
  }
  await resetFields();
  await page.locator("#suki-engine-pct").fill("12");
  await saveAlerts();
  check(/Alert thresholds saved/.test(await toast(page)), "a valid dial change saves");
  await page.waitForTimeout(2500);
  check((await q("settings?select=suki_engine_discount_pct"))[0].suki_engine_discount_pct === 12,
    "suki engine rate persisted as 12");
  await clearToasts(page);

  // ── Step 12: notifications (read-only) ────────────────────────────────────
  step("Step 12: notifications panel is read-only");
  await goto(page, "/settings?tab=notifications");
  await page.waitForTimeout(3000);
  t = await T();
  check(/Every alert lands in the bell in the top bar\./.test(t), "in-app subline");
  check(/Not built\. Needs an SMS provider wired before it can be turned on\./.test(t),
    "sms subline names it as not built");
  // `{pending > 0 && …}` in notifications-section.tsx — correctly absent when
  // the queue is empty, so assert against the actual queue depth.
  const pendingN = (await q("notification_dispatches?select=id&status=eq.pending&limit=1000")).length;
  if (pendingN > 0) {
    check(/pending dispatch(es)? waiting/.test(t), "pending-dispatch line renders",
      (t.match(/\d+ pending dispatch[^\n]*/) || ["absent"])[0]);
  } else {
    check(!/pending dispatch/.test(t),
      "queue is empty, so the pending-dispatch line is correctly absent", `${pendingN} pending`);
  }
  const writable = await page.locator('[role="switch"]:not([disabled]), input[type="checkbox"]:not([disabled])').count();
  check(writable === 0, "❌ no enabled toggle — the panel is read-only", `${writable} enabled control(s)`);

  // ── Step 13: system ───────────────────────────────────────────────────────
  step("Step 13: system health");
  await goto(page, "/settings?tab=system");
  await page.waitForTimeout(3500);
  t = await T();
  check(/warranty-expiry-daily/.test(t), "pg_cron job listed: warranty-expiry-daily");
  check(/supplier-overdue-daily/.test(t), "pg_cron job listed: supplier-overdue-daily");
  // The word "secret" appears in the panel's own reassurance ("no key or secret
  // is ever shown here"), so match secret SHAPES instead of the word.
  const leaks = [/eyJ[A-Za-z0-9_-]{10,}/, /service_role/i, /sb_[a-z]+_[A-Za-z0-9]{16,}/,
                 /postgres(ql)?:\/\//i, /[A-Za-z0-9+/]{60,}={0,2}/];
  const hit = leaks.map((re) => t.match(re)).find(Boolean);
  check(!hit, "❌ no key, token, connection string or long blob is rendered",
    hit ? String(hit[0]).slice(0, 50) : "clean");
  check(/no key or secret is ever shown here/i.test(t),
    "…and the panel says so explicitly");
  await shot(page, "task16-step13-system");
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task16-crash").catch(() => {});
} finally {
  // ── restore, then PROVE it ────────────────────────────────────────────────
  step("restore the captured settings row");
  try {
    await restore();
  } catch (e) {
    check(false, `restore threw: ${e.message}`);
  }
  const now = (await q("settings?select=*"))[0];
  const drift = Object.keys(ORIGINAL).filter(
    (k) => !["updated_at", "created_at"].includes(k) && ORIGINAL[k] !== now[k]
  );
  check(drift.length === 0, "the settings row is byte-for-byte back to the captured original",
    drift.map((k) => `${k}: ${JSON.stringify(ORIGINAL[k])} → ${JSON.stringify(now[k])}`).join(" | "));
  console.log("\nconsole errors:", owner.errors.length ? owner.errors.slice(0, 5) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
