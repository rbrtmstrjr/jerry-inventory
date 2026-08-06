// What order does the Approval Queue's "All" tab actually render batches in?
import { launch, session, goto, shot } from "./qa-lib.mjs";

const { browser } = await launch({ headless: true });
try {
  const owner = await session(browser, "owner");
  await goto(owner.page, "/approvals");
  await owner.page.waitForTimeout(3000);

  // reveal a good number of batches (5 at a time behind a sentinel)
  for (let i = 0; i < 12; i++) {
    await owner.page.evaluate(() => {
      const m = [...document.querySelectorAll("div,p,span")].filter((e) =>
        /loading more|load more/i.test(e.innerText || "")
      );
      const s = m.sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0];
      if (s) s.scrollIntoView({ block: "center" });
    });
    await owner.page.waitForTimeout(600);
  }

  const heads = await owner.page.evaluate(() =>
    [...document.querySelectorAll("section")]
      .map((s) => {
        const t = (s.innerText || "").split("\n").slice(0, 2).join(" | ");
        return t.trim();
      })
      .filter((t) => /submitted/i.test(t))
  );
  console.log(`rendered batches: ${heads.length}\n`);
  heads.forEach((h, i) => console.log(`${String(i).padStart(2)}. ${h}`));

  // is it monotonically descending by the printed time?
  const times = heads
    .map((h) => (h.match(/submitted\s+(.+?)\s*\|/i) || [])[1] ?? "")
    .map((s) => Date.parse(s.replace(/(\d)(AM|PM)/i, "$1 $2")));
  let bad = 0;
  for (let i = 1; i < times.length; i++) {
    if (Number.isFinite(times[i]) && Number.isFinite(times[i - 1]) && times[i] > times[i - 1]) {
      bad++;
      console.log(`  OUT OF ORDER at ${i}: ${heads[i - 1]}  ->  ${heads[i]}`);
    }
  }
  console.log(`\nout-of-order adjacent pairs: ${bad}`);
  await shot(owner.page, "fq-approval-order");
} finally {
  await browser.close();
}
