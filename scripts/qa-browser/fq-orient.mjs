// Orient: map the Receiving form's controls before writing assertions.
import { launch, login, goto, shot, APP } from "./qa-lib.mjs";

const { browser, page, errors } = await launch({ headless: true });
try {
  await login(page, "owner");
  console.log("logged in ->", page.url());

  await goto(page, "/suppliers?tab=receiving");
  console.log("URL:", page.url());

  // open the New Receiving inline card
  const newBtn = page.getByRole("button", { name: /new receiving/i }).first();
  console.log("New Receiving button visible:", await newBtn.isVisible().catch(() => false));
  await newBtn.click();
  await page.waitForTimeout(1500);

  const dump = await page.evaluate(() => {
    const out = { buttons: [], comboboxes: [], inputs: [], headings: [] };
    document.querySelectorAll("button").forEach((b) => {
      const t = (b.innerText || "").trim().replace(/\s+/g, " ");
      const role = b.getAttribute("role") || "";
      if (role === "combobox") out.comboboxes.push(t.slice(0, 60));
      else if (t) out.buttons.push(t.slice(0, 40));
    });
    document.querySelectorAll("input").forEach((i) => {
      out.inputs.push({
        label: i.getAttribute("aria-label") || i.id || i.placeholder || "?",
        inputMode: i.getAttribute("inputmode") || "",
        type: i.type,
      });
    });
    document.querySelectorAll("h1,h2,h3").forEach((h) => out.headings.push(h.innerText.trim().slice(0, 50)));
    return out;
  });
  console.log("\nHEADINGS:", JSON.stringify(dump.headings));
  console.log("\nCOMBOBOXES:", JSON.stringify(dump.comboboxes, null, 1));
  console.log("\nBUTTONS:", JSON.stringify([...new Set(dump.buttons)]));
  console.log("\nINPUTS:", JSON.stringify(dump.inputs, null, 1));

  await shot(page, "fq-orient-receiving");
  console.log("\nCONSOLE ERRORS:", errors.length ? errors : "none");
} catch (e) {
  console.error("ORIENT FAILED:", e.message);
} finally {
  await browser.close();
}
