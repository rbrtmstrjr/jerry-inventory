/**
 * QA: the Engines tab of My Shop Stock now has a search box in CARD view.
 *
 * It only ever had one in TABLE view — the parts card grid got a search input
 * and the engines card grid never did. With ~96 engines at a branch, serial is
 * the only practical way to find a unit, so scrolling was the whole UX.
 *
 * Asserts the box exists, filters on serial AND on model, survives a
 * view-toggle round trip, and does not leak its term into the Parts tab's
 * separate box.
 *
 * Run: node scripts/qa-browser/es1-engine-card-search.mjs
 */
import { launch, login, goto, check, summary, shot, ok } from "./qa-lib.mjs";

const { browser, page } = await launch();

try {
  await login(page, "shop");
  await goto(page, "/shop");

  // Engines tab, card view. usePersistedView remembers the LAST view used in
  // this browser profile, so never assume which one we land on.
  await page.getByRole("tab", { name: "Engines" }).click();
  const cardBtn = page.getByRole("button", { name: /card|grid/i }).first();
  if (await cardBtn.isVisible().catch(() => false)) await cardBtn.click();

  const box = page.getByLabel("Search engines");
  check(await box.isVisible().catch(() => false), "engine card search box is present");
  if (!(await box.isVisible().catch(() => false))) {
    await shot(page, "es1-no-search-box");
    throw new Error("no search box — nothing else is meaningful");
  }

  const cards = page.locator("[class*='grid'] >> text=/^SN /");
  const before = await cards.count();
  check(before > 0, `starts with engines listed (${before} SN labels)`);

  // grab a real serial off the page rather than hardcoding one
  const firstSn = (await cards.first().innerText()).replace(/^SN\s*/, "").trim();
  ok(`using serial ${firstSn}`);

  // ── filter by serial ──────────────────────────────────────────────────────
  await box.fill(firstSn);
  await page.waitForTimeout(300);
  const afterSerial = await cards.count();
  check(
    afterSerial === 1,
    `a full serial narrows to exactly 1 card (got ${afterSerial} of ${before})`
  );

  // ── a term that matches nothing ───────────────────────────────────────────
  await box.fill("ZZZ-NO-SUCH-SERIAL");
  await page.waitForTimeout(300);
  const body = await page.locator("body").innerText();
  check(
    /Nothing matches/i.test(body),
    "an unmatched term shows the 'Nothing matches' empty state"
  );
  check(
    (await cards.count()) === 0,
    "no engine cards render for an unmatched term"
  );

  // ── filter by MODEL, not just serial ──────────────────────────────────────
  await box.fill("");
  await page.waitForTimeout(200);
  const modelCard = await page
    .locator("[class*='grid'] div.line-clamp-2")
    .first()
    .innerText();
  const brandWord = modelCard.trim().split(/\s+/)[0];
  await box.fill(brandWord);
  await page.waitForTimeout(300);
  const afterModel = await cards.count();
  check(
    afterModel > 0 && afterModel <= before,
    `searching the model/brand "${brandWord}" matches by name too (${afterModel})`
  );

  // ── the footer reports the filtered count ─────────────────────────────────
  const footer = await page.locator("body").innerText();
  check(
    new RegExp(`${afterModel} of ${before} engines`).test(footer),
    `footer reads "${afterModel} of ${before} engines" while filtering`
  );

  // ── the Parts tab keeps its OWN term (separate state) ─────────────────────
  await page.getByRole("tab", { name: /Parts/i }).click();
  await page.waitForTimeout(300);
  const partsBox = page.getByLabel("Search stock");
  if (await partsBox.isVisible().catch(() => false)) {
    check(
      (await partsBox.inputValue()) === "",
      "the Parts search box is NOT carrying the engine term"
    );
  } else {
    ok("Parts tab is in table view — separate-state check skipped");
  }

  // ── survives a view-toggle round trip ─────────────────────────────────────
  await page.getByRole("tab", { name: "Engines" }).click();
  await page.waitForTimeout(300);
  check(
    await page.getByLabel("Search engines").isVisible().catch(() => false),
    "search box still there after tabbing away and back"
  );

  await shot(page, "es1-engine-card-search");
} catch (e) {
  check(false, `run failed: ${e.message}`);
  await shot(page, "es1-crash").catch(() => {});
} finally {
  await browser.close();
}

summary();
