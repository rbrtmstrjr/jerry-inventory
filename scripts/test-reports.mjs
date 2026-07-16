/**
 * Reports render server-side from real approved data.
 *
 * The only suite that goes over HTTP: it forges the owner's auth cookie and
 * fetches the actual server-rendered pages, so it needs `npm run dev` on :3000.
 * `npm test` skips it unless you pass --with-http.
 *
 * Provisions its own two shops. Every money assertion is scoped with
 * `?shop=<temp id>` — an unscoped total would mix in the real branches' live
 * sales and could never be asserted exactly.
 *
 * Run: npm run dev   (in another terminal)
 *      node scripts/test-reports.mjs
 */
import {
  owner, SB_URL, RUN, P, check, section, summary,
  provisionShop, seedPart, seedEngineModel, receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const ref = new URL(SB_URL).hostname.split(".")[0];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());

// The report pages are server components behind the owner gate — we need a real
// session cookie shaped exactly like the browser's.
const { data: { session } } = await owner.auth.getSession();
const cookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: res.status, html: await res.text() };
}

// Fail fast and clearly if the dev server isn't up — otherwise every assertion
// below fails for a reason that has nothing to do with the code under test.
try {
  await fetch(BASE, { redirect: "manual" });
} catch {
  console.error(`\nCannot reach ${BASE} — start it with \`npm run dev\` first.\n`);
  process.exit(2);
}

const A = await provisionShop("Rpt A");
const B = await provisionShop("Rpt B");

section("Setup: stock at both temp branches, sales + loss approved");
const NET_COST = 40000, NET_PRICE = 65000;
const ENG_COST = 8_000_000, ENG_PRICE = 9_900_000;

const part = await seedPart({ label: "Nylon Net", cost: NET_COST, price: NET_PRICE, reorder_level: 10 });
const model = await seedEngineModel({ brand: "RPT", model: "M40D2", hp: 40 });
await receive({
  parts: [{ part_id: part.id, qty: 20, unit_cost_centavos: NET_COST }],
  engines: [{
    serial_number: `RPT-${RUN}`, engine_model_id: model.id, condition: "brand_new",
    cost_centavos: ENG_COST, price_centavos: ENG_PRICE, warranty_months: null,
  }],
});
const { data: engine } = await owner
  .from("engines").select("id").eq("serial_number", `RPT-${RUN}`).single();

await deliverAndConfirm(A, { parts: [{ part_id: part.id, qty: 8 }], engine_ids: [engine.id] });
await deliverAndConfirm(B, { parts: [{ part_id: part.id, qty: 8 }] });

// A: 3 nets + the engine · B: 2 nets · A loss: 1 net nasira
const { data: sale1 } = await A.client.rpc("fn_record_sale", {
  p_customer: { name: `ZZ-TEST Buyer ${RUN}` },
  p_part_lines: [{ part_id: part.id, qty: 3, unit_price_centavos: NET_PRICE }],
  p_engine_lines: [{ engine_id: engine.id, agreed_price_centavos: ENG_PRICE }],
});
const { data: sale2 } = await B.client.rpc("fn_record_sale", {
  p_part_lines: [{ part_id: part.id, qty: 2, unit_price_centavos: NET_PRICE }],
});
const { data: loss1 } = await A.client.rpc("fn_record_loss", {
  p_part_id: part.id, p_qty: 1, p_reason: "nasira", p_note: `ZZ-TEST punit ${RUN}`,
});
// Since 0016 a shop's rows land as `recorded` and are invisible to the owner
// until the shop submits a batch; only then can they be approved. The old
// script approved straight after recording, which stopped working then.
const s1 = await A.client.rpc("fn_submit_shop_batch");
const s2 = await B.client.rpc("fn_submit_shop_batch");
check("both shops submitted their batch", !s1.error && !s2.error,
  s1.error?.message ?? s2.error?.message);

const a1 = await owner.rpc("fn_approve_sale", { p_sale_id: sale1, p_note: null });
const a2 = await owner.rpc("fn_approve_sale", { p_sale_id: sale2, p_note: null });
const a3 = await owner.rpc("fn_approve_loss", { p_loss_id: loss1, p_note: null });
check("all approvals succeeded", !a1.error && !a2.error && !a3.error,
  a1.error?.message ?? a2.error?.message ?? a3.error?.message);

const REV_A = 3 * NET_PRICE + ENG_PRICE; // ₱101,850
const REV_B = 2 * NET_PRICE;             // ₱1,300
const money = (c) => (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 });

section("Report page (server-rendered aggregates):");
{
  const { status, html } = await get(`/reports?from=${today}&to=${today}&shop=${A.id}`);
  check("GET /reports (shop A, today) → 200", status === 200, `got ${status}`);
  check(`shop A revenue ${P(REV_A)} in stat tile`, html.includes(money(REV_A)));
  check("the engine's serial appears", html.includes(`RPT-${RUN}`));
  check(`shrinkage ${P(NET_COST)} present`, html.includes(money(NET_COST)));
  check("top part name in payload", html.includes("ZZ-TEST Nylon Net"));
}
{
  const { status, html } = await get(`/reports?from=${today}&to=${today}&shop=${B.id}`);
  check(
    `shop filter: shop B shows ${P(REV_B)} and NOT shop A's ${P(REV_A)}`,
    status === 200 && html.includes(money(REV_B)) && !html.includes(money(REV_A))
  );
}
{
  const { status, html } = await get(`/reports?from=2020-01-01&to=2020-01-02&shop=${A.id}`);
  check(
    "arbitrary old range → 200 and no revenue",
    status === 200 && !html.includes(money(REV_A))
  );
}

section("Shop reports (profitability):");
{
  // Moved to /reports?tab=shops in the IA reorg; /shops/reports is now a
  // redirect stub (asserted in test-ia-redirects.mjs), so the figures are
  // asserted at the new home.
  const { status, html } = await get(`/reports?tab=shops&from=${today}&to=${today}&shop=${A.id}`);
  check("GET /reports?tab=shops → 200", status === 200, `got ${status}`);
  check(`revenue ${P(REV_A)} shown`, html.includes(money(REV_A)));
  // Revenue − COGS = gross profit, from the frozen cost basis.
  const cogs = 3 * NET_COST + ENG_COST;
  check(`gross profit ${P(REV_A - cogs)} shown`, html.includes(money(REV_A - cogs)));
}

section("Dashboard:");
{
  const { status, html } = await get("/dashboard");
  check("GET /dashboard → 200", status === 200, `got ${status}`);
  // Not shop-filterable, so it mixes in the real branches — assert it renders
  // rather than asserting a total we can't own.
  check("dashboard renders", html.includes("Dashboard") || html.length > 1000);
}

section("Employee cannot reach the owner's reports:");
{
  const { data: { session: empSession } } = await A.client.auth.getSession();
  const empCookie = `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(empSession)).toString("base64url")}`;
  const res = await fetch(`${BASE}/reports`, { headers: { cookie: empCookie }, redirect: "manual" });
  check(
    "GET /reports as employee → redirected away",
    res.status === 307 || res.status === 302,
    `got ${res.status}`
  );
}

section("Cleanup:");
await cleanup();
summary();
