// FQ14 — is the Approval Queue's lazy load actually paginating, or stalled?
// Measures rendered card count + scrollHeight while the sentinel is held in view.
import { launch, session, goto, shot, check, step, summary, dbAuth } from "./qa-lib.mjs";

const { browser } = await launch({ headless: true });
const q = await dbAuth("owner");

try {
  const owner = await session(browser, "owner");
  await goto(owner.page, "/approvals");
  await owner.page.waitForTimeout(3000);

  const snap = () =>
    owner.page.evaluate(() => {
      const sc = [...document.querySelectorAll("*")]
        .filter((e) => e.scrollHeight > e.clientHeight + 100 && /auto|scroll/.test(getComputedStyle(e).overflowY))
        .sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
      const sentinel = [...document.querySelectorAll("div,p,span")].find((e) =>
        /loading more|load more/i.test(e.innerText || "")
      );
      const r = sentinel?.getBoundingClientRect();
      return {
        approveButtons: [...document.querySelectorAll("button")].filter((b) => /^approve$/i.test((b.innerText || "").trim())).length,
        approveAll: [...document.querySelectorAll("button")].filter((b) => /approve all/i.test(b.innerText || "")).length,
        scrollHeight: sc?.scrollHeight ?? 0,
        scrollTop: Math.round(sc?.scrollTop ?? 0),
        clientHeight: sc?.clientHeight ?? 0,
        sentinelText: (sentinel?.innerText || "").trim().slice(0, 40),
        sentinelTop: r ? Math.round(r.top) : null,
        sentinelInViewport: r ? r.top < (window.innerHeight || 900) && r.bottom > 0 : false,
      };
    });

  step("Does holding the sentinel in view load more?");
  const first = await snap();
  console.log("  t0:", JSON.stringify(first));

  for (let i = 0; i < 12; i++) {
    await owner.page.evaluate(() => {
      const s = [...document.querySelectorAll("div,p,span")].find((e) =>
        /loading more|load more/i.test(e.innerText || "")
      );
      if (s) s.scrollIntoView({ block: "center" });
    });
    await owner.page.waitForTimeout(1200);
    if (i % 3 === 2) console.log(`  t${i + 1}:`, JSON.stringify(await snap()));
  }
  const last = await snap();

  check(
    last.approveAll > first.approveAll || last.scrollHeight > first.scrollHeight,
    "the queue loaded MORE batches while the sentinel was held in view",
    `batches ${first.approveAll} -> ${last.approveAll}, height ${first.scrollHeight} -> ${last.scrollHeight}`
  );
  check(
    last.sentinelInViewport,
    "the sentinel really was in the viewport (so the observer should have fired)",
    JSON.stringify({ top: last.sentinelTop, inView: last.sentinelInViewport })
  );

  const pendingBatches = await q(
    `submission_batches?select=id&status=eq.pending`
  ).catch(() => []);
  console.log(`  pending batches in DB: ${pendingBatches.length}, rendered: ${last.approveAll}`);
  check(
    last.approveAll >= Math.min(pendingBatches.length, 25),
    "a useful number of batches is reachable",
    `${last.approveAll} of ${pendingBatches.length}`
  );

  await shot(owner.page, "fq14-01-lazyload-bottom");
  console.log("CONSOLE ERRORS:", (owner.errors ?? []).slice(0, 8));
} catch (e) {
  console.error("\nFQ14 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
