// Re-verification of the Task 14 fixes: B1 (dead "New Return" hint), B2
// (exhausted colour palette is unexplained), B3 (upload widget alt text still
// says "product photo" for shop logos and staff photos).
//
// Read-only apart from opening dialogs: the close-shop dialog is exercised on a
// branch that CANNOT be closed, so the destructive action is not even rendered.
import {
  launch, login, goto, bodyText, shot, dbAuth, makePng,
  step, check, summary,
} from "./qa-lib.mjs";

const OTHER = "Gerwin-Silang"; // not Shop 1 (Ternate) or Shop 2 (Naic)
const PNG = "c:/Users/rober/AppData/Local/Temp/zzqb-fixcheck.png";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner");

async function shopMenu(name) {
  await page.getByRole("button", { name: `More actions for ${name}`, exact: true })
    .first().click();
  await page.waitForTimeout(500);
  return page.locator('[role="menu"]').last().innerText();
}
function card(name) {
  return page.locator('[data-slot="card"]').filter({ hasText: name }).first();
}

try {
  await login(page, "owner");
  await goto(page, "/shops");
  await page.waitForTimeout(3000);

  // ── B1: the close-shop blocker names a control that exists ────────────────
  step("B1: close-shop blocker points at a real remedy");
  await shopMenu(OTHER);
  await page.getByRole("menuitem", { name: /Close Permanently/ }).click();
  await page.waitForTimeout(1400);
  const dlg = await page.locator('[role="dialog"]').last().innerText();
  check(!/New Return/.test(dlg),
    "❌ the retired 'New Return' tab is no longer named",
    (dlg.match(/→ [^\n]*/g) || []).join(" | "));
  check(/Transfers → Return to Admin/.test(dlg),
    "the hint names the shop-initiated return path (0065)",
    (dlg.match(/→ the shop returns[^\n]*/) || ["absent"])[0]);
  check(/Deliveries & Returns → Transfers & Returns/.test(dlg),
    "…and where the office approves it");
  // that tab really exists
  await page.getByRole("button", { name: "Got it", exact: true }).click();
  await page.waitForTimeout(700);
  await goto(page, "/deliveries");
  await page.waitForTimeout(3000);
  const tabs = await page.locator('[role="tab"]').allTextContents();
  check(tabs.some((t) => /Transfers & Returns/.test(t)),
    "the named tab exists on Deliveries & Returns", tabs.join(" | "));
  check(!tabs.some((t) => /New Return/.test(t)),
    "❌ and there is still no 'New Return' tab (retired by 0065)", tabs.join(" | "));
  await shot(page, "task14-fix-b1");

  // ── B2: an exhausted palette explains itself ──────────────────────────────
  step("B2: exhausted colour palette is explained");
  await goto(page, "/shops");
  await page.waitForTimeout(3000);
  await page.getByRole("button", { name: "Add shop", exact: true }).click();
  await page.waitForTimeout(1200);
  const sw = await page.locator('button[aria-label^="Color "]').evaluateAll((els) =>
    els.map((e) => e.disabled));
  const free = sw.filter((d) => !d).length;
  const t = await T();
  console.log(`  palette: ${sw.length - free} taken · ${free} free`);
  if (free === 0) {
    check(/All \d+ colors are in use by other shops/.test(t),
      "the exhausted palette now says why every circle is greyed out",
      (t.match(/All \d+ colors[^\n]*/) || ["absent"])[0]);
    check(/A color frees up when a shop is closed\./.test(t),
      "…and how to free one");
  } else {
    check(true, `${free} colour(s) free — the exhausted-state copy is correctly hidden`);
    check(!/All \d+ colors are in use/.test(t),
      "the exhausted notice does NOT show while a colour is free");
  }
  await shot(page, "task14-fix-b2");

  // ── B3: upload widget names what is actually being uploaded ───────────────
  step("B3: image upload alt text follows the subject");
  makePng(PNG, 48, 36, [90, 60, 190]);
  await page.locator('input[type="file"]').first().setInputFiles(PNG);
  await page.waitForTimeout(1500);
  const logoAlts = await page.locator('[role="dialog"] img').evaluateAll((els) =>
    els.map((e) => e.getAttribute("alt")));
  check(logoAlts.some((a) => /shop logo/i.test(a ?? "")),
    "shop-logo preview alt names the shop logo", JSON.stringify(logoAlts));
  check(!logoAlts.some((a) => /product photo/i.test(a ?? "")),
    "❌ no 'product photo' alt on the shop-logo field", JSON.stringify(logoAlts));
  const logoLabel = await page.locator('[role="dialog"] button[aria-label*="shop logo"]').count();
  check(logoLabel > 0, "drop-zone aria-label still names the shop logo");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);

  // staff photo
  await goto(page, "/shops");
  await page.waitForTimeout(2500);
  await card(OTHER).scrollIntoViewIfNeeded();
  await card(OTHER).getByRole("button", { name: /Add Employee/ }).click();
  await page.waitForTimeout(1200);
  await page.locator('input[type="file"]').first().setInputFiles(PNG);
  await page.waitForTimeout(1500);
  const staffAlts = await page.locator('[role="dialog"] img').evaluateAll((els) =>
    els.map((e) => e.getAttribute("alt")));
  check(staffAlts.some((a) => /employee photo/i.test(a ?? "")),
    "staff preview alt names the employee photo", JSON.stringify(staffAlts));
  check(!staffAlts.some((a) => /product photo/i.test(a ?? "")),
    "❌ no 'product photo' alt on the staff field", JSON.stringify(staffAlts));
  await shot(page, "task14-fix-b3");
  // leave without saving — this check creates no fixture
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.waitForTimeout(800);
  const strays = await q("staff?select=id&full_name=like.ZZ-QB*&deleted_at=is.null");
  check(strays.length === 0, "no staff fixture was created by this check",
    `${strays.length} rows`);

  // the product path must be unchanged
  step("B3: the product photo path is unchanged");
  await goto(page, "/master-inventory");
  await page.waitForTimeout(3500);
  await page.locator('[aria-label^="Actions for"]').first().click();
  await page.waitForTimeout(700);
  await page.getByRole("menuitem", { name: /^Edit/ }).first().click();
  await page.waitForTimeout(1500);
  const prodLabel = await page.locator('[role="dialog"] button[aria-label*="product photo"]').count();
  check(prodLabel > 0, "product edit still says 'product photo'", `${prodLabel} match`);
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task14-fixes-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 6) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
