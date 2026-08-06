import { launch, session, goto, shot } from "./qa-lib.mjs";
const { browser } = await launch({ headless: true });
try {
  const shop = await session(browser, "shop", { clearLocalStorage: true });
  await goto(shop.page, "/shop/low-stock");
  await shop.page.waitForTimeout(2500);
  const d = await shop.page.evaluate(() => ({
    buttons: [...new Set([...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim().replace(/\s+/g, " ")).filter(Boolean))],
    inputs: [...document.querySelectorAll("input")].map((i) => ({
      ph: i.placeholder || "", al: i.getAttribute("aria-label") || "", id: i.id || "", im: i.getAttribute("inputmode") || "", type: i.type,
    })),
    headings: [...document.querySelectorAll("h1,h2,h3,label")].map((h) => (h.innerText || "").trim()).filter(Boolean).slice(0, 25),
  }));
  console.log("BUTTONS:", JSON.stringify(d.buttons, null, 1));
  console.log("\nINPUTS:", JSON.stringify(d.inputs, null, 1));
  console.log("\nLABELS/HEADINGS:", JSON.stringify(d.headings, null, 1));
  await shot(shop.page, "fq-probe-lowstock");
} finally { await browser.close(); }
