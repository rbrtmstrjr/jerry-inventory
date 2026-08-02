// QA driver — Playwright straight from gstack's node_modules.
//
// Replaces the `browse` server for the sweep: that server crashed on roughly
// every other invocation and lost the session, so a 19-step task could never
// run end to end. One process, real input events (Radix listens for those),
// whole task in a single run.
import { chromium } from "file:///C:/Users/rober/.claude/skills/gstack/node_modules/playwright/index.mjs";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

export const APP = "http://localhost:3000";
export const SHOT_DIR =
  "c:/Users/rober/OneDrive/Pictures/project-rondo/jerry-inventory/.gstack/qa-reports/screenshots";

const ENVF = "c:/Users/rober/OneDrive/Pictures/project-rondo/jerry-inventory/.env.local";
function envVal(k) {
  const m = fs.readFileSync(ENVF, "utf8").match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim() : null;
}

export const CREDS = {
  owner: { email: envVal("TEST_OWNER_EMAIL"), pass: envVal("TEST_OWNER_PASSWORD") },
  admin: { email: "gerwinadmin@test.com", pass: "gerwinadmin123" },
  shop: { email: "shop1@gerwin-test.ph", pass: "gerwin123" },
  shop2: { email: "shop2@gerwin-test.ph", pass: "gerwin123" },
};

// ── result recording ─────────────────────────────────────────────────────────
export const results = [];
let current = "";
export function step(name) {
  current = name;
  console.log(`\n── ${name} ──`);
}
export function ok(msg) {
  results.push({ step: current, pass: true, msg });
  console.log(`  PASS  ${msg}`);
}
export function bad(msg) {
  results.push({ step: current, pass: false, msg });
  console.log(`  FAIL  ${msg}`);
}
/** Assert and record in one call. */
export function check(cond, msg, detail = "") {
  (cond ? ok : bad)(msg + (detail && !cond ? ` — got: ${detail}` : ""));
  return cond;
}

export function summary() {
  const f = results.filter((r) => !r.pass);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${results.length} checks · ${results.length - f.length} passed · ${f.length} failed`);
  if (f.length) {
    console.log("\nFAILURES:");
    for (const r of f) console.log(`  · [${r.step}] ${r.msg}`);
  }
  return f.length;
}

// ── browser ──────────────────────────────────────────────────────────────────
export async function launch({ headless = true, viewport } = {}) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({ viewport: viewport ?? { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return { browser, ctx, page, errors };
}

export async function login(page, role, { attempts = 2 } = {}) {
  const { email, pass } = CREDS[role];
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(`${APP}/login`, { waitUntil: "load", timeout: 60000 });
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill(pass);
      await page.locator('button[type="submit"]').click();
      // `next dev` compiles the landing route on demand, and two QA agents share
      // one server — a cold /dashboard or /shops behind contention can take far
      // longer than the 30s default. A refusal ALSO leaves you on /login, so the
      // message is checked after the wait rather than inferred from a timeout.
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 });
      await page.waitForLoadState("load");
      return;
    } catch (e) {
      last = e;
      const err = await page
        .locator('[role="alert"]')
        .allTextContents()
        .then((a) => a.filter(Boolean).join(" | "))
        .catch(() => "");
      if (/wrong email or password|disabled/i.test(err)) {
        throw new Error(`login refused for ${role}: ${err}`);
      }
      await page.waitForTimeout(2000);
    }
  }
  throw last;
}

/** `next dev` compiles on demand, so a cold route can exceed the 30 s default
 *  and a first hit occasionally stalls — retry once before failing the run. */
/** localStorage keys the shop app restores from. A stale `jm-sale-draft-v3`
 *  rehydrates a whole cart INCLUDING the customer name, which makes every
 *  "customer is required" assertion pass for the wrong reason. */
export const SHOP_LS_KEYS = [
  "jm-sale-draft-v3",
  "jm-sale-autoprint",
  "jm-record-sale-view",
  "jm-view-shop-stock",
];

/** A second (third…) signed-in session in its own context, so an ADMIN→SHOP→
 *  ADMIN flow doesn't re-login on every hand-off. Cookies are per-context.
 *  `clearLocalStorage` / `stubPrint` must be installed BEFORE the first
 *  navigation, which is why they live here and not in the task script. */
/** Handy viewports for the mobile sweep (Task 20). */
export const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  iphone14promax: { width: 430, height: 932 },
  iphonese: { width: 375, height: 667 },
  mobile390: { width: 390, height: 844 },
};

export async function session(
  browser,
  role,
  { clearLocalStorage, stubPrint, viewport, isMobile } = {}
) {
  const ctx = await browser.newContext({
    viewport: viewport ?? VIEWPORTS.desktop,
    ...(isMobile
      ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
      : {}),
    // business_date / ph_today() are Philippine time, and date-fns renders in
    // the browser's zone — a UTC context makes "today" wrong near midnight
    timezoneId: "Asia/Manila",
  });
  if (clearLocalStorage) {
    await ctx.addInitScript((keys) => {
      try { keys.forEach((k) => localStorage.removeItem(k)); } catch {}
    }, SHOP_LS_KEYS);
  }
  if (stubPrint) {
    // headless Chromium resolves print() immediately; stub it so the receipt
    // iframe's afterprint fires deterministically and nothing blocks
    await ctx.addInitScript(() => {
      window.__printCalls = 0;
      window.print = () => {
        window.__printCalls++;
        window.dispatchEvent(new Event("afterprint"));
      };
    });
  }
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`[${role}] ${m.text()}`); });
  page.on("pageerror", (e) => errors.push(`[${role}] pageerror: ${e.message}`));
  await login(page, role);
  return { ctx, page, errors, role };
}

export async function goto(page, path) {
  try {
    await page.goto(`${APP}${path}`, { waitUntil: "load", timeout: 60000 });
  } catch {
    await page.waitForTimeout(1500);
    await page.goto(`${APP}${path}`, { waitUntil: "load", timeout: 60000 });
  }
  await page.waitForTimeout(800);
}

/** Radix Select: click the trigger, click the option by its accessible name. */
export async function pickSelect(scope, triggerIndex, optionName) {
  const pg = typeof scope.page === "function" ? scope.page() : scope;
  await scope.locator('[role="combobox"]').nth(triggerIndex).click();
  await pg.waitForTimeout(300);
  await pg.getByRole("option", { name: optionName, exact: true }).first().click();
  await pg.waitForTimeout(300);
}

/** Text of every visible sonner toast. */
async function toastText(page) {
  const all = await page.locator("[data-sonner-toast]").allTextContents();
  return all.join(" | ").trim();
}

/** Wait for a toast whose text differs from `not` (the previously-seen one).
 *  Never remove toast nodes: sonner owns them, and ripping them out makes
 *  React throw "insertBefore … not a child of this node" on its next update. */
export async function toast(page, { not = "", timeout = 6000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const t = await toastText(page);
    if (t && t !== not) return t;
    await page.waitForTimeout(150);
  }
  return "";
}

/** Let sonner dismiss on its own so the next assertion reads a fresh toast. */
export async function clearToasts(page, timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (!(await toastText(page))) return;
    await page.waitForTimeout(250);
  }
}

export async function bodyText(page) {
  return page.evaluate(() => document.body.innerText);
}

/** Write a genuine PNG. The upload field decodes the file and reports W×H, so a
 *  hand-rolled base64 blob silently produces no readout and no saved image. */
export function makePng(path, w = 64, h = 48, rgb = [220, 60, 60]) {
  const zlib = require("node:zlib");
  const crcTable = [...Array(256)].map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.concat(
    [...Array(h)].map(() =>
      Buffer.concat([Buffer.from([0]), Buffer.concat([...Array(w)].map(() => Buffer.from(rgb)))])
    )
  );
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path, png);
  return path;
}

export async function shot(page, name) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });
}

// ── read-only PostgREST probe ────────────────────────────────────────────────
// Verifying persisted state by scraping a table is weak; this reads the rows
// the app actually wrote. READ-ONLY by discipline — no writes here, so it does
// not need scripts/_env-guard (which exists to stop write scripts hitting prod).
const SUPA_URL = envVal("NEXT_PUBLIC_SUPABASE_URL");
const SUPA_ANON = envVal("NEXT_PUBLIC_SUPABASE_ANON_KEY");

export async function dbAuth(role = "admin") {
  if (envVal("SUPABASE_ENV") !== "staging") throw new Error("refusing: SUPABASE_ENV is not staging");
  const { email, pass } = CREDS[role];
  const r = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SUPA_ANON, "content-type": "application/json" },
    body: JSON.stringify({ email, password: pass }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`auth failed: ${JSON.stringify(j).slice(0, 200)}`);
  return async (path) => {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
      headers: { apikey: SUPA_ANON, authorization: `Bearer ${j.access_token}` },
    });
    if (!res.ok) throw new Error(`${path} → ${res.status} ${await res.text()}`);
    return res.json();
  };
}
