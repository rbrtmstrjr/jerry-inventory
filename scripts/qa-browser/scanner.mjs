// Barcode-scanner emulation for the counter flow.
//
// A hardware barcode scanner is a KEYBOARD WEDGE: to the browser it is a
// keyboard that types the code's characters extremely fast — often the whole
// code inside 20–80ms, several characters per animation frame — and then sends
// a configurable suffix, usually Enter.
//
// So it can be emulated faithfully with `keyboard.type(code, {delay: 0})`
// followed by `Enter`. What CANNOT be emulated by `locator.fill()` is the thing
// that actually breaks: fill() sets .value in one shot and fires a single input
// event, which hides debounce races and per-keystroke handlers entirely.
//
// The four real failure modes this exists to catch:
//   1. focus      — keystrokes go to document.activeElement; if nothing suitable
//                   is focused the scan is silently lost (bug #11)
//   2. Enter      — the suffix must submit; a click-only field can't be scanned
//   3. debounce   — a debounce shorter than the burst can fire on a PARTIAL code
//   4. clearing   — an uncleared field makes the next scan append and match nothing
import { toast } from "./qa-lib.mjs";

/** Type `code` as a wedge scanner would, then send the suffix. Does NOT focus
 *  anything first — that is the point: it lands wherever focus actually is. */
export async function scan(page, code, { suffix = "Enter", cps = 0 } = {}) {
  await page.keyboard.type(code, { delay: cps });
  if (suffix) await page.keyboard.press(suffix);
}

/** What element would receive a scan right now. */
export async function focusInfo(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return { tag: "BODY", usable: false, desc: "<body> — a scan would be LOST" };
    const tag = a.tagName;
    const usable = tag === "INPUT" || tag === "TEXTAREA" || a.isContentEditable;
    const desc =
      (a.getAttribute("placeholder") || a.getAttribute("aria-label") || a.id || tag) +
      (a.value !== undefined && a.value !== "" ? ` [value="${a.value}"]` : "");
    return { tag, usable, desc };
  });
}

/** Scan and report what happened: the toast, and whether the field self-cleared. */
export async function scanAndObserve(page, code, fieldSelector, opts = {}) {
  const before = await focusInfo(page);
  await scan(page, code, opts);
  const msg = await toast(page, { timeout: opts.timeout ?? 12000 });
  let fieldValue = null;
  try {
    fieldValue = await page.locator(fieldSelector).first().inputValue();
  } catch {
    /* field may be gone */
  }
  return { before, toast: msg, fieldValue, after: await focusInfo(page) };
}
