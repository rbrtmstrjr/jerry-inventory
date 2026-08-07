import { launch, login, goto, shot } from "./qa-lib.mjs";
const NAME = process.argv[2];
const { browser, page } = await launch({ headless: true });
try {
  await login(page, "owner");
  for (const tab of ["transit", "delivery", "transfers"]) {
    await goto(page, `/deliveries?tab=${tab}`);
    await page.waitForTimeout(1500);
    const txt = await page.evaluate(() => document.body.innerText);
    const hit = new RegExp(NAME, "i").test(txt);
    const btns = await page.getByRole("button", { name: /resolve/i }).count();
    console.log(`\n=== tab=${tab}  fixture-present=${hit}  resolveButtons=${btns}`);
    if (hit) {
      const idx = txt.search(new RegExp(NAME, "i"));
      console.log("CONTEXT:", JSON.stringify(txt.slice(Math.max(0, idx - 260), idx + 260)));
      await shot(page, `fq-probe-${tab}`);
    }
  }
} finally {
  await browser.close();
}
