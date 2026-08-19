/**
 * QA 0132: Gerry corrects a master quantity from the UI; an admin cannot.
 *
 * Reuses one fixed fixture product — reads whatever master currently says
 * and corrects to current+1, so no run depends on a prior run's value.
 *
 * qa-lib's CREDS.admin is stale on staging, so this provisions its own
 * throwaway admin login via the service role, deleted again in `finally`.
 *
 * Run: node scripts/qa-browser/cs1-correct-stock.mjs   (needs npm run dev)
 */
import { createClient } from "@supabase/supabase-js";
import { launch, login, goto, check, summary, shot, ok, dbAuth, APP } from "./qa-lib.mjs";
import { assertWritableEnv, readEnvFile } from "../_env-guard.mjs";

assertWritableEnv("cs1-correct-stock (provisions a throwaway admin login)");
const env = readEnvFile();
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// NOT "ZZ-QA " — fq-cleanup.mjs hard-deletes every part LIKE 'ZZ-QA %'.
const FIXTURE_NAME = "ZZ-CS Correct Stock Fixture";
const RUN = Date.now().toString(36).slice(-6);
const ADMIN_EMAIL = `zz-qa-cs1-${RUN}@test.local`;
const ADMIN_PASSWORD = `Zz-qa-${RUN}!`;
let adminUserId = null;

/** Fill + submit the login form with explicit credentials (not qa-lib's
 *  CREDS map) — mirrors qa-lib's login() but for a freshly-minted account. */
async function loginAs(page, email, pass) {
  await page.goto(`${APP}/login`, { waitUntil: "load", timeout: 60000 });
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(pass);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 });
  await page.waitForLoadState("load");
}

const { browser, page } = await launch();

try {
  await login(page, "owner");
  await goto(page, "/master-inventory");

  const search = page.getByPlaceholder(/search name, sku, barcode/i).first();
  await search.fill(FIXTURE_NAME);
  await page.keyboard.press("Enter"); // skip the 600ms debounce
  await page.waitForTimeout(1200);

  // Actions button is aria-labelled by exact product name — substring match
  // would also hit a differently-named row, so exact: true.
  let actionsBtn = page.getByRole("button", { name: `Actions for ${FIXTURE_NAME}`, exact: true });
  const exists = await actionsBtn.isVisible().catch(() => false);

  if (!exists) {
    ok(`fixture "${FIXTURE_NAME}" not found — creating it via Add product`);
    await page.getByRole("button", { name: "Add product", exact: true }).click();
    await page.waitForTimeout(500);
    const dlg = page.locator('[data-slot="dialog-content"]').last();
    await dlg.locator("#ap-name").fill(FIXTURE_NAME);
    await dlg.locator("#ap-cost").fill("100");
    await dlg.locator("#ap-price").fill("150");
    await dlg.locator("#ap-qty").fill("10");
    await dlg.getByRole("button", { name: "Add product", exact: true }).click();
    await page.waitForTimeout(2000);

    // Re-search — the add dialog closes but the list needs a fresh filter pass.
    await search.fill(FIXTURE_NAME);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
    actionsBtn = page.getByRole("button", { name: `Actions for ${FIXTURE_NAME}`, exact: true });
  }
  check(await actionsBtn.isVisible().catch(() => false), "the fixture product row is listed");

  await actionsBtn.click();
  const item = page.getByRole("menuitem", { name: "Correct stock", exact: true });
  check(await item.isVisible().catch(() => false), "owner sees 'Correct stock'");
  await item.click();
  await page.waitForTimeout(400);

  const dialog = page.locator('[data-slot="dialog-content"]').last();
  const qty = dialog.getByLabel("Actual quantity");
  check(await qty.isVisible().catch(() => false), "the dialog opened");

  const systemText = await dialog.locator("text=/System says/").innerText();
  const currentQty = Number(systemText.match(/System says\s+([\d.]+)/)?.[1]);
  check(Number.isFinite(currentQty), `read the current master qty from the dialog (${systemText})`);
  const newQty = currentQty + 1;
  ok(`correcting "${FIXTURE_NAME}" from ${currentQty} to ${newQty}`);

  await qty.fill(String(newQty));
  await dialog.getByLabel("Reason").fill(`QA correction ${Date.now()}`);

  const save = dialog.getByRole("button", { name: "Correct stock", exact: true });
  check(await save.isEnabled(), "save enables once qty + reason are set");
  await save.click();
  await page.waitForTimeout(2500);
  await shot(page, "cs1-after-correct");

  // the database must agree with the screen
  const q = await dbAuth("owner");
  const rows = await q(`parts?select=id,name&name=eq.${encodeURIComponent(FIXTURE_NAME)}&deleted_at=is.null`);
  const partId = rows?.[0]?.id;
  check(!!partId, "found the fixture product in the database");
  if (partId) {
    const lvl = await q(`stock_levels?select=qty&part_id=eq.${partId}&shop_id=is.null`);
    check(
      Number(lvl?.[0]?.qty) === newQty,
      `master is ${newQty} in the DB (got ${lvl?.[0]?.qty})`
    );
    const mv = await q(
      `stock_movements?select=movement_type,qty_change,created_at&part_id=eq.${partId}&movement_type=eq.correction&order=created_at.desc&limit=1`
    );
    check((mv ?? []).length > 0, "a correction movement exists");
    check(
      Number(mv?.[0]?.qty_change) === 1,
      `the correction movement's delta is +1 (got ${mv?.[0]?.qty_change})`
    );
  }

  // admin must not see the control at all — provision a throwaway admin
  // login (see header note on why CREDS.admin isn't used here).
  const { data: created, error: cErr } = await svc.auth.admin.createUser({
    email: ADMIN_EMAIL, password: ADMIN_PASSWORD, email_confirm: true,
  });
  check(!cErr, "provisioned a throwaway admin auth user", cErr?.message);
  adminUserId = created?.user?.id ?? null;
  if (adminUserId) {
    const { error: pErr } = await svc.from("profiles").insert({
      id: adminUserId, full_name: `ZZ-QA cs1 Admin ${RUN}`, role: "admin", shop_id: null,
    });
    check(!pErr, "gave it an admin profile row", pErr?.message);
  }

  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();
  await loginAs(page2, ADMIN_EMAIL, ADMIN_PASSWORD);
  await goto(page2, "/master-inventory");
  const search2 = page2.getByPlaceholder(/search name, sku, barcode/i).first();
  await search2.fill(FIXTURE_NAME);
  await page2.keyboard.press("Enter");
  await page2.waitForTimeout(1200);

  const adminActionsBtn = page2.getByRole("button", {
    name: `Actions for ${FIXTURE_NAME}`,
    exact: true,
  });
  check(await adminActionsBtn.isVisible().catch(() => false), "admin also sees the fixture row");
  await adminActionsBtn.click();
  await page2.waitForTimeout(300);

  // Positive control FIRST: "Fitment" renders for both roles (unlike
  // "Correct stock"), so this proves the menu actually opened — a negative
  // check alone would pass vacuously against a blank/broken menu too.
  const adminFitment = page2.getByRole("menuitem", { name: "Fitment", exact: false });
  check(
    await adminFitment.isVisible().catch(() => false),
    "admin's menu genuinely opened (sees 'Fitment', a role-neutral item)"
  );

  const adminItem = page2.getByRole("menuitem", { name: "Correct stock", exact: true });
  check(
    !(await adminItem.isVisible().catch(() => false)),
    "admin does NOT see 'Correct stock'"
  );
  await shot(page2, "cs1-admin-menu");
  await ctx2.close();
} catch (e) {
  check(false, `run failed: ${e.message}`);
  await shot(page, "cs1-crash").catch(() => {});
} finally {
  await browser.close();
  if (adminUserId) {
    const { error } = await svc.auth.admin.deleteUser(adminUserId);
    check(!error, "cleanup: fixture admin login removed", error?.message);
  }
}

const failed = summary();
process.exit(failed ? 1 : 0);
