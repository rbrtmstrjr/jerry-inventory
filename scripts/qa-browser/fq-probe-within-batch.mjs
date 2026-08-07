// Are the individual sale cards INSIDE each batch in date order?
import { launch, session, goto, shot } from "./qa-lib.mjs";

const { browser } = await launch({ headless: true });
try {
  const owner = await session(browser, "owner");
  await goto(owner.page, "/approvals");
  await owner.page.waitForTimeout(3000);

  const batches = await owner.page.evaluate(() =>
    [...document.querySelectorAll("section")]
      .filter((s) => /submitted/i.test(s.innerText || ""))
      .slice(0, 8)
      .map((s) => {
        const head = (s.innerText || "").split("\n").slice(0, 2).join(" | ");
        // every timestamp printed inside this batch, in DOM order
        const stamps = (s.innerText || "")
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^[A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} (AM|PM)$/.test(l));
        return { head, stamps };
      })
  );

  let anyBad = false;
  for (const b of batches) {
    const ts = b.stamps.map((s) => Date.parse(s.replace(",", "") + " 2026"));
    const bad = [];
    for (let i = 1; i < ts.length; i++) {
      if (Number.isFinite(ts[i]) && Number.isFinite(ts[i - 1]) && ts[i] > ts[i - 1]) {
        bad.push(`${b.stamps[i - 1]} -> ${b.stamps[i]}`);
      }
    }
    if (bad.length) anyBad = true;
    console.log(`\n${b.head}`);
    console.log(`  ${b.stamps.length} timestamps: ${b.stamps.join("  ·  ")}`);
    if (bad.length) console.log(`  OUT OF ORDER: ${bad.join(" | ")}`);
    else console.log("  order: OK (descending)");
  }
  console.log(`\nany batch out of order: ${anyBad}`);
  await shot(owner.page, "fq-within-batch");
} finally {
  await browser.close();
}
