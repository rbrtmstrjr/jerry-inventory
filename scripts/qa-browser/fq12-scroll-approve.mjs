// FQ12 — reach our fractional sale in a 550-item lazy queue and approve it.
// The shell is h-svh overflow-hidden, so window.scrollBy does nothing; the
// scroll lives on an inner container that must be found first.
import {
  launch, session, goto, shot, check, step, summary, toast, dbAuth,
} from "./qa-lib.mjs";

const NAILS_NAME = process.argv[2];
const { browser } = await launch({ headless: true });
const q = await dbAuth("owner");
const PART = (await q(`parts?name=eq.${encodeURIComponent(NAILS_NAME)}&select=id`))[0];
const TERNATE = "a46c9c78-a995-46b3-954f-7836ab161254";

try {
  const owner = await session(browser, "owner");
  await goto(owner.page, "/approvals");
  await owner.page.waitForTimeout(2500);

  step("Find the real scroll container");
  const info = await owner.page.evaluate(() => {
    const cands = [...document.querySelectorAll("*")]
      .filter((e) => e.scrollHeight > e.clientHeight + 100)
      .map((e) => ({
        tag: e.tagName,
        cls: (e.className || "").toString().slice(0, 70),
        sh: e.scrollHeight,
        ch: e.clientHeight,
        oy: getComputedStyle(e).overflowY,
      }));
    return cands.slice(0, 6);
  });
  console.log("  scrollable candidates:", JSON.stringify(info, null, 1));

  step("Scroll until our fractional sale is in the DOM");
  let found = false;
  for (let i = 0; i < 60 && !found; i++) {
    found = await owner.page.evaluate(
      (n) => document.body.innerText.toLowerCase().includes(n.toLowerCase()),
      NAILS_NAME
    );
    if (found) break;
    await owner.page.evaluate(() => {
      const el = [...document.querySelectorAll("*")]
        .filter((e) => e.scrollHeight > e.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(e).overflowY))
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      (el || document.scrollingElement).scrollBy(0, 2000);
    });
    await owner.page.waitForTimeout(700);
  }
  check(found, `scrolled the lazy queue until ${NAILS_NAME} was rendered`);
  if (!found) throw new Error("never reached our card");

  await shot(owner.page, "fq12-01-found-card");

  step("Approve our sale(s) one at a time");
  const before = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
  let approved = 0;
  for (let round = 0; round < 3; round++) {
    const h = await owner.page.evaluateHandle((name) => {
      const wanted = name.toLowerCase();
      let best = null;
      for (const el of document.querySelectorAll("div,li")) {
        const t = (el.innerText || "").toLowerCase();
        if (!t.includes(wanted)) continue;
        const btns = [...el.querySelectorAll("button")].filter(
          (b) => /^approve$/i.test((b.innerText || "").trim())
        );
        if (btns.length !== 1) continue;
        if (!best || el.innerText.length < best.innerText.length) best = el;
      }
      return best
        ? [...best.querySelectorAll("button")].find((b) => /^approve$/i.test((b.innerText || "").trim()))
        : null;
    }, NAILS_NAME);
    const el = h.asElement();
    if (!el) { console.log(`  round ${round}: nothing more to approve`); break; }
    await el.scrollIntoViewIfNeeded?.().catch(() => {});
    await el.click();
    const t = await toast(owner.page, { timeout: 25000 });
    console.log(`  round ${round} toast: ${t}`);
    await owner.page.waitForTimeout(2500);
    if (/approved/i.test(t)) approved++; else break;
  }
  check(approved > 0, `approved ${approved} fractional sale(s)`);

  const after = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
  const delta = Number((before - after).toFixed(10));
  console.log(`  shop stock ${before} -> ${after} (delta ${delta})`);
  check(delta > 0, "fractional stock left the shelf on approval", `${before} -> ${after}`);
  check(
    Math.abs(delta * 10 - Math.round(delta * 10)) < 1e-9,
    "the deduction is an exact tenth (numeric, not float)",
    String(delta)
  );

  const mv = await q(`stock_movements?part_id=eq.${PART.id}&select=qty_change,shop_id,movement_type`);
  const lv = await q(`stock_levels?part_id=eq.${PART.id}&select=qty,shop_id`);
  const s = (a, k) => a.reduce((x, r) => x + Number(r[k]), 0);
  let ok = true;
  for (const sid of new Set([...mv.map((m) => m.shop_id), ...lv.map((l) => l.shop_id)])) {
    const ledger = s(mv.filter((m) => m.shop_id === sid && m.movement_type !== "transit_writeoff"), "qty_change");
    const shelf = s(lv.filter((l) => l.shop_id === sid), "qty");
    const good = Math.abs(ledger - shelf) < 1e-9;
    if (!good) ok = false;
    console.log(`      ${sid ?? "master"}: ledger ${ledger} vs shelf ${shelf} ${good ? "OK" : "MISMATCH"}`);
  }
  check(ok, "invariant holds after approving a fractional sale");

  step("0126 defect 2 — a reviewed line below 1 prints its quantity");
  const rev = await q(`reviewed_items?item_type=eq.sale&select=summary&order=event_at.desc&limit=30`);
  const ours = rev.filter((r) => new RegExp(NAILS_NAME, "i").test(r.summary ?? ""));
  console.log("  our summaries:", JSON.stringify(ours.map((r) => r.summary)));
  check(ours.length > 0, "our sale reached the reviewed history");
  const half = ours.some((r) => /×\s*0\.5/.test(r.summary ?? ""));
  const twoThree = ours.some((r) => /×\s*2\.3/.test(r.summary ?? ""));
  check(half || twoThree, "a fractional quantity prints in the summary",
    JSON.stringify(ours.map((r) => r.summary)));
  if (half) check(true, "0126 defect 2 CONFIRMED FIXED — '× 0.5' prints (was omitted entirely)");
  check(!ours.some((r) => /\b\d+\.0\b/.test(r.summary ?? "")), "no N.0 in our summaries");

  console.log("CONSOLE ERRORS:", (owner.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ12 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
