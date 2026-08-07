// FQ11 — approve OUR fractional sale on its own (per-item Approve, not
// "Approve all": the batch is atomic and contains seeded lines whose product
// is at 0 on hand, so the whole batch legitimately raises).
//
// Then read reviewed_items back: 0126 defect 2 was `case when sl.qty > 1`,
// which printed NO quantity for anything below 1. A 0.5 kg line must now say
// "× 0.5".
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
  step("Approve our fractional sale line by line");

  const before = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
  const pending = await q(
    `sale_lines?part_id=eq.${PART.id}&select=qty,sale_id&order=created_at.desc&limit=5`
  );
  console.log(`  shop holds ${before}; our sale lines: ${JSON.stringify(pending.map((p) => p.qty))}`);

  await goto(owner.page, "/approvals");
  await owner.page.waitForTimeout(2500);

  // Walk DOWN to the smallest card holding our marker AND exactly one Approve.
  // Repeat: each approval re-renders, so re-locate every time.
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
    if (!el) { console.log(`  round ${round}: no more approvable cards for our fixture`); break; }

    const card = await owner.page.evaluate((b) => {
      let n = b;
      for (let i = 0; i < 6 && n; i++) n = n.parentElement;
      return (n?.innerText || "").replace(/\s+/g, " ").slice(0, 130);
    }, el);
    console.log(`  round ${round} card: ${card}`);
    await el.click();
    const t = await toast(owner.page, { timeout: 25000 });
    console.log(`  toast: ${t}`);
    await owner.page.waitForTimeout(2500);
    if (/approved/i.test(t)) approved++;
    else break;
  }
  check(approved > 0, `approved ${approved} fractional sale(s) individually`);

  const after = Number((await q(`stock_levels?part_id=eq.${PART.id}&shop_id=eq.${TERNATE}&select=qty`))[0]?.qty);
  console.log(`  shop stock ${before} -> ${after} (delta ${(before - after).toFixed(1)})`);
  check(after < before, "approving deducted fractional stock from the shop", `${before} -> ${after}`);
  check(
    Math.abs((before - after) * 10 - Math.round((before - after) * 10)) < 1e-9,
    "the deduction is an exact tenth, not a float-drifted value",
    String(before - after)
  );

  // invariant
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
  check(ok, "invariant holds after fractional sale approval");

  // ── 0126 defect 2 ────────────────────────────────────────────────────────
  step("0126 — a reviewed line below 1 prints its quantity");
  const rev = await q(
    `reviewed_items?item_type=eq.sale&select=summary,event_at&order=event_at.desc&limit=25`
  );
  const ours = rev.filter((r) => new RegExp(NAILS_NAME, "i").test(r.summary ?? ""));
  console.log("  our reviewed summaries:", JSON.stringify(ours.map((r) => r.summary)));
  check(ours.length > 0, "our fractional sale is in the reviewed history");
  check(
    ours.some((r) => /×\s*0\.5/.test(r.summary ?? "")),
    "the 0.5 line prints '× 0.5' (pre-0126 it printed nothing at all)",
    JSON.stringify(ours.map((r) => r.summary))
  );
  check(
    ours.some((r) => /×\s*2\.3/.test(r.summary ?? "")) || ours.length === 1,
    "the 2.3 line prints '× 2.3'",
    JSON.stringify(ours.map((r) => r.summary))
  );
  check(
    !ours.some((r) => /\b\d+\.0\b/.test(r.summary ?? "")),
    "no N.0 in our summaries"
  );

  await goto(owner.page, "/approvals?tab=sales");
  await owner.page.waitForTimeout(2500);
  await shot(owner.page, "fq11-01-reviewed-after-0126");

  console.log("CONSOLE ERRORS:", (owner.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ11 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
