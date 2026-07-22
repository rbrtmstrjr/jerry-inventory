/**
 * Business identity actually reaches the paper.
 *
 * The DB half is test-settings.mjs. This is the half that matters to a
 * customer: it fetches the real server-rendered documents and asserts the
 * business name, address, contact, TIN and footer are IN THE HTML.
 *
 * The regression it exists for: `settings` is owner-only, and five of the six
 * documents read it directly. A SHOP printing a receipt got null and fell back
 * to a hardcoded name with no address and no footer — while the OWNER's reprint
 * of the very same sale rendered perfectly. That is why every receipt assertion
 * below runs twice, once per role, and why the two are compared to each other
 * rather than each just being checked for "not blank".
 *
 * Goes over HTTP, so it needs `npm run dev` on :3000 and is skipped by
 * `npm test` unless you pass --with-http.
 *
 * Run: npm run dev   (in another terminal)
 *      node scripts/test-settings-documents.mjs
 */
import {
  owner, admin, SB_URL, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";
const ref = new URL(SB_URL).hostname.split(".")[0];

function cookieFor(session) {
  return `sb-${ref}-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}
async function get(path, cookie) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  return { status: res.status, html: await res.text() };
}

// Reachable AND actually this app.
//
// Port 3000 on a dev machine is not necessarily Jerry's Marine — another
// project's dev server answering here produced 45 failures that all looked like
// broken code, when the real answer was "that is a different application".
// `next dev` also silently moves to 3001/3002 when 3000 is taken, so the
// default is wrong more often than it is right. Fingerprint before asserting.
{
  let html;
  try {
    html = await (await fetch(`${BASE}/login`, { redirect: "manual" })).text();
  } catch {
    console.error(`\nCannot reach ${BASE} — start it with \`npm run dev\` first.\n`);
    process.exit(2);
  }
  if (!html.includes("Inventory &amp; Approvals")) {
    console.error(
      `\n${BASE} answered, but it is NOT Gerwin Trading — its sign-in page is a ` +
        `different app.\nNext moves to another port when 3000 is taken; point this ` +
        `at the right one:\n  TEST_BASE_URL=http://localhost:3001 node scripts/test-settings-documents.mjs\n`
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Live settings, captured and restored however we exit. This suite writes a
// marker business name; leaving it behind would put "ZZ-TEST" on real receipts.
// ---------------------------------------------------------------------------
const COLS = "business_name, address, phone, business_email, business_tin, receipt_footer";
const { data: original, error: readErr } = await owner
  .from("settings").select(COLS).eq("id", 1).single();
if (readErr) {
  console.error(`Could not read settings — is 0043 applied? ${readErr.message}`);
  process.exit(1);
}

// Refuse a poisoned baseline.
//
// If a previous run died and left "ZZ-TEST" in the row, capturing it as
// `original` means restoring it faithfully at the end and reporting success —
// the pollution becomes permanent and every future run certifies it as correct.
// A restore is only meaningful if what it captured was real.
if (Object.values(original).some((v) => typeof v === "string" && v.includes("ZZ-TEST"))) {
  console.error(
    `\nRefusing to run: the live settings row already contains test data ` +
      `(${original.business_name}).\nA previous run left it behind. Restore the real ` +
      `business identity first — otherwise this suite would capture the junk as the ` +
      `"original" and put it back.\n`
  );
  process.exit(1);
}

let restored = false;
async function restore() {
  if (restored) return;
  restored = true;
  await admin.from("settings").update(original).eq("id", 1);
}

// The real guarantee is the try/finally around the whole suite below.
//
// `process.on("exit")` CANNOT be the safety net: an exit handler may not await,
// so an async restore never lands. This is not theoretical — the first run of
// this suite crashed on a bad fixture and left "ZZ-TEST Marine" as the live
// business name, which is exactly the accident the capture/restore exists to
// prevent. These handlers stay only as a best-effort for SIGINT; the finally is
// what actually holds.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void restore().then(() => process.exit(130));
  });
}

// No apostrophes or ampersands: they'd be HTML-escaped and the assertion would
// fail on the encoding rather than on the thing under test.
const MARK = {
  business_name: `ZZ-TEST Marine ${RUN}`,
  address: `ZZ-TEST Wharf Road Cebu ${RUN}`,
  phone: `0917-555-${RUN.slice(-4)}`,
  business_email: `zz-${RUN.toLowerCase()}@test.local`,
  business_tin: "123-456-789-000",
  receipt_footer: `ZZ-TEST Salamat po ${RUN}`,
};
await admin.from("settings").update(MARK).eq("id", 1);

// Everything from here runs inside try/finally: the live settings row MUST go
// back whatever happens.
try {

const ownerCookie = cookieFor((await owner.auth.getSession()).data.session);

// ── fixtures: a real sale, delivery, warranty and count ─────────────────────
// Every RPC's error is checked on the spot. Ignoring them meant a fixture
// failing here surfaced 20 lines later as "cannot read properties of null",
// which said nothing about what actually went wrong.
const shop = await provisionShop("Docs");
const emp = shop.client;
const shopCookie = cookieFor((await emp.auth.getSession()).data.session);

const part = await seedPart({ label: "Doc Part", cost: 1000, price: 2500 });
const model = await seedEngineModel({ brand: "ZZ-TEST", model: `D${RUN}` });
await receive({ parts: [{ part_id: part.id, qty: 5, unit_cost_centavos: 1000 }] });
await receive({
  engines: [{
    serial_number: `ZZ-DOC-${RUN}`, engine_model_id: model.id,
    condition: "brand_new", cost_centavos: 800000, price_centavos: 990000,
    warranty_months: 12,
  }],
});
const { data: eng } = await owner
  .from("engines").select("id").eq("serial_number", `ZZ-DOC-${RUN}`).single();

const deliveryId = await deliverAndConfirm(shop, {
  parts: [{ part_id: part.id, qty: 4 }],
  engine_ids: [eng.id],
});

const { data: saleId, error: sErr } = await emp.rpc("fn_record_sale", {
  p_customer: { name: `ZZ-TEST Buyer ${RUN}`, phone: "0917-000-1111" },
  p_part_lines: [{ part_id: part.id, qty: 2, unit_price_centavos: 2500 }],
});
check("fixture: part sale recorded", !sErr && !!saleId, sErr?.message);

const { data: engSaleId, error: eErr } = await emp.rpc("fn_record_sale", {
  p_customer: { name: `ZZ-TEST Engine Buyer ${RUN}`, phone: "0917-000-2222" },
  p_engine_lines: [{ engine_id: eng.id, agreed_price_centavos: 990000 }],
});
check("fixture: engine sale recorded", !eErr && !!engSaleId, eErr?.message);

// fn_submit_shop_batch hands back the batch id — no need to go looking for it.
const { data: submitted, error: subErr } = await emp.rpc("fn_submit_shop_batch");
check("fixture: batch submitted", !subErr && !!submitted?.batch_id, subErr?.message);

const { error: apprErr } = await owner.rpc("fn_approve_batch", {
  p_batch_id: submitted.batch_id,
});
check("fixture: batch approved (stock deducts, warranty created)", !apprErr, apprErr?.message);

const { data: warranty, error: wErr } = await owner
  .from("warranties").select("id").eq("sale_id", engSaleId).single();
check("fixture: warranty exists for the engine sale", !wErr && !!warranty, wErr?.message);

const { data: snapshotId, error: snapErr } = await owner.rpc("fn_create_count_snapshot", {
  p_shop_id: shop.id, p_note: `ZZ-TEST doc ${RUN}`,
});
check("fixture: count snapshot created", !snapErr && !!snapshotId, snapErr?.message);

/** Every identity field that belongs on a full letterhead. */
function assertsIdentity(html, label, { footer = false, tin = false } = {}) {
  check(`${label}: business name`, html.includes(MARK.business_name));
  check(`${label}: address`, html.includes(MARK.address));
  check(`${label}: contact number`, html.includes(MARK.phone));
  if (tin) check(`${label}: TIN`, html.includes(MARK.business_tin));
  if (footer) check(`${label}: receipt footer`, html.includes(MARK.receipt_footer));
}

// ── 1. The receipt — the document this whole migration is about ─────────────
section("Sale receipt (owner AND shop)");
{
  const o = await get(`/receipt/${saleId}`, ownerCookie);
  check("owner can open the receipt", o.status === 200, String(o.status));
  assertsIdentity(o.html, "owner receipt", { footer: true, tin: true });

  const s = await get(`/receipt/${saleId}`, shopCookie);
  check("shop can open the receipt", s.status === 200, String(s.status));
  // The regression, stated directly. Before 0043 every one of these failed
  // while the owner's copy above passed.
  assertsIdentity(s.html, "SHOP receipt", { footer: true, tin: true });
  check(
    "shop receipt does NOT fall back to a hardcoded name",
    !s.html.includes(">Gerwin Trading<"),
    "hardcoded fallback rendered"
  );
  // 58mm thermal layout: the route-scoped @page size is the fingerprint.
  check("receipt is a 58mm thermal layout (owner + shop copies)",
    o.html.includes("58mm") && s.html.includes("58mm"));
  // monochrome-safe: the receipt body renders black-on-white with dashed rules,
  // no logo tile / colored badge (the marker comment rides in the scoped CSS).
  check("receipt carries the thermal marker + dashed rules",
    o.html.includes("thermal-receipt-58mm") && o.html.includes("thermal-58"));
}

// ── 2. Warranty certificate — same paper from both sides ───────────────────
section("Warranty certificate (owner AND shop)");
{
  const o = await get(`/warranties/${warranty.id}/certificate`, ownerCookie);
  check("owner can open the certificate", o.status === 200, String(o.status));
  assertsIdentity(o.html, "owner certificate");

  const s = await get(`/shop/warranties/${warranty.id}/certificate`, shopCookie);
  check("shop can open its own certificate", s.status === 200, String(s.status));
  assertsIdentity(s.html, "SHOP certificate");
}

// ── 3. The owner-only documents ────────────────────────────────────────────
section("Delivery note, count sheet, purchase list");
{
  const note = await get(`/deliveries/${deliveryId}/note`, ownerCookie);
  check("delivery note renders", note.status === 200, String(note.status));
  assertsIdentity(note.html, "delivery note");
  // Leakage guard: the receipt's thermal @page must NOT reach any other doc.
  check("delivery note is NOT thermal — full-page layout unchanged",
    !note.html.includes("58mm"));

  // The count sheet had NO letterhead at all before this change — it gets
  // walked round a shop, initialled and filed, so whose sheet it is matters.
  const sheet = await get(`/counts/${snapshotId}/sheet`, ownerCookie);
  check("count sheet renders", sheet.status === 200, String(sheet.status));
  check("count sheet: business name (it had none before)", sheet.html.includes(MARK.business_name));
  check("count sheet: address", sheet.html.includes(MARK.address));

  const list = await get("/stock-alerts/purchase-list", ownerCookie);
  check("purchase list renders", list.status === 200, String(list.status));
  assertsIdentity(list.html, "purchase list");

  check("count sheet + purchase list stay full-page (no 58mm leak)",
    !sheet.html.includes("58mm") && !list.html.includes("58mm"));
}

// ── 4. Payslip — read-only against existing payroll ────────────────────────
section("Payslip");
{
  // Deliberately does NOT create a pay period: fn_create_pay_period drafts an
  // entry for EVERY active staff member, so on a live database that would reach
  // into real payroll to prove a letterhead. Use an existing entry if there is
  // one; say so plainly if there isn't.
  const { data: entry } = await owner
    .from("payroll_entries").select("id").limit(1).maybeSingle();

  if (!entry) {
    console.log("  ⊘ no payroll entries on this database — payslip letterhead not exercised");
  } else {
    const p = await get(`/payroll/payslip/${entry.id}`, ownerCookie);
    check("payslip renders", p.status === 200, String(p.status));
    assertsIdentity(p.html, "payslip");
  }
}

// ── 5. The settings shell itself ───────────────────────────────────────────
section("Settings sections + ?tab= deep-links");
{
  for (const tab of ["business", "account", "alerts", "payroll", "notifications", "system"]) {
    const r = await get(`/settings?tab=${tab}`, ownerCookie);
    check(`?tab=${tab} renders`, r.status === 200, String(r.status));
  }

  const biz = await get("/settings?tab=business", ownerCookie);
  check("Business section shows the saved identity", biz.html.includes(MARK.business_name));

  const sys = await get("/settings?tab=system", ownerCookie);
  check("System section lists the warranty job", sys.html.includes("warranty-expiry-daily"));
  check("System section lists the supplier job", sys.html.includes("supplier-overdue-daily"));

  // No secret may ever reach the page. Assert against the REAL values from the
  // environment rather than a pattern, so this cannot pass by guessing wrong.
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const { data: env } = await import("node:fs").then(async (fs) => {
    const raw = fs.readFileSync(".env.local", "utf8");
    const get = (k) => raw.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
    return { data: { svc: svc || get("SUPABASE_SERVICE_ROLE_KEY"), anon: anon || get("NEXT_PUBLIC_SUPABASE_ANON_KEY") } };
  });
  check(
    "System section never renders the service role key",
    env.svc.length > 0 && !sys.html.includes(env.svc),
    "SERVICE ROLE KEY FOUND IN HTML"
  );
  check("System section renders no job command", !sys.html.includes("fn_check_warranty_expiry"));

  const emp404 = await get("/settings?tab=system", shopCookie);
  check("employee is redirected away from settings", emp404.status === 307 || emp404.status === 302,
    String(emp404.status));
}

} finally {
  // The one guarantee that matters: the live business identity goes back even
  // if an assertion threw, a fixture failed, or the dev server died mid-run.
  await restore();
  const { data: back } = await owner
    .from("settings").select("business_name").eq("id", 1).single();
  check(
    "live business identity restored",
    back?.business_name === original.business_name,
    `left as: ${back?.business_name}`
  );
  await cleanup();
  summary();
}
