/**
 * IA reorg — nothing 404s, everything lands where it moved.
 *
 * Three routes moved (supplier directory, payables, per-shop reports) and each
 * left a redirect stub, same pattern as /delivery-requests. A reorg that kills
 * bookmarks and notification links is a regression wearing a new sidebar.
 *
 * Goes over HTTP — skipped by `npm test` unless --with-http. Fingerprints the
 * sign-in page first: port 3000 is not necessarily this app, and next dev
 * moves ports silently (see CLAUDE.md).
 *
 * Run: npm run dev  ·  TEST_BASE_URL=http://localhost:3001 node scripts/test-ia-redirects.mjs
 */
import { owner, SB_URL, check, section, summary } from "./_harness.mjs";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const ref = new URL(SB_URL).hostname.split(".")[0];
const { data: { session } } = await owner.auth.getSession();
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;

/**
 * Where does this path send the browser?
 *
 * NOT a 3xx assertion. Next 16 serves a server-component redirect() to a plain
 * document GET as a **200 whose body carries
 * `<meta id="__next-page-redirect" http-equiv="refresh" content="1;url=…">`**
 * — the AGENTS.md warning made concrete. The pre-existing /delivery-requests
 * stub (which works in every browser) does exactly this. So the honest check
 * is "what URL does the response send you to", by either mechanism.
 */
async function redirectTarget(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  const loc = res.headers.get("location");
  if (loc) return { status: res.status, target: loc };
  const body = await res.text();
  const m = body.match(/__next-page-redirect[^>]*content="\d+;url=([^"]+)"/);
  return { status: res.status, target: m ? m[1].replace(/&amp;/g, "&") : "" };
}
async function getHtml(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie } });
  return { status: res.status, html: await res.text() };
}

{
  let html;
  try {
    html = await (await fetch(`${BASE}/login`, { redirect: "manual" })).text();
  } catch {
    console.error(`\nCannot reach ${BASE} — start it with \`npm run dev\` first.\n`);
    process.exit(2);
  }
  if (!html.includes("Inventory &amp; Approvals")) {
    console.error(`\n${BASE} is NOT Jerry's Marine — point TEST_BASE_URL at the right port.\n`);
    process.exit(2);
  }
}

section("Old routes redirect — bookmarks and notification links survive");
{
  const cases = [
    ["/master-inventory/suppliers", "/suppliers?tab=directory"],
    ["/suppliers/payables", "/suppliers?tab=payables"],
    ["/shops/reports", "/reports?tab=shops"],
    ["/delivery-requests", "/deliveries?tab=requests"],
    // Bulk Add retired by 0048; points straight at receiving's final home.
    ["/master-inventory/bulk-add", "/suppliers?tab=receiving"],
    // Receiving moved to Suppliers — it's a supplier transaction.
    ["/master-inventory/receiving", "/suppliers?tab=receiving"],
  ];
  for (const [from, to] of cases) {
    const r = await redirectTarget(from);
    check(`${from} → ${to}`, r.target.includes(to), `status ${r.status}, target "${r.target}"`);
  }

  // The receiving stub is a next.config redirect, so unlike the page-level
  // stubs it returns a REAL 307 — assert the status, not the render.
  {
    const res = await fetch(`${BASE}/master-inventory/receiving`, {
      headers: { cookie },
      redirect: "manual",
    });
    check("/master-inventory/receiving returns a real 307", res.status === 307, `status ${res.status}`);
  }

  // The receiving-detail deep-link survives the move: ?view=<id> passes through.
  {
    const r = await redirectTarget("/master-inventory/receiving?view=abc-123");
    check(
      "receiving ?view= param passes through the redirect",
      r.target.includes("tab=receiving") && r.target.includes("view=abc-123"),
      r.target
    );
  }

  // The stub carries the query along — a saved per-shop link still lands on
  // the same branch's numbers.
  const r = await redirectTarget("/shops/reports?shop=abc123&from=2026-07-01");
  check(
    "/shops/reports keeps its query params through the redirect",
    r.target.includes("shop=abc123") && r.target.includes("from=2026-07-01"),
    r.target
  );
}

section("The new homes render");
{
  const dir = await getHtml("/suppliers?tab=directory");
  check("directory tab renders", dir.status === 200 && dir.html.includes("Directory"));
  const pay = await getHtml("/suppliers?tab=payables");
  check("payables tab renders", pay.status === 200 && pay.html.includes("Payables"));
  const cmp = await getHtml("/suppliers?tab=comparison");
  check("comparison tab renders", cmp.status === 200 && cmp.html.includes("Price Comparison"));
  const rcv = await getHtml("/suppliers?tab=receiving");
  check("receiving tab renders", rcv.status === 200 && rcv.html.includes("New Receiving"));
  const shops = await getHtml("/reports?tab=shops");
  check("per-shop tab renders under /reports", shops.status === 200 && shops.html.includes("Per-Shop Profitability"));
  const pnl = await getHtml("/reports?tab=pnl");
  check("P&L tab still renders", pnl.status === 200 && pnl.html.includes("Net income"));

  // Sidebar order: Suppliers heads INVENTORY, before Master Inventory.
  const iSup = shops.html.indexOf(">Suppliers<");
  const iMaster = shops.html.indexOf(">Master Inventory<");
  const iDeliv = shops.html.indexOf(">Deliveries &amp; Returns<");
  check(
    "sidebar reads like the flow: Suppliers → Master Inventory → Deliveries",
    iSup > -1 && iMaster > -1 && iDeliv > -1 && iSup < iMaster && iMaster < iDeliv,
    `positions: ${iSup}, ${iMaster}, ${iDeliv}`
  );
}

summary();
