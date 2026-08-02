// Task 14 (Shops & Employees) — ADMIN half: Steps 2–11 · 16.
//
// 0104 made this page office-wide, so the admin does the daily upkeep (details,
// pin, colour, logo, staff) while credentials + close stay Gerry's. What needs
// proving here is that the four Gerry-only controls never RENDER for the admin —
// a rendered-but-refused button surfaces a raw Postgres error to a trusted user.
//
// Fixtures: everything is prefixed ZZ-QB. A NEW shop is created for this run;
// Shop 1 (Gerwin-Ternate) and Shop 2 (Gerwin-Naic) are never touched.
import {
  launch, login, goto, bodyText, shot, dbAuth, makePng,
  step, check, summary, toast, clearToasts,
} from "./qa-lib.mjs";

const SHOP = "ZZ-QB Branch";
const STAFF = "ZZ-QB Maria Santos";
const PNG = "c:/Users/rober/AppData/Local/Temp/zzqb-photo.png";

const { browser, page, errors } = await launch();
const T = () => bodyText(page);
const q = await dbAuth("owner"); // read-only probe; owner sees every shop

/** The shop card's kebab menu text, for presence/absence assertions. */
async function shopMenu(name) {
  await page.getByRole("button", { name: `More actions for ${name}`, exact: true })
    .first().click();
  await page.waitForTimeout(500);
  const txt = await page.locator('[role="menu"]').last().innerText();
  return txt;
}
async function closeMenu() {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}
/** Scroll a shop card into view and return its card locator. */
function card(name) {
  return page.locator('[data-slot="card"]').filter({ hasText: name }).first();
}

try {
  await login(page, "admin");
  await goto(page, "/shops");
  await page.waitForTimeout(2500);

  // ── Step 2: create a shop as ADMIN ────────────────────────────────────────
  step("Step 2: create a shop (ADMIN)");
  const before = await q("shops?select=id&deleted_at=is.null");
  await page.getByRole("button", { name: "Add shop", exact: true }).click();
  await page.waitForTimeout(800);
  check(
    (await page.locator("#shop-name").getAttribute("placeholder")) === "Branch 3 — Landing",
    "Name placeholder is 'Branch 3 — Landing'",
    await page.locator("#shop-name").getAttribute("placeholder")
  );
  check(
    (await page.locator("#shop-loc").getAttribute("placeholder")) === "e.g. Poblacion",
    "Location placeholder is 'e.g. Poblacion'",
    await page.locator("#shop-loc").getAttribute("placeholder")
  );

  // ── Step 4 (in the same dialog): colour picker ────────────────────────────
  step("Step 4: shop colour picker");
  const swatches = page.locator('button[aria-label^="Color "]');
  const nSw = await swatches.count();
  check(nSw === 10, "ten palette swatches render", `${nSw}`);
  const labels = await swatches.evaluateAll((els) =>
    els.map((e) => ({
      label: e.getAttribute("aria-label"),
      pressed: e.getAttribute("aria-pressed"),
      disabled: e.disabled,
    }))
  );
  check(labels.every((l) => l.pressed !== null), "every swatch carries aria-pressed");
  const taken = labels.filter((l) => l.disabled);
  check(
    taken.every((l) => / — used by /.test(l.label)),
    "taken swatches name their owning shop in aria-label",
    taken.map((l) => l.label).join(" | ").slice(0, 160)
  );
  check(
    /\(neutral — tap a circle to pick, tap again to clear; greyed = taken\)/.test(await T()),
    "neutral hint shows while nothing is selected"
  );
  // B2: 10 keys, 10 live shops → an 11th shop can never take a colour.
  const free = labels.filter((l) => !l.disabled);
  console.log(`  palette: ${taken.length} taken · ${free.length} free`);
  if (free.length === 0) {
    check(false,
      "B2 — every colour is taken, so a new shop cannot be given one (palette exhausted at 10 live shops)");
  } else {
    await swatches.nth(labels.findIndex((l) => !l.disabled)).click();
    await page.waitForTimeout(400);
    check(true, `picked a free colour: ${free[0].label}`);
  }

  await page.locator("#shop-name").fill(SHOP);
  await page.locator("#shop-loc").fill("QA Town");
  await shot(page, "task14-step2-newshop");
  await page.getByRole("button", { name: "Create shop", exact: true }).click();
  const t2 = await toast(page);
  check(/Shop created/.test(t2), "toast 'Shop created'", t2);
  await page.waitForTimeout(2500);
  const after = await q("shops?select=id,name,color_key,active&deleted_at=is.null");
  const mine = after.find((s) => s.name === SHOP);
  check(!!mine, "shop row persisted", mine ? mine.name : "absent");
  check(after.length === before.length + 1, "exactly one shop added",
    `${before.length} → ${after.length}`);
  const SHOP_ID = mine?.id;
  await clearToasts(page);
  await goto(page, "/shops");
  await page.waitForTimeout(2000);
  check(/ZZ-QB Branch/.test(await T()), "new card appears on the page");

  // ── Step 3: map pin ───────────────────────────────────────────────────────
  step("Step 3: map pin persists");
  let menu = await shopMenu(SHOP);
  check(/Edit Shop Details/.test(menu), "admin sees 'Edit Shop Details'");
  await page.getByRole("menuitem", { name: /Edit Shop Details/ }).click();
  await page.waitForTimeout(2500);
  const mapBox = page.locator(".leaflet-container").first();
  if (await mapBox.count()) {
    const box = await mapBox.boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const t3 = await toast(page);
    check(/Shop updated/.test(t3), "toast 'Shop updated' after dropping a pin", t3);
    await page.waitForTimeout(2200);
    const pinned = (await q(`shops?select=latitude,longitude&id=eq.${SHOP_ID}`))[0];
    check(pinned.latitude !== null && pinned.longitude !== null,
      "pin coordinates persisted", `${pinned.latitude},${pinned.longitude}`);
    // re-open and confirm the same coordinates come back
    await clearToasts(page);
    await goto(page, "/shops");
    await page.waitForTimeout(2000);
    await shopMenu(SHOP);
    await page.getByRole("menuitem", { name: /Edit Shop Details/ }).click();
    await page.waitForTimeout(2500);
    const again = (await q(`shops?select=latitude,longitude&id=eq.${SHOP_ID}`))[0];
    check(again.latitude === pinned.latitude && again.longitude === pinned.longitude,
      "re-opening shows the same coordinates", `${again.latitude},${again.longitude}`);
  } else {
    check(false, "LocationPicker map rendered");
  }

  // ── Step 5: logo upload ───────────────────────────────────────────────────
  step("Step 5: shop logo upload + remove");
  makePng(PNG, 80, 60, [30, 120, 200]);
  check(/Printed on this branch's receipts, in place of the anchor/.test(await T()),
    "logo helper copy present");
  await page.locator('input[type="file"]').first().setInputFiles(PNG);
  await page.waitForTimeout(1500);
  check(/WebP/.test(await T()), "before→after byte readout shows WebP",
    ((await T()).match(/[\d.]+ ?[KM]B[^\n]*/) || ["absent"])[0]);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(3500);
  const withLogo = (await q(`shops?select=logo_path&id=eq.${SHOP_ID}`))[0];
  check(!!withLogo.logo_path, "logo_path persisted", withLogo.logo_path || "null");
  await clearToasts(page);

  // remove the logo again → anchor returns
  await goto(page, "/shops");
  await page.waitForTimeout(2000);
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Edit Shop Details/ }).click();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Remove", exact: true }).first().click();
  await page.waitForTimeout(400);
  check(/Photo will be removed on save\./.test(await T()), "remove warning shown");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(3500);
  const noLogo = (await q(`shops?select=logo_path&id=eq.${SHOP_ID}`))[0];
  check(noLogo.logo_path === null, "logo cleared → anchor returns", String(noLogo.logo_path));
  await clearToasts(page);

  // ── Step 6: logo upload failure still saves the row ───────────────────────
  step("Step 6: logo partial-failure copy");
  await goto(page, "/shops");
  await page.waitForTimeout(2000);
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Edit Shop Details/ }).click();
  await page.waitForTimeout(2500);
  await page.route("**/storage/v1/object/product-images/shop-logos/**", (r) => r.abort());
  await page.locator('input[type="file"]').first().setInputFiles(PNG);
  await page.waitForTimeout(1500);
  await page.locator("#shop-loc").fill("QA Town 2");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(4000);
  const failTxt = await page.locator("[data-sonner-toast]").allTextContents();
  check(/Shop saved, but the logo upload failed/.test(failTxt.join(" | ")),
    "toast 'Shop saved, but the logo upload failed: …'", failTxt.join(" | ") || "none");
  const rowAfterFail = (await q(`shops?select=location,logo_path&id=eq.${SHOP_ID}`))[0];
  check(rowAfterFail.location === "QA Town 2",
    "the shop row saved even though the image did not", rowAfterFail.location);
  check(rowAfterFail.logo_path === null, "no logo path was written on failure",
    String(rowAfterFail.logo_path));
  await page.unroute("**/storage/v1/object/product-images/shop-logos/**");
  await clearToasts(page);

  // ── Step 10: staff empty state (before adding anyone) ─────────────────────
  step("Step 10: staff empty state");
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  const myCard = card(SHOP);
  await myCard.scrollIntoViewIfNeeded();
  check(/No employees yet — add the people who work here\./.test(await myCard.innerText()),
    "empty state on a shop with no staff");
  // innerText applies text-transform, and this header is `uppercase` — so it
  // reads "EMPLOYEES (0)". Match case-insensitively.
  check(/Employees \(0\)/i.test(await myCard.innerText()), "header counter reads Employees (0)");

  // ── Step 8: staff photo failure ABORTS the record ─────────────────────────
  step("Step 8: staff photo failure aborts the save");
  await myCard.getByRole("button", { name: /Add Employee/ }).click();
  await page.waitForTimeout(1200);
  check(/The people who work at this shop\. A birthday turns on the reminder/.test(await T()),
    "staff dialog description present");
  await page.locator("#staff-name").fill(STAFF);
  await page.route("**/storage/v1/object/product-images/staff-photos/**", (r) => r.abort());
  await page.locator('input[type="file"]').first().setInputFiles(PNG);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Add employee", exact: true }).click();
  await page.waitForTimeout(3000);
  const abortTxt = (await page.locator("[data-sonner-toast]").allTextContents()).join(" | ");
  check(/Photo upload failed/.test(abortTxt), "toast 'Photo upload failed: …'", abortTxt || "none");
  const staffAfterFail = await q(`staff?select=id&full_name=eq.${encodeURIComponent(STAFF)}&deleted_at=is.null`);
  check(staffAfterFail.length === 0,
    "❌ staff record NOT written when the photo fails (differs from the logo path)",
    `${staffAfterFail.length} rows`);
  await page.unroute("**/storage/v1/object/product-images/staff-photos/**");
  await clearToasts(page);

  // ── Step 7: staff create WITH photo ───────────────────────────────────────
  step("Step 7: create staff with a photo");
  const addBtn = page.getByRole("button", { name: "Add employee", exact: true });
  check(await addBtn.isEnabled(), "Add employee is enabled once a name is present");
  await page.locator("#staff-name").fill("");
  await page.waitForTimeout(400);
  check(await addBtn.isDisabled(), "❌ Add employee is DISABLED with a blank name");
  await page.locator("#staff-name").fill(STAFF);
  await page.locator("#staff-notes").fill("ZZ-QB fixture");
  await page.locator('input[type="file"]').first().setInputFiles(PNG);
  await page.waitForTimeout(1600);
  check(/\d+×\d+/.test(await T()), "photo W×H readout renders",
    ((await T()).match(/\d+×\d+/) || ["absent"])[0]);
  await shot(page, "task14-step7-staff");
  await addBtn.click();
  const t7 = await toast(page);
  check(/Employee added/.test(t7), "toast 'Employee added'", t7);
  await page.waitForTimeout(2500);
  const st = (await q(`staff?select=id,full_name,image_path,shop_id,active&full_name=eq.${encodeURIComponent(STAFF)}&deleted_at=is.null`))[0];
  check(!!st, "staff row persisted");
  check(!!st?.image_path, "staff photo path persisted", st?.image_path || "null");
  check(st?.shop_id === SHOP_ID, "staff assigned to the ZZ-QB shop");
  await clearToasts(page);
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  check(/Employees \(1\)/i.test(await card(SHOP).innerText()), "counter moved to Employees (1)");

  // ── Step 9: staff edit / deactivate / remove ──────────────────────────────
  step("Step 9: staff edit, deactivate, remove");
  await card(SHOP).getByRole("button", { name: `Actions for ${STAFF}`, exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("menuitem", { name: /^Edit/ }).click();
  await page.waitForTimeout(1200);
  // shop select must list every shop, including inactive ones
  await page.locator('[role="combobox"]').first().click();
  await page.waitForTimeout(500);
  const opts = await page.getByRole("option").allTextContents();
  const liveShops = (await q("shops?select=name&deleted_at=is.null")).map((s) => s.name);
  check(opts.length === liveShops.length,
    "staff Shop select lists every live shop", `${opts.length} of ${liveShops.length}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  await page.locator("#staff-name").fill(`${STAFF} Jr`);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const t9 = await toast(page);
  check(/Employee updated/.test(t9), "toast 'Employee updated'", t9);
  await page.waitForTimeout(2200);
  await clearToasts(page);

  // deactivate → opacity-60
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  await card(SHOP).getByRole("button", { name: `Actions for ${STAFF} Jr`, exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("menuitem", { name: /^Edit/ }).click();
  await page.waitForTimeout(1200);
  await page.getByRole("checkbox").last().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(2500);
  await clearToasts(page);
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  const dimmed = await page.locator('div.opacity-60').filter({ hasText: `${STAFF} Jr` }).count();
  check(dimmed > 0, "deactivated staff row renders at opacity-60", `${dimmed} match`);
  check(/· inactive/.test(await card(SHOP).innerText()), "row is captioned '· inactive'");

  // remove
  await card(SHOP).getByRole("button", { name: `Actions for ${STAFF} Jr`, exact: true }).click();
  await page.waitForTimeout(500);
  await page.getByRole("menuitem", { name: /Remove/ }).click();
  await page.waitForTimeout(900);
  check(new RegExp(`Remove ${STAFF} Jr\\?`).test(await T()), "confirm dialog names the staffer");
  await page.getByRole("button", { name: "Remove", exact: true }).last().click();
  const t9b = await toast(page);
  check(/removed/.test(t9b), "toast '<name> removed'", t9b);
  await page.waitForTimeout(2500);
  const gone = await q(`staff?select=id&full_name=like.${encodeURIComponent(STAFF)}*&deleted_at=is.null`);
  check(gone.length === 0, "staff soft-deleted", `${gone.length} live rows`);
  await clearToasts(page);

  // ── Step 11: credentials + close are Gerry-only (all ❌ for the admin) ─────
  step("Step 11: Gerry-only controls are absent for ADMIN");
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  menu = await shopMenu(SHOP);
  for (const absent of ["Create Login", "Change Credentials", "Close Permanently", "View Reports"]) {
    check(!new RegExp(absent).test(menu), `❌ no '${absent}' in the admin's menu`,
      menu.replace(/\n/g, " · "));
  }
  check(/Edit Shop Details/.test(menu), "admin keeps 'Edit Shop Details'");
  await closeMenu();
  const cardTxt = await card(SHOP).innerText();
  check(/No login account yet — the shop can't sign in\./.test(cardTxt),
    "no-login panel copy present");
  check(/Only the owner can create the login\./.test(cardTxt),
    "admin sees 'Only the owner can create the login.' instead of a button");
  check((await card(SHOP).getByRole("button", { name: /Create shop login/ }).count()) === 0,
    "❌ no 'Create shop login' button for the admin");
  await shot(page, "task14-step11-adminmenu");

  // ── Step 16: admin cannot close ───────────────────────────────────────────
  step("Step 16: admin cannot close a shop");
  check(!/Close Permanently/.test(menu),
    "❌ the close control is absent from the admin's UI (app layer)");
  console.log("  DB layer: enforce_shop_close_lock (0104) + the pre-sweep role-matrix");
  console.log("  probe (29 assertions, log A) already prove the refusal; not re-run here");
  console.log("  because the QA probe is read-only by design.");

  // ── Step 1 leftovers: inactive card renders at opacity-75 ─────────────────
  step("Step 1: inactive shop card renders at opacity-75");
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Edit Shop Details/ }).click();
  await page.waitForTimeout(2500);
  await page.getByRole("checkbox").last().click(); // "Active (can receive deliveries)"
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(3000);
  await clearToasts(page);
  await goto(page, "/shops");
  await page.waitForTimeout(2200);
  const inactiveCards = await page.locator('[data-slot="card"].opacity-75').filter({ hasText: SHOP }).count();
  check(inactiveCards > 0, "inactive shop card is opacity-75", `${inactiveCards} match`);
  check(/Inactive/.test(await card(SHOP).innerText()), "'Inactive' badge renders");

  // leave it active again for the GERRY half
  await shopMenu(SHOP);
  await page.getByRole("menuitem", { name: /Edit Shop Details/ }).click();
  await page.waitForTimeout(2500);
  await page.getByRole("checkbox").last().click();
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForTimeout(3000);

  console.log(`\n  SHOP_ID for the GERRY half: ${SHOP_ID}`);
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
  await shot(page, "task14a-crash").catch(() => {});
} finally {
  console.log("\nconsole errors:", errors.length ? errors.slice(0, 8) : "none");
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
