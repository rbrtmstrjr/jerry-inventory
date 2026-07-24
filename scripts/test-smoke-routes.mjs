/**
 * Full-capacity render smoke test: hit EVERY route as the correct role and
 * confirm it renders (200) or redirects as designed — never 500s/crashes.
 * Complements the logic suites: they prove correctness, this proves the whole
 * app loads. HTTP — needs `npm run dev`; skipped by `npm test` unless --with-http.
 */
import { owner, SB_URL, provisionShop, cleanup } from "./_harness.mjs";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const ref = new URL(SB_URL).hostname.split(".")[0];
const cookieFor = (s) => `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(s)).toString("base64url")}`;

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => { ok ? pass++ : fail++; console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`); };

{
  let html;
  try { html = await (await fetch(`${BASE}/login`, { redirect: "manual" })).text(); }
  catch { console.error(`\nCannot reach ${BASE} — run \`npm run dev\` first.\n`); process.exit(2); }
  if (!html.includes("Inventory &amp; Approvals")) {
    console.error(`\n${BASE} is not Gerwin Trading — set TEST_BASE_URL to the right port.\n`); process.exit(2);
  }
}

const ownerCookie = cookieFor((await owner.auth.getSession()).data.session);
async function hit(path, cookie) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  return r.status;
}
// OK = renders (200) or an intentional redirect (307/308). NOT ok = 500 (crash) or 404 (unless expected).
const ok = (s) => s === 200 || s === 307 || s === 308;

// real ids for dynamic routes
const q1 = async (t, c = "id", extra = (x) => x) =>
  ((await extra(owner.from(t).select(c)).limit(1).maybeSingle()).data ?? {})[c];
const ids = {
  sale: await q1("sales"),
  delivery: await q1("deliveries"),
  count: await q1("count_snapshots"),
  warranty: await q1("warranties"),
  part: await q1("parts", "id", (x) => x.is("deleted_at", null)),
  shop: await q1("shops", "id", (x) => x.is("deleted_at", null)),
};

console.log("OWNER routes (static + tabs):");
for (const p of [
  "/dashboard",
  "/reports", "/reports?tab=pnl", "/reports?tab=shops",
  "/suppliers", "/suppliers?tab=receiving", "/suppliers?tab=payables",
  "/master-inventory", "/master-inventory/labels",
  "/deliveries", "/deliveries?tab=return", "/deliveries?tab=transit", "/deliveries?tab=requests",
  "/stock-alerts",
  "/counts",
  "/movements", "/movements?tab=ledger", "/movements?tab=engines",
  "/approvals", "/receivables", "/warranties",
  "/shops",
  "/expenses", "/expenses/categories", "/expenses/reports",
  "/settings", "/settings?tab=account", "/settings?tab=alerts",
  "/settings?tab=notifications", "/settings?tab=system",
]) { const s = await hit(p, ownerCookie); check(p, ok(s), `status ${s}`); }

console.log("\nOWNER dynamic + print documents:");
const dyn = [
  ["/counts/" + ids.count, ids.count],
  ["/counts/" + ids.count + "/sheet", ids.count],
  ["/deliveries/" + ids.delivery + "/note", ids.delivery],
  ["/warranties/" + ids.warranty + "/certificate", ids.warranty],
  ["/receipt/" + ids.sale, ids.sale],
  ["/shops/" + ids.shop + "/stock", ids.shop],
  ["/stock-alerts/purchase-list", true],
  ["/movements/stock-card/print?part=" + ids.part + "&shop=master", ids.part],
];
for (const [p, id] of dyn) {
  if (!id) { check(p, true, "(no id in data — skipped)"); continue; }
  const s = await hit(p, ownerCookie); check(p, ok(s), `status ${s}`);
}

// Next 16 serves a server redirect() as 200 + meta-refresh (not 3xx); targets are
// validated in test-ia-redirects.mjs. Here we only confirm no crash/404.
console.log("\nRedirect stubs (old bookmarks must not 404/500):");
for (const p of [
  "/master-inventory/suppliers", "/suppliers/payables", "/shops/reports", "/delivery-requests",
  "/master-inventory/bulk-add", "/master-inventory/receiving",
]) {
  const s = await hit(p, ownerCookie); check(p, ok(s), `status ${s}`);
}

console.log("\nSHOP routes (as a real shop login):");
const shop = await provisionShop("Smoke");
const shopCookie = cookieFor((await shop.client.auth.getSession()).data.session);
for (const p of [
  "/shop", "/shop/deliveries", "/shop/low-stock", "/shop/record-sale",
  "/shop/record-loss", "/shop/receivables", "/shop/warranties", "/shop/submissions",
]) { const s = await hit(p, shopCookie); check(p, ok(s), `status ${s}`); }

console.log("\nAccess control (shop must NOT reach owner pages):");
for (const p of ["/dashboard", "/reports", "/settings", "/movements", "/suppliers"]) {
  const s = await hit(p, shopCookie); check(`shop→${p} redirected`, s === 307 || s === 302, `status ${s}`);
}

console.log("\nAuth pages (unauthenticated):");
for (const p of ["/login", "/auth/reset"]) {
  const r = await fetch(`${BASE}${p}`, { redirect: "manual" });
  check(p, r.status === 200 || r.status === 307, `status ${r.status}`);
}

await cleanup();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
