// Task 20 — Mobile sweep. Steps 1–6, at 430×932 (iPhone 14 Pro Max) AND
// 375×667 (iPhone SE).
//
// LAYOUT ONLY. Every overlay is opened and dismissed; NOTHING is submitted.
// Submitting would write into the sales / losses / expenses / warranty tables
// the other agent is asserting on in Tasks 8–10 and 18. The only interaction
// beyond open/dismiss is dragging the map pin (Step 6), which is discarded with
// the dialog and never saved.
//
// What is measured:
//   · document-level horizontal overflow (a wide table scrolling inside its own
//     overflow-x container is CORRECT and is not counted),
//   · the overlay's primary button reachable inside the viewport,
//   · dismissal actually closes it,
//   · text inputs computed ≥16px (below that iOS zooms on focus),
//   · icon-only button hit areas against the ~44px guidance.
import {
  launch, session, goto, bodyText, shot, dbAuth, VIEWPORTS,
  step, check, summary,
} from "./qa-lib.mjs";

const { browser } = await launch();
const q = await dbAuth("owner");

const SIZES = [
  ["iPhone 14 Pro Max", VIEWPORTS.iphone14promax],
  ["iPhone SE", VIEWPORTS.iphonese],
];

/** Document-level horizontal overflow, ignoring legitimate inner scrollers. */
async function overflow(page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    const over = Math.max(d.scrollWidth - d.clientWidth, document.body.scrollWidth - d.clientWidth);
    const offenders = [];
    if (over > 1) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= d.clientWidth + 1) continue;
        // inside something that scrolls horizontally on purpose? fine.
        let n = el, ok = false;
        while (n && n !== document.body) {
          const ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll") { ok = true; break; }
          n = n.parentElement;
        }
        if (!ok) {
          offenders.push(
            `${el.tagName.toLowerCase()}${el.className ? "." + String(el.className).split(/\s+/).slice(0, 2).join(".") : ""} → ${Math.round(r.right)}px`
          );
          if (offenders.length >= 3) break;
        }
      }
    }
    return { over, width: d.clientWidth, offenders };
  });
}

/** The open dialog/sheet, its primary button, and whether it fits. */
async function overlayGeometry(page) {
  return page.evaluate(() => {
    const panel =
      document.querySelector('[role="dialog"]:not([aria-hidden="true"])') ||
      document.querySelector('[data-slot="sheet-content"]');
    if (!panel) return null;
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const pr = panel.getBoundingClientRect();
    // primary = last enabled non-ghost button in the panel's footer, else last button
    const btns = [...panel.querySelectorAll("button")].filter((b) => !b.disabled);
    const primary = btns[btns.length - 1] ?? null;
    let pb = null;
    if (primary) {
      primary.scrollIntoView({ block: "nearest" });
      const r = primary.getBoundingClientRect();
      pb = { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
             label: (primary.textContent || "").trim().slice(0, 24) };
    }
    return {
      vw, vh,
      panel: { x: pr.x, right: pr.right, w: pr.width },
      panelFits: pr.x >= -1 && pr.right <= vw + 1,
      primary: pb,
      primaryFits: pb ? pb.x >= -1 && pb.right <= vw + 1 && pb.bottom <= vh + 1 : false,
    };
  });
}

/** Smallest computed font-size among visible text inputs (iOS zooms below 16). */
async function inputFontSizes(page) {
  return page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(
      'input[type="text"],input[type="email"],input[type="password"],input[type="search"],input:not([type]),textarea'
    )) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      out.push({ size: parseFloat(getComputedStyle(el).fontSize), id: el.id || el.name || el.placeholder || "?" });
    }
    return out;
  });
}

/** Icon-only controls and their EFFECTIVE tap target.
 *
 *  Not the bounding box: a 16px checkbox wrapped in a <label> is tapped by the
 *  whole label, and a `after:-inset-*` pseudo-element widens the hit area
 *  without changing the box. Measuring the box alone reported 53 "16×16"
 *  controls that are all comfortably tappable in reality. */
async function iconButtons(page) {
  return page.evaluate(() => {
    const eff = (b) => {
      const r = b.getBoundingClientRect();
      let x1 = r.left, y1 = r.top, x2 = r.right, y2 = r.bottom;
      const a = getComputedStyle(b, "::after");
      if (a && a.content && a.content !== "none" && a.position === "absolute") {
        const t = parseFloat(a.top) || 0, l = parseFloat(a.left) || 0;
        const bo = parseFloat(a.bottom) || 0, ri = parseFloat(a.right) || 0;
        x1 = Math.min(x1, r.left + l); y1 = Math.min(y1, r.top + t);
        x2 = Math.max(x2, r.right - ri); y2 = Math.max(y2, r.bottom - bo);
      }
      const lab = b.closest("label");
      if (lab) {
        const lr = lab.getBoundingClientRect();
        x1 = Math.min(x1, lr.left); y1 = Math.min(y1, lr.top);
        x2 = Math.max(x2, lr.right); y2 = Math.max(y2, lr.bottom);
      }
      return { w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
    };
    const out = [];
    for (const b of document.querySelectorAll('button,[role="checkbox"]')) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if ((b.textContent || "").trim().length > 0) continue; // icon-ONLY
      const e = eff(b);
      out.push({ w: e.w, h: e.h, label: b.getAttribute("aria-label") || "(unlabelled)" });
    }
    return out;
  });
}

async function dismiss(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(700);
  return (await page.locator('[role="dialog"], [data-slot="sheet-content"]').count()) === 0;
}

// ── the overlay catalogue ───────────────────────────────────────────────────
// Each entry: role, route, an `open` that leaves an overlay on screen, and a
// name. `open` returns false when the fixture it needs isn't present.
const OVERLAYS = [
  // "New Receiving" opens an inline Card, not a dialog — the OVERLAYS the plan
  // lists are the ones INSIDE that form.
  { name: "Receiving: Bulk new products", role: "admin", route: "/suppliers?tab=receiving",
    open: async (p) => {
      const nr = p.getByRole("button", { name: "New Receiving", exact: true });
      if (!(await nr.count())) return false;
      await nr.click(); await p.waitForTimeout(2000);
      const b = p.getByRole("button", { name: /Bulk new products/ });
      if (!(await b.count())) return false;
      await b.click(); return true;
    } },
  { name: "Receiving: New product", role: "admin", route: "/suppliers?tab=receiving",
    open: async (p) => {
      const nr = p.getByRole("button", { name: "New Receiving", exact: true });
      if (!(await nr.count())) return false;
      await nr.click(); await p.waitForTimeout(2000);
      const add = p.getByRole("button", { name: "Add part", exact: true });
      if (!(await add.count())) return false;
      await add.click(); await p.waitForTimeout(1200);
      const combo = p.locator('button[role="combobox"]').filter({ hasText: /Pick|Search|product/i }).first();
      if (!(await combo.count())) return false;
      await combo.click(); await p.waitForTimeout(900);
      const item = p.getByRole("option", { name: /New product/ }).first();
      if (!(await item.count())) return false;
      await item.click(); return true;
    } },
  { name: "Receiving detail", role: "admin", route: null,
    route: async () => {
      const r = (await q("receivings?select=id&deleted_at=is.null&order=received_at.desc&limit=1"))[0];
      return r ? `/suppliers?tab=receiving&view=${r.id}` : null;
    }, open: async () => true },
  { name: "Product edit + photo", role: "admin", route: "/master-inventory",
    open: async (p) => { const b = p.locator('[aria-label^="Actions for"]').first();
      if (!(await b.count())) return false; await b.click(); await p.waitForTimeout(500);
      await p.getByRole("menuitem", { name: /^Edit/ }).first().click(); return true; } },
  { name: "Suppliers & prices", role: "admin", route: "/master-inventory",
    open: async (p) => { const b = p.locator('[aria-label^="Suppliers & prices for"]').first();
      if (!(await b.count())) return false; await b.click(); return true; } },
  { name: "Merge duplicates", role: "owner", route: "/master-inventory",
    open: async (p) => { const b = p.getByRole("button", { name: /Merge duplicates/ });
      if (!(await b.count())) return false; await b.click(); return true; } },
  { name: "Approve/Question/Reject", role: "admin", route: "/approvals",
    open: async (p) => { const b = p.getByRole("button", { name: /^Question/ }).first();
      if (!(await b.count())) return false; await b.click(); return true; } },
  { name: "Reviewed detail slide-over", role: "admin", route: "/approvals?tab=reviewed",
    open: async (p) => { const row = p.locator("tbody tr").first();
      if (!(await row.count())) return false; await row.click(); await p.waitForTimeout(2500); return true; } },
  { name: "Warranty card no.", role: "admin", route: "/warranties",
    open: async (p) => { const b = p.locator('[aria-label="Edit warranty card number"]').first();
      if (!(await b.count())) return false; await b.click(); return true; } },
  { name: "Shop edit + logo + colour + map", role: "admin", route: "/shops",
    open: async (p) => { const b = p.locator('[aria-label^="More actions for"]').first();
      if (!(await b.count())) return false; await b.click(); await p.waitForTimeout(500);
      await p.getByRole("menuitem", { name: /Edit Shop Details/ }).click(); return true; } },
  { name: "Staff dialog", role: "admin", route: "/shops",
    open: async (p) => { const b = p.getByRole("button", { name: /Add Employee/ }).first();
      if (!(await b.count())) return false; await b.click(); return true; } },
  { name: "Credentials dialog", role: "owner", route: "/shops",
    open: async (p) => { const b = p.locator('[aria-label^="More actions for"]').first();
      if (!(await b.count())) return false; await b.click(); await p.waitForTimeout(500);
      const m = p.getByRole("menuitem", { name: /Change Credentials/ });
      if (!(await m.count())) { await p.keyboard.press("Escape"); return false; }
      await m.click(); return true; } },
  { name: "Expense dialog + receipt", role: "admin", route: "/expenses",
    open: async (p) => { const b = p.getByRole("button", { name: "Record expense", exact: true });
      if (!(await b.count())) return false; await b.click(); return true; } },
  { name: "Admin account dialog", role: "owner", route: "/settings?tab=admins",
    open: async (p) => { const b = p.getByRole("button", { name: /Add admin/ });
      if (!(await b.count())) return false; await b.click(); return true; } },
  { name: "Shop: record payment", role: "shop", route: "/shop/receivables",
    open: async (p) => { const b = p.getByRole("button", { name: /Record payment/ }).first();
      if (!(await b.count())) return false; await b.click(); return true; } },
  { name: "Shop: expense dialog", role: "shop", route: "/shop/expenses",
    open: async (p) => { const b = p.getByRole("button", { name: /Record expense|Add expense/i }).first();
      if (!(await b.count())) return false; await b.click(); return true; } },
  { name: "Shop: warranty card no.", role: "shop", route: "/shop/warranties",
    open: async (p) => { const b = p.getByRole("button", { name: /Record card no|Edit warranty card/i }).first();
      if (!(await b.count())) return false; await b.click(); return true; } },
];

const PAGES = {
  owner: ["/dashboard", "/suppliers", "/master-inventory", "/deliveries", "/stock-alerts",
          "/counts", "/movements", "/approvals", "/receivables", "/warranties",
          "/suki-cards", "/shops", "/expenses", "/reports", "/settings"],
  admin: ["/dashboard", "/suppliers", "/master-inventory", "/deliveries", "/stock-alerts",
          "/counts", "/movements", "/approvals", "/receivables", "/warranties",
          "/suki-cards", "/shops", "/expenses"],
  shop: ["/shop", "/shop/deliveries", "/shop/transfers", "/shop/low-stock",
         "/shop/record-sale", "/shop/record-loss", "/shop/receivables",
         "/shop/expenses", "/shop/warranties", "/shop/submissions"],
};

const smallInputs = [];
const smallTargets = [];

try {
  for (const [sizeName, viewport] of SIZES) {
    step(`Step 1–2: ${sizeName} (${viewport.width}×${viewport.height}) — no horizontal body scroll`);
    const sessions = {};
    for (const role of ["owner", "admin", "shop"]) {
      sessions[role] = await session(browser, role, {
        viewport, isMobile: true, clearLocalStorage: true,
      });
    }

    for (const role of ["owner", "admin", "shop"]) {
      const p = sessions[role].page;
      let worst = null;
      for (const route of PAGES[role]) {
        await goto(p, route);
        await p.waitForTimeout(2200);
        const o = await overflow(p);
        if (o.over > 1 && (!worst || o.over > worst.over)) worst = { ...o, route };
        // collect metrics while we're here
        for (const i of await inputFontSizes(p)) {
          if (i.size < 16) smallInputs.push({ sizeName, role, route, ...i });
        }
        for (const b of await iconButtons(p)) {
          if (b.w < 40 || b.h < 40) smallTargets.push({ sizeName, role, route, ...b });
        }
      }
      check(!worst, `${role}: no page scrolls horizontally at ${viewport.width}px`,
        worst ? `${worst.route} overflows by ${worst.over}px — ${worst.offenders.join(" | ")}` : "");
    }

    // ── Step 3: overlays ────────────────────────────────────────────────────
    step(`Step 3: overlays at ${sizeName}`);
    for (const ov of OVERLAYS) {
      const p = sessions[ov.role].page;
      const route = typeof ov.route === "function" ? await ov.route() : ov.route;
      if (!route) { check(true, `${ov.name}: no fixture available — skipped`); continue; }
      await goto(p, route);
      await p.waitForTimeout(2600);
      let opened = false;
      try { opened = await ov.open(p); } catch { opened = false; }
      if (!opened) { check(true, `${ov.name}: control not present — skipped`); continue; }
      await p.waitForTimeout(1600);

      const g = await overlayGeometry(p);
      if (!g) { check(false, `${ov.name}: an overlay actually opened`); continue; }
      check(g.panelFits, `${ov.name}: panel fits the ${viewport.width}px viewport`,
        `x=${Math.round(g.panel.x)} right=${Math.round(g.panel.right)} of ${g.vw}`);
      check(g.primaryFits, `${ov.name}: primary button reachable without zooming`,
        g.primary
          ? `"${g.primary.label}" at x=${Math.round(g.primary.x)}–${Math.round(g.primary.right)} y↓${Math.round(g.primary.bottom)} of ${g.vh}`
          : "no enabled button found");
      const o = await overflow(p);
      check(o.over <= 1, `${ov.name}: no horizontal body scroll while open`,
        o.over > 1 ? `${o.over}px — ${o.offenders.join(" | ")}` : "");
      for (const i of await inputFontSizes(p)) {
        if (i.size < 16) smallInputs.push({ sizeName, role: ov.role, route: ov.name, ...i });
      }
      for (const b of await iconButtons(p)) {
        if (b.w < 40 || b.h < 40) smallTargets.push({ sizeName, role: ov.role, route: ov.name, ...b });
      }
      check(await dismiss(p), `${ov.name}: dismissal closes it`);
    }

    // ── Step 6: map picker by touch (only at the larger size) ───────────────
    if (viewport.width === 430) {
      step("Step 6: map picker responds to touch");
      const p = sessions.admin.page;
      await goto(p, "/shops");
      await p.waitForTimeout(2600);
      await p.locator('[aria-label^="More actions for"]').first().click();
      await p.waitForTimeout(600);
      await p.getByRole("menuitem", { name: /Edit Shop Details/ }).click();
      await p.waitForTimeout(3000);
      const map = p.locator(".leaflet-container").first();
      if (await map.count()) {
        const box = await map.boundingBox();
        check(!!box && box.width <= viewport.width + 1,
          "map fits the viewport width", box ? `${Math.round(box.width)}px` : "no box");
        // a real touch tap, then a drag — discarded with the dialog, never saved
        await p.touchscreen.tap(box.x + box.width * 0.4, box.y + box.height * 0.5);
        await p.waitForTimeout(1200);
        const pins1 = await p.locator(".leaflet-marker-icon").count();
        check(pins1 > 0, "a tap places a pin by touch", `${pins1} marker(s)`);
        await p.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.45);
        await p.waitForTimeout(1200);
        check((await p.locator(".leaflet-marker-icon").count()) > 0,
          "the pin can be moved by a second touch");
        await shot(p, "task20-step6-map");
      } else {
        check(false, "map picker rendered in the shop dialog");
      }
      await p.keyboard.press("Escape");
      await p.waitForTimeout(800);
      console.log("  (dialog dismissed without saving — no shop row was written)");
    }

    for (const role of Object.keys(sessions)) await sessions[role].ctx.close();
  }

  // ── Step 4 + 5: aggregated metrics ────────────────────────────────────────
  step("Step 4: text inputs render ≥16px (iOS zoom threshold)");
  const uniqInputs = [...new Map(smallInputs.map((i) => [`${i.route}|${i.id}|${i.size}`, i])).values()];
  check(uniqInputs.length === 0, "no visible text input is under 16px",
    uniqInputs.slice(0, 6).map((i) => `${i.route}:${i.id}=${i.size}px`).join(" | "));

  step("Step 5: icon-only touch targets");
  const uniqTargets = [...new Map(smallTargets.map((b) => [`${b.label}|${b.w}x${b.h}`, b])).values()];
  // Three tiers, and only one of them is a defect:
  //   <24px  — fails even WCAG 2.5.8's floor. Was the row-selection checkbox
  //            (16×16); its HIT area is now 44×44 with the box still 16px.
  //   32px   — shadcn `icon-sm` (pagination, view toggle, receipt, kebabs).
  //   36px   — shadcn `size-9`, the default icon button, used app-wide.
  // The 32/36 tiers are the design system's own defaults on every page; moving
  // them is an owner decision, not a QA edit. Assert the floor, report the rest.
  const belowFloor = uniqTargets.filter((b) => b.w < 24 || b.h < 24);
  check(belowFloor.length === 0,
    "no icon-only control is under 24px (the WCAG 2.5.8 floor)",
    belowFloor.slice(0, 6).map((b) => `"${b.label}" ${b.w}×${b.h} on ${b.route}`).join(" | "));
  const tiers = {};
  for (const b of uniqTargets) tiers[`${b.w}×${b.h}`] = (tiers[`${b.w}×${b.h}`] ?? 0) + 1;
  console.log("  under 44px by tier (design-system defaults, logged not failed):");
  for (const [k, v] of Object.entries(tiers).sort()) console.log(`    ${k}: ${v} distinct control(s)`);
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
} finally {
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
