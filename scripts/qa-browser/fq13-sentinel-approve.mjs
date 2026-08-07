// FQ13 — reach our sale using the SENTINEL technique the repo README documents:
// "the approvals list lazy-loads via a 'Loading more…' sentinel that must stay
// IN view (scroll the sentinel into view repeatedly; wheeling past it stalls
// loading)". Jump-scrolling by a fixed delta skips past it and loading stops —
// which is exactly what happened in fq5 and fq12.
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
  await owner.page.waitForTimeout(3000);

  step("Keep the lazy-load sentinel in view until our sale renders");
  let found = false;
  for (let i = 0; i < 80 && !found; i++) {
    found = await owner.page.evaluate(
      (n) => document.body.innerText.toLowerCase().includes(n.toLowerCase()),
      NAILS_NAME
    );
    if (found) break;

    const moved = await owner.page.evaluate(() => {
      // The sentinel is the SMALLEST element carrying the text. Using .find()
      // on innerText returns the OUTERMOST match (the page shell contains it
      // too), and scrollIntoView on that jumps back to the top every pass —
      // which looks exactly like a stalled lazy-load.
      const matches = [...document.querySelectorAll("div,p,span")].filter((e) =>
        /loading more|load more/i.test(e.innerText || "")
      );
      const sentinel = matches.sort(
        (a, b) => (a.innerText || "").length - (b.innerText || "").length
      )[0];
      if (sentinel) {
        sentinel.scrollIntoView({ block: "center" });
        return "sentinel";
      }
      // no sentinel yet -> nudge the scroller a screen at a time (not a jump)
      const sc = [...document.querySelectorAll("*")]
        .filter((e) => e.scrollHeight > e.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(e).overflowY))
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      if (!sc) return "none";
      const atEnd = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      sc.scrollBy(0, Math.floor(sc.clientHeight * 0.85));
      return atEnd ? "end" : "step";
    });
    if (i % 10 === 0) console.log(`  ${i}: ${moved}`);
    await owner.page.waitForTimeout(700);
  }
  check(found, `reached ${NAILS_NAME} in the pending queue`);
  if (!found) throw new Error("card never rendered");
  await shot(owner.page, "fq13-01-card-found");

  step("Approve our fractional sale(s), one card at a time");
  const before = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
  let approved = 0;
  for (let round = 0; round < 4; round++) {
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
    if (!el) { console.log(`  round ${round}: no card left`); break; }
    await owner.page.evaluate((b) => b.scrollIntoView({ block: "center" }), el);
    await owner.page.waitForTimeout(300);
    await el.click();
    const t = await toast(owner.page, { timeout: 25000 });
    console.log(`  round ${round}: ${t}`);
    await owner.page.waitForTimeout(2500);
    if (/approved/i.test(t)) approved++; else break;
  }
  check(approved > 0, `approved ${approved} fractional sale(s) individually`);

  const after = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
  const delta = Number((before - after).toFixed(10));
  console.log(`  shop stock ${before} -> ${after} (delta ${delta})`);
  check(delta > 0, "fractional stock left the shelf on approval", `${before} -> ${after}`);
  check(
    Math.abs(delta * 10 - Math.round(delta * 10)) < 1e-9,
    "the deduction is an exact tenth (numeric, no float drift)",
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
  check(ok, "invariant holds after approving fractional sales");

  step("0126 defect 2 — a reviewed line below 1 prints its quantity");
  const rev = await q(`reviewed_items?item_type=eq.sale&select=summary&order=event_at.desc&limit=30`);
  const ours = rev.filter((r) => new RegExp(NAILS_NAME, "i").test(r.summary ?? ""));
  console.log("  our summaries:", JSON.stringify(ours.map((r) => r.summary)));
  check(ours.length > 0, "our sale reached the reviewed history");
  check(
    ours.some((r) => /×\s*(0\.5|2\.3)/.test(r.summary ?? "")),
    "the fractional quantity PRINTS in the summary (pre-0126 a <1 qty printed nothing)",
    JSON.stringify(ours.map((r) => r.summary))
  );
  check(!ours.some((r) => /\b\d+\.0\b/.test(r.summary ?? "")), "no N.0 in our summaries");

  await goto(owner.page, "/approvals?tab=sales");
  await owner.page.waitForTimeout(2500);
  await shot(owner.page, "fq13-02-reviewed");
  console.log("CONSOLE ERRORS:", (owner.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ13 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
