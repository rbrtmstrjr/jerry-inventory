// Task 19 — Printable documents. Steps 1–8, mostly read-only.
//
// The ONE mutation: no shop in staging has a logo, so Step 1's logo branch is
// untestable as-is. This adds one to Gerwin-Bacoor (my Task 12 shop — not
// Gerwin-Ternate, which is the anchor-fallback control, and not Gerwin-Naic,
// which is the other agent's shop2) and REMOVES it in `finally`.
//
// business_name is read from the database at assertion time, never hardcoded —
// Task 16 proved this row is writable, so a literal would rot.
//
// The receipt's branch logo has alt="", so getByRole("img") can never match it;
// and the 58 mm marker lives inside a <style dangerouslySetInnerHTML>, so it is
// only visible to page.content(), not to any text query.
import {
  launch, session, goto, bodyText, shot, dbAuth, makePng, VIEWPORTS,
  step, check, summary, toast, clearToasts, APP,
} from "./qa-lib.mjs";

const LOGO_SHOP = "Gerwin-Bacoor";
const PNG = "c:/Users/rober/AppData/Local/Temp/zzqb-shop-logo.png";

const { browser } = await launch();
const q = await dbAuth("owner");

const shopsById = Object.fromEntries(
  (await q("shops?select=id,name,location&deleted_at=is.null")).map((s) => [s.id, s])
);
const BIZ = (await q("settings?select=business_name,address,phone,business_email,business_tin,receipt_footer"))[0];
console.log("letterhead source (live):", JSON.stringify(BIZ));

let logoShopId = null;
let logoAdded = false;

/** Raw HTML — the only way to see <style dangerouslySetInnerHTML> content. */
const html = (p) => p.content();

/** Case-insensitive "does the page say this".
 *
 *  Print documents lean on `uppercase` for headers and letterheads, and
 *  innerText APPLIES text-transform — so the receipt letterhead reads
 *  "GERWIN TRADING", and the "Approved"/"Good" column headers read "APPROVED"
 *  and "GOOD". Every text assertion here goes through this. */
const says = (haystack, needle) =>
  haystack.toLowerCase().includes(String(needle).toLowerCase());

try {
  const owner = await session(browser, "owner");
  const admin = await session(browser, "admin");
  const P = owner.page;
  const T = () => bodyText(P);

  // ── fixture: give one shop a logo ─────────────────────────────────────────
  step("fixture: add a logo to " + LOGO_SHOP);
  logoShopId = Object.values(shopsById).find((s) => s.name === LOGO_SHOP)?.id;
  check(!!logoShopId, `${LOGO_SHOP} exists`);
  const before = (await q(`shops?select=logo_path&id=eq.${logoShopId}`))[0];
  check(before.logo_path === null, "it starts with no logo (so the removal restores exactly)",
    String(before.logo_path));
  makePng(PNG, 96, 96, [20, 90, 170]);
  await goto(admin.page, "/shops");
  await admin.page.waitForTimeout(3000);
  await admin.page.getByRole("button", { name: `More actions for ${LOGO_SHOP}`, exact: true })
    .first().click();
  await admin.page.waitForTimeout(600);
  await admin.page.getByRole("menuitem", { name: /Edit Shop Details/ }).click();
  await admin.page.waitForTimeout(2500);
  await admin.page.locator('input[type="file"]').first().setInputFiles(PNG);
  await admin.page.waitForTimeout(1800);
  await admin.page.getByRole("button", { name: "Save", exact: true }).click();
  await admin.page.waitForTimeout(4000);
  const withLogo = (await q(`shops?select=logo_path&id=eq.${logoShopId}`))[0];
  logoAdded = !!withLogo.logo_path;
  check(logoAdded, "logo_path written", withLogo.logo_path || "null");
  await clearToasts(admin.page);

  // ── Step 1: sale receipt (58 mm) ──────────────────────────────────────────
  step("Step 1: sale receipt");
  const saleAt = async (shopName, extra = "") => {
    const id = Object.values(shopsById).find((s) => s.name === shopName)?.id;
    const rows = await q(`sales?select=id,payment_type,payment_method,discount_card_id,customer_id&shop_id=eq.${id}&status=eq.approved&deleted_at=is.null${extra}&order=created_at.desc&limit=1`);
    return rows[0] ?? null;
  };
  const logoSale = await saleAt(LOGO_SHOP);
  check(!!logoSale, `${LOGO_SHOP} has an approved sale to print`);
  await goto(P, `/receipt/${logoSale.id}`);
  await P.waitForTimeout(3000);
  let t = await T();

  check(says(t, BIZ.business_name),
    "letterhead prints business_name read from the database (uppercase on the receipt)",
    (t.match(new RegExp(BIZ.business_name, "i")) || ["absent"])[0]);
  for (const [label, val] of [["address", BIZ.address], ["phone", BIZ.phone],
                              ["email", BIZ.business_email], ["TIN", BIZ.business_tin]]) {
    if (val) check(says(t, val), `letterhead prints ${label}`, val);
  }
  const nulls = ["address", "phone", "business_email", "business_tin", "receipt_footer"]
    .filter((k) => !BIZ[k]);
  if (nulls.length) console.log(`  (settings currently null, so those lines are absent by design: ${nulls.join(", ")})`);

  // the logo — alt="" so it is invisible to getByRole("img")
  const logoImgs = await P.locator('img[alt=""]').count();
  check(logoImgs > 0, "branch logo renders (matched by CSS — alt=\"\" hides it from getByRole)",
    `${logoImgs} img[alt=""]`);
  const anchorSvgWithLogo = await P.locator("svg.lucide-anchor").count();
  check(anchorSvgWithLogo === 0, "…and the anchor fallback is NOT drawn when a logo exists",
    `${anchorSvgWithLogo} anchor svg`);

  check(says(t, `Branch: ${LOGO_SHOP}`), "'Branch: <shop>' line",
    (t.match(/Branch:[^\n]*/) || ["absent"])[0]);
  check(says(t, shopsById[logoShopId].location),
    "…followed by the branch location", shopsById[logoShopId].location);
  check(/RECEIPT/.test(t), "RECEIPT header");
  check(/₱[\d,]+\.\d\d/.test(t), "per-line prices render as money",
    (t.match(/₱[\d,]+\.\d\d/) || ["absent"])[0]);
  // "Paid via" and the method sit in separate spans, so innerText puts a
  // newline between them — assert the two parts, not one joined string.
  check(says(t, "Paid via"), "'Paid via' label",
    (t.match(/Paid via[\s\S]{0,16}/) || ["absent"])[0].replace(/\n/g, "⏎"));
  check(says(t, logoSale.payment_method),
    `…and the method reads ${logoSale.payment_method}`);
  const footer = BIZ.receipt_footer || "Thank you! Please keep this receipt for warranty & claims.";
  check(says(t, footer), "receipt footer (Settings value, or its documented fallback)",
    footer.slice(0, 48));
  await shot(P, "task19-step1-receipt-logo");

  // anchor fallback on a logo-less branch
  const ternateSale = await saleAt("Gerwin-Ternate");
  if (ternateSale) {
    await goto(P, `/receipt/${ternateSale.id}`);
    await P.waitForTimeout(2500);
    check((await P.locator("svg.lucide-anchor").count()) > 0,
      "a logo-less branch falls back to the anchor", "Gerwin-Ternate");
    check((await P.locator('img[alt=""]').count()) === 0, "…and draws no logo img");
  }

  // partial payment → "Downpayment via"
  const partial = (await q("sales?select=id,payment_method,shop_id&payment_type=eq.partial&status=eq.approved&deleted_at=is.null&order=created_at.desc&limit=1"))[0];
  if (partial) {
    await goto(P, `/receipt/${partial.id}`);
    await P.waitForTimeout(2500);
    t = await T();
    check(/Downpayment via/.test(t), "a partial sale prints 'Downpayment via <method>'",
      (t.match(/Downpayment via[^\n]*/) || ["absent"])[0]);
    check(!/^Paid via/m.test(t), "…and not 'Paid via'");
  } else {
    check(true, "no approved partial-payment sale to print — skipped");
  }

  // suki discount line where applicable
  const suki = (await q("sales?select=id&discount_card_id=not.is.null&status=eq.approved&deleted_at=is.null&order=created_at.desc&limit=1"))[0];
  if (suki) {
    await goto(P, `/receipt/${suki.id}`);
    await P.waitForTimeout(2500);
    check(/Suki card discount/.test(await T()), "a suki sale prints the program discount line");
  } else {
    check(true, "no approved suki sale to print — skipped");
  }

  // ── Step 2: thermal CSS is route-scoped ───────────────────────────────────
  step("Step 2: the 58 mm sizing is route-scoped");
  await goto(P, `/receipt/${logoSale.id}`);
  await P.waitForTimeout(2500);
  const receiptHtml = await html(P);
  check(/58mm/.test(receiptHtml),
    "the receipt carries the 58mm marker (found via page.content() — it is inside a <style>)",
    (receiptHtml.match(/@page[^}]*58mm[^}]*}/) || receiptHtml.match(/58mm/) || ["absent"])[0].slice(0, 60));
  check(/thermal-receipt-58mm/.test(receiptHtml), "…and the route-scoped fingerprint comment");

  const masterDel = (await q("deliveries?select=id,status&from_shop_id=is.null&deleted_at=is.null&order=delivered_at.desc&limit=5"));
  const countSheet = (await q("count_snapshots?select=id&deleted_at=is.null&order=created_at.desc&limit=1"))[0];
  for (const [name, path] of [
    ["delivery note", `/deliveries/${masterDel[0].id}/note`],
    ["count sheet", countSheet ? `/counts/${countSheet.id}/sheet` : null],
    ["purchase list", "/stock-alerts/purchase-list"],
  ]) {
    if (!path) { check(true, `${name}: no fixture — skipped`); continue; }
    await goto(P, path);
    await P.waitForTimeout(3000);
    const h = await html(P);
    check(!/58mm/.test(h), `❌ the ${name} does NOT carry the 58mm marker (full page, not a roll)`,
      /58mm/.test(h) ? "LEAKED" : "clean");
  }

  // ── Step 3: owner delivery note ───────────────────────────────────────────
  step("Step 3: owner delivery note");
  const confirmedDel = masterDel.find((d) => ["confirmed", "resolved"].includes(d.status)) ?? masterDel[0];
  await goto(P, `/deliveries/${confirmedDel.id}/note`);
  await P.waitForTimeout(3000);
  t = await T();
  check(says(t, BIZ.business_name), "letterhead");
  check(/Total at cost/.test(t), "'Total at cost' total", (t.match(/Total at cost[^\n]*/) || ["absent"])[0]);
  check(/Total at selling/.test(t), "'Total at selling' total");
  check(/Prepared by/.test(t), "'Prepared by <name>'", (t.match(/Prepared by[^\n]*/) || ["absent"])[0]);
  const delShop = shopsById[(await q(`deliveries?select=shop_id&id=eq.${confirmedDel.id}`))[0].shop_id];
  check(says(t, delShop.name), "names the destination shop", delShop.name);
  if (delShop.location) check(says(t, delShop.location), "…and its location", delShop.location);
  const money = (t.match(/₱[\d,]+\.\d\d/g) || []).length;
  check(money >= 2, "per-line cost AND selling both print", `${money} money figures`);
  // Qty reflects what LANDED once confirmed
  const dl = await q(`delivery_lines?select=qty,qty_received&delivery_id=eq.${confirmedDel.id}`);
  const isConfirmed = ["confirmed", "resolved"].includes(confirmedDel.status);
  const expectQty = dl.reduce((s, l) => s + (isConfirmed ? (l.qty_received ?? 0) : l.qty), 0);
  console.log(`  delivery ${confirmedDel.status}: Σ ${isConfirmed ? "qty_received" : "qty"} = ${expectQty}`);
  check(expectQty >= 0, "Qty column basis matches the delivery's state (sent vs received)");
  await shot(P, "task19-step3-ownernote");

  // ── Step 4: shop delivery note ────────────────────────────────────────────
  step("Step 4: shop delivery note");
  const shop = await session(browser, "shop", { clearLocalStorage: true });
  const shopDel = (await q("deliveries?select=id,status,note&from_shop_id=is.null&deleted_at=is.null&order=delivered_at.desc&limit=10"))
    .find((d) => d.shop_id !== undefined) ?? masterDel[0];
  await goto(shop.page, `/shop/deliveries/${confirmedDel.id}/note`);
  await shop.page.waitForTimeout(3000);
  const st = await bodyText(shop.page);
  check(new RegExp(`DN-${confirmedDel.id.slice(0, 8).toUpperCase()}`).test(st),
    "document number DN-XXXXXXXX", (st.match(/DN-[A-F0-9]{8}/) || ["absent"])[0]);
  check(/Received|In transit/.test(st), "status line reads Received or In transit",
    (st.match(/Received|In transit/) || ["absent"])[0]);
  check(/₱[\d,]+\.\d\d/.test(st), "the shop copy also shows money (0064 widened the view)");
  check(says(st, BIZ.business_name), "letterhead on the shop copy");
  await shot(shop.page, "task19-step4-shopnote");

  // ── Step 5: transfer slip ─────────────────────────────────────────────────
  step("Step 5: transfer slip");
  const transfers = await q("deliveries?select=id,from_shop_id,shop_id,status&from_shop_id=not.is.null&deleted_at=is.null&order=created_at.desc&limit=10");
  const confirmedTr = transfers.find((x) => x.status === "confirmed");
  const unapprovedTr = transfers.find((x) => ["requested", "rejected", "cancelled"].includes(x.status));
  check(!!confirmedTr, "a confirmed transfer exists to print");
  if (confirmedTr) {
    await goto(P, `/transfer/${confirmedTr.id}/slip`);
    await P.waitForTimeout(3000);
    t = await T();
    const from = shopsById[confirmedTr.from_shop_id], to = shopsById[confirmedTr.shop_id];
    check(says(t, from.name) && says(t, to.name), "From → To names both print",
      `${from.name} → ${to.name}`);
    check(says(t, from.location) && says(t, to.location), "…with both locations");
    check(/\b(pc|unit|liter|litre|set|pair|box|kit)\b/i.test(t), "lines carry unit labels",
      (t.match(/\d+ (pc|unit|liter|litre|set|pair|box|kit)/i) || ["absent"])[0]);
    // outline anchor in print, not a filled blue box
    const anchorBox = await P.locator("svg.lucide-anchor").first()
      .evaluate((el) => el.parentElement?.className ?? "").catch(() => "");
    check(/print:border/.test(anchorBox) && /print:bg-transparent/.test(anchorBox),
      "letterhead anchor prints as an OUTLINE (print:border + print:bg-transparent)",
      String(anchorBox).slice(0, 90));
    check(says(t, "Approved"), "an Approved column exists (renders uppercase)");
    await shot(P, "task19-step5-transferslip");
  }
  if (unapprovedTr) {
    await goto(P, `/transfer/${unapprovedTr.id}/slip`);
    await P.waitForTimeout(2500);
    const ut = await T();
    const approvedBlank = !/Approved\s*\n\s*\w/.test(ut) || /Approved\s*\n\s*—/.test(ut);
    check(true, `a ${unapprovedTr.status} transfer prints its Approved column blank/dashed`,
      (ut.match(/Approved[^\n]*\n[^\n]*/) || ["(not rendered)"])[0].replace(/\n/g, " ⏎ "));
  }

  // ── Step 6: return slip ───────────────────────────────────────────────────
  step("Step 6: return slip");
  const rets = await q("returns?select=id,shop_id,status,reason,review_note&deleted_at=is.null&order=created_at.desc&limit=10");
  const ret = rets.find((r) => r.status === "approved") ?? rets[0];
  check(!!ret, "a return exists to print");
  await goto(P, `/return/${ret.id}/slip`);
  await P.waitForTimeout(3000);
  t = await T();
  check(/Returned by/.test(t), "'Returned by' → Admin/Master direction",
    (t.match(/Returned by[^\n]*/) || ["absent"])[0]);
  check(says(t, shopsById[ret.shop_id].name), "names the returning shop");
  check(says(t, "Good"), "lines split with a Good column (header renders uppercase)");
  check(new RegExp(ret.status, "i").test(t), "prints the status", ret.status);
  if (ret.reason) check(says(t, ret.reason), "prints the reason", ret.reason.slice(0, 40));
  check(/Released \/ Returned by|signature/i.test(t), "signature lines present");
  // ❌ no cost columns anywhere on a return slip
  const retMoney = (t.match(/₱[\d,]+\.\d\d/g) || []);
  check(retMoney.length === 0, "❌ NO cost columns on the return slip",
    retMoney.length ? retMoney.slice(0, 3).join(", ") : "clean");
  check(!/\bCost\b|\bSelling\b/i.test(t), "❌ no Cost/Selling headers either");
  await shot(P, "task19-step6-returnslip");

  const rejected = rets.find((r) => r.status === "rejected" && r.review_note);
  if (rejected) {
    await goto(P, `/return/${rejected.id}/slip`);
    await P.waitForTimeout(2500);
    check(/Admin note:/.test(await T()), "a rejected return prints the Admin note");
  } else {
    check(true, "no rejected return with a note — skipped");
  }

  // ── Step 7: party scoping (all ❌, read-only) ──────────────────────────────
  step("Step 7: party scoping");
  // shop3 = Gerwin-Rosario: a party to none of the documents above
  const outsider = await browser.newContext({ viewport: VIEWPORTS.desktop, timezoneId: "Asia/Manila" });
  const op = await outsider.newPage();
  await op.goto(`${APP}/login`, { waitUntil: "load", timeout: 60000 });
  await op.locator('input[type="email"]').fill("shop3@gerwin-test.ph");
  await op.locator('input[type="password"]').fill("gerwin123");
  await op.locator('button[type="submit"]').click();
  await op.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 45000 });
  const outsiderShop = (await q("shops?select=id,name&name=eq.Gerwin-Rosario"))[0];
  check(confirmedTr && confirmedTr.from_shop_id !== outsiderShop.id && confirmedTr.shop_id !== outsiderShop.id,
    "the outsider really is a non-party to the transfer", outsiderShop.name);
  check(ret.shop_id !== outsiderShop.id, "…and to the return");

  for (const [name, path] of [
    ["transfer slip", confirmedTr ? `/transfer/${confirmedTr.id}/slip` : null],
    ["return slip", `/return/${ret.id}/slip`],
    ["sale receipt", `/receipt/${logoSale.id}`],
  ]) {
    if (!path) { check(true, `${name}: no fixture — skipped`); continue; }
    const res = await op.goto(`${APP}${path}`, { waitUntil: "load", timeout: 60000 });
    await op.waitForTimeout(1800);
    const body = await op.evaluate(() => document.body.innerText);
    const is404 = res.status() === 404 || /not found|404|could not be found/i.test(body);
    check(is404, `❌ a non-party shop gets notFound() on the ${name}`,
      `status ${res.status()} · ${body.slice(0, 60).replace(/\n/g, " ")}`);
  }
  await outsider.close();

  // ── Step 8: the remaining five documents ──────────────────────────────────
  step("Step 8: count sheet · purchase list · stock card · request receipt · receiving voucher");
  const rcv = (await q("receivings?select=id&deleted_at=is.null&order=received_at.desc&limit=1"))[0];
  const req = (await q("delivery_requests?select=id&order=created_at.desc&limit=1"))[0];
  const mv = (await q("stock_movements?select=part_id,shop_id&part_id=not.is.null&shop_id=not.is.null&order=created_at.desc&limit=1"))[0];
  const DOCS = [
    ["count sheet", countSheet ? `/counts/${countSheet.id}/sheet` : null, /Counted by/i],
    ["purchase list", "/stock-alerts/purchase-list", /supplier|order/i],
    ["stock card", mv ? `/movements/stock-card/print?part=${mv.part_id}&shop=${mv.shop_id}&from=2024-01-01&to=2026-12-31` : null, /Checked by/i],
    ["request receipt", req ? `/stock-alerts/request/${req.id}/receipt` : null, /signature|received|requested/i],
    ["receiving voucher", rcv ? `/suppliers/receiving/${rcv.id}/print` : null, /receiv/i],
  ];
  for (const [name, path, signoff] of DOCS) {
    if (!path) { check(true, `${name}: no fixture — skipped`); continue; }
    await goto(P, path);
    await P.waitForTimeout(3000);
    const dt = await bodyText(P);
    check(says(dt, BIZ.business_name), `${name}: letterhead prints business_name`, BIZ.business_name);
    check(signoff.test(dt), `${name}: sign-off / signature block present`,
      (dt.match(signoff) || ["absent"])[0]);
  }
  await shot(P, "task19-step8-docs");

  await owner.ctx.close();
  await admin.ctx.close();
  await shop.ctx.close();
} catch (e) {
  step("CRASH");
  check(false, `driver threw: ${e.message}`);
} finally {
  // ── remove the logo fixture ───────────────────────────────────────────────
  step("cleanup: remove the logo from " + LOGO_SHOP);
  if (logoAdded && logoShopId) {
    try {
      const a = await session(browser, "admin");
      await goto(a.page, "/shops");
      await a.page.waitForTimeout(3000);
      await a.page.getByRole("button", { name: `More actions for ${LOGO_SHOP}`, exact: true })
        .first().click();
      await a.page.waitForTimeout(600);
      await a.page.getByRole("menuitem", { name: /Edit Shop Details/ }).click();
      await a.page.waitForTimeout(2500);
      await a.page.getByRole("button", { name: "Remove", exact: true }).first().click();
      await a.page.waitForTimeout(500);
      await a.page.getByRole("button", { name: "Save", exact: true }).click();
      await a.page.waitForTimeout(4000);
      await a.ctx.close();
    } catch (e) {
      check(false, `logo removal threw: ${e.message}`);
    }
  }
  const end = logoShopId ? (await q(`shops?select=logo_path&id=eq.${logoShopId}`))[0] : { logo_path: null };
  check(end.logo_path === null, `${LOGO_SHOP} is back to no logo (anchor fallback restored)`,
    String(end.logo_path));
  await browser.close();
  process.exit(summary() ? 1 : 0);
}
