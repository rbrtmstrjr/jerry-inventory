// FQ6 — a shop asks for 2.5 kg. Before 0125, delivery_request_lines.qty_requested
// was `int`, so fn_create_delivery_request parsed 2.5 as numeric and then
// INSERTed it into an int column: the shop silently filed a request for 3.
import {
  launch, session, goto, shot, check, step, summary, toast, dbAuth,
} from "./qa-lib.mjs";

const { browser } = await launch({ headless: true });
const q = await dbAuth("owner");
const CUSTOM = `ZZ-QA Tingi ${Date.now().toString(36).slice(-4)}`;

try {
  const shop = await session(browser, "shop", { clearLocalStorage: true });
  await goto(shop.page, "/shop/low-stock");
  await shop.page.waitForTimeout(2500);

  step("0125 — a 2.5 kg request must stay 2.5, not round to 3");
  await shop.page.getByRole("button", { name: "Add product", exact: true }).click();
  await shop.page.waitForTimeout(900);

  const d = await shop.page.evaluate(() => ({
    inputs: [...document.querySelectorAll("input")]
      .map((i) => ({ ph: i.placeholder || "", id: i.id || "", im: i.getAttribute("inputmode") || "" }))
      .filter((i) => !i.ph.startsWith("Search")),
    buttons: [...new Set([...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean))],
  }));
  const customInputs = d.inputs.filter((i) => !i.id.startsWith("qty-part:"));
  console.log("  custom-row inputs:", JSON.stringify(customInputs));
  console.log("  buttons:", JSON.stringify(d.buttons.slice(-4)));

  // The custom row is the pair that is NOT a qty-part:<uuid> box
  const nameBox = shop.page.locator('input:not([id^="qty-part:"])').filter({ hasNot: shop.page.locator("[aria-label='Search low stock']") }).nth(1);
  const all = shop.page.locator('input:not([id^="qty-part:"])');
  const n = await all.count();
  console.log(`  ${n} non-row inputs on the page`);

  // name = the text box with no inputmode; qty = the one with inputmode=decimal
  let nameEl = null, qtyEl = null;
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    const im = await el.getAttribute("inputmode");
    const al = await el.getAttribute("aria-label");
    if (al === "Search low stock") continue;
    if (im === "decimal") qtyEl = el;
    else if (!nameEl) nameEl = el;
  }
  check(!!nameEl && !!qtyEl, "found the custom product name + qty boxes");
  if (!nameEl || !qtyEl) throw new Error("custom row not found");

  await nameEl.fill(CUSTOM);
  await shop.page.waitForTimeout(400);
  await qtyEl.fill("");
  await qtyEl.type("2.5", { delay: 80 });
  const shown = await qtyEl.inputValue();
  check(shown === "2.5", `custom request qty box holds "2.5"`, shown);
  await shot(shop.page, "fq6-01-request-2.5");

  const submit = shop.page.getByRole("button", { name: /^Request \d+ item/i }).last();
  console.log(`  submit label: ${await submit.innerText()}`);
  await submit.click();
  const t = await toast(shop.page, { timeout: 25000 });
  console.log(`  toast: ${t}`);
  await shop.page.waitForTimeout(2000);

  const lines = await q(
    `delivery_request_lines?custom_name=eq.${encodeURIComponent(CUSTOM)}&select=qty_requested,custom_name`
  );
  check(lines.length === 1, "the custom request line was created", `${lines.length} rows`);
  check(
    Math.abs(Number(lines[0]?.qty_requested) - 2.5) < 1e-9,
    "0125 REGRESSION — qty_requested is 2.5, NOT a silently rounded 3",
    String(lines[0]?.qty_requested)
  );

  // and it must READ back as 2.5 on the shop's own My-requests tab
  await goto(shop.page, "/shop/low-stock");
  await shop.page.waitForTimeout(1500);
  await shop.page.getByRole("button", { name: /my requests/i }).click();
  await shop.page.waitForTimeout(1500);
  const txt = await shop.page.evaluate(() => document.body.innerText);
  check(new RegExp(`${CUSTOM}`, "i").test(txt), "the request shows on My requests");
  check(/2\.5/.test(txt) && !/\d\.\d{5,}/.test(txt), "it reads back as 2.5 with no float artifact",
    (txt.match(/2\.5\d*/) || ["none"])[0]);
  await shot(shop.page, "fq6-02-my-requests");

  console.log("CONSOLE ERRORS:", (shop.errors ?? []).slice(0, 5));
} catch (e) {
  console.error("\nFQ6 THREW:", e.message);
} finally {
  const failed = summary();
  await browser.close();
  process.exit(failed ? 1 : 0);
}
