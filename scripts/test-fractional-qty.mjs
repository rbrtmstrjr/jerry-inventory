/**
 * 0114–0124 — fractional quantities (the *tingi*).
 *
 * Gerry sells nails, lead, fasteners, welding material and powders BY THE KILO,
 * and a customer buys a part-kilo. Quantity therefore has to accept 0.1, 2.3,
 * 10.2 — but ONLY for goods that are actually weighed, and only to one decimal.
 *
 * The rule has exactly three parts and this suite proves each one separately,
 * because each is enforced in a different place and any one could rot alone:
 *
 *   1. TENTHS ONLY — 0.12 is REFUSED, not silently rounded to 0.1.
 *      numeric(12,1) would round it on cast, which is a wrong receipt nobody
 *      notices, so `fn_assert_qty` raises first and a CHECK backs it at rest.
 *   2. THE UNIT DECIDES — a `pc` product refuses 2.5; a `kg` product takes it.
 *      That is why 0114/0115 turned `parts.unit` from free text into a FK: the
 *      business rule must not hinge on whether someone typed 'kg' or 'Kg'.
 *   3. ENGINES ARE ALWAYS 1 — serial-tracked, so there is no half of one.
 *
 * Plus the two things a decimal quantity could quietly break:
 *   • the ledger invariant (Σ movements = stock_levels) must still hold EXACTLY
 *     at a fractional quantity — numeric, not float, is the whole reason
 *   • money must round PER LINE and be stored, so the receipt and the report
 *     cannot disagree (₱15.50 × 2.3 = ₱35.65, never ₱35.649999)
 *
 * Provisions its own shop — it must never write into a real branch.
 */
import {
  owner, admin, check, section, summary, cleanup,
  provisionShop, seedSupplier, seedPart, seedEngineModel, seedCustomer,
  receive, deliverAndConfirm, trackEngine, RUN,
} from "./_harness.mjs";

// ── gate: 0114–0118 must be applied. `units` is the visible half; the
//    fractional column type is the half that actually matters, so probe both.
{
  const { error: unitsErr } = await owner.from("units").select("code").limit(1);
  if (unitsErr) {
    console.error(
      "test-fractional-qty: migration 0114_units.sql is not applied — run 0114–0126 in the SQL editor first."
    );
    process.exit(2);
  }
}

// ── 0. STATIC: no quantity may be validated or parsed as an integer ─────────
//
//    This section exists because the DB-level suites below all passed while
//    the app was still refusing "0.5" at the counter. They call the RPCs
//    directly, so they proved the DATABASE takes tenths and said nothing about
//    the two layers in front of it:
//      • a server action's Zod schema — `z.number().int()` rejected it outright
//      • a form's parseInt()          — silently TRUNCATED 0.5 to 0
//    Both are invisible to an RPC-level test, so they get a static one, in the
//    same spirit as test-definer-guards.
section("No quantity is treated as an integer (static)");
{
  const { readdirSync, readFileSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");

  const walk = (dir) => readdirSync(dir).flatMap((e) => {
    const p = join(dir, e);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
  const files = [...walk("app"), ...walk("components")];

  // A quantity identifier — deliberately NOT reorder_level (a threshold, not a
  // measurement; Gerry asked for those to stay whole) and not *_centavos.
  //
  // An engine count is the other legitimate exception: an engine is counted,
  // not measured, so `.int()`/`parseInt` are correct there (0128/0129). Rather
  // than carve that out by name — fragile, and silent the next time someone
  // adds an integer qty — a site claims the exemption explicitly with a
  // trailing `whole-unit-qty` marker comment. It's greppable, and adding one
  // is a decision that has to justify itself at the call site, not a way to
  // quietly silence this check.
  const QTY = String.raw`\w*(?<!reorder_)qty\w*|\bcounted\b|\bgood\b|\bdamaged\b|\bavailable\b`;
  const WHOLE_UNIT = /whole-unit-qty/;

  const zodInts = [];
  const parseInts = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    src.split("\n").forEach((line, i) => {
      if (WHOLE_UNIT.test(line)) return;
      if (new RegExp(String.raw`(${QTY})\s*:\s*z\s*\.number\(\)\s*\.int\(\)`).test(line))
        zodInts.push(`${f}:${i + 1}`);
      if (/parseInt\(/.test(line) && new RegExp(QTY, "i").test(line))
        parseInts.push(`${f}:${i + 1}`);
    });
  }

  check("no server action validates a quantity with z.number().int()",
    zodInts.length === 0, zodInts.join("\n      "));
  check("no form parses a quantity with parseInt (it truncates 0.5 to 0)",
    parseInts.length === 0, parseInts.join("\n      "));
}

const shop = await provisionShop("Tingi");
const supplier = await seedSupplier({ label: "KiloVendor" });
const cust = await seedCustomer({ label: "Tingi Buyer" });

// kg — nails, sold by weight. cost ₱1.00/kg, price ₱15.50/kg (an odd price on
// purpose: ₱15.50 × 2.3 is exactly the rounding case that must not drift).
const kilo = await seedPart({ label: "Nails", cost: 100, price: 1550, unit: "kg" });
// pc — a spark plug. There is no half of one.
const piece = await seedPart({ label: "Plug", cost: 5000, price: 9000, unit: "pc" });

// ── 1. the units vocabulary ─────────────────────────────────────────────────
section("Units are controlled reference data");
{
  const { data: units } = await owner.from("units").select("*").is("deleted_at", null);
  const byCode = Object.fromEntries((units ?? []).map((u) => [u.code, u]));
  check("pc exists and is whole-unit", byCode.pc && byCode.pc.allows_fractional === false);
  check("kg exists and is fractional", byCode.kg && byCode.kg.allows_fractional === true);
  // The vocabulary is asserted EXACTLY, so an accidental flip (someone making
  // `pc` fractional and letting a shop sell half a spark plug) fails the build.
  // A future intentional flip must edit this line — that friction is the point:
  // the decision then shows up in a diff instead of living only as DB state.
  //
  // SORTED: the select has no .order(), so PostgREST may return these rows in
  // any order. Comparing an unsorted join() would flap between runs.
  const fractionalCodes = (units ?? [])
    .filter((u) => u.allows_fractional)
    .map((u) => u.code)
    .sort()
    .join(",");
  check("exactly kg, m, ft and roll are fractional (0130)",
    fractionalCodes === "ft,kg,m,roll", fractionalCodes);
  // `pc` is already asserted a few lines above — do not double-count it.
  for (const whole of ["set", "box", "pair"]) {
    check(`${whole} is NOT fractional`, byCode[whole]?.allows_fractional === false);
  }

  // The shop needs the label to render "12 kg on hand".
  const { data: seen, error } = await shop.client.from("units").select("code").eq("code", "kg");
  check("a shop can read the vocabulary", !error && seen?.length === 1, error?.message);

  // Writing it is the office's job.
  const { error: wErr } = await shop.client.from("units")
    .update({ allows_fractional: true }).eq("code", "pc");
  const { data: pcAfter } = await owner.from("units").select("allows_fractional").eq("code", "pc").single();
  check("a shop cannot make a unit fractional", pcAfter?.allows_fractional === false, wErr?.message);
}

// ── 2. receiving a fractional quantity ──────────────────────────────────────
section("Receiving accepts tenths for a weighed product");
{
  const ok = await receive({
    supplier_id: supplier.id,
    parts: [{ part_id: kilo.id, qty: 25.5, unit_cost_centavos: 100 }],
    note: `ZZ-TEST rcv kg ${RUN}`,
  });
  check("receiving 25.5 kg succeeds", !!ok, "receive() threw");

  const { data: lvl } = await owner.from("stock_levels")
    .select("qty").eq("part_id", kilo.id).is("shop_id", null).single();
  check("master holds exactly 25.5", Number(lvl?.qty) === 25.5, String(lvl?.qty));

  // numeric, not float: the value round-trips as an exact decimal string.
  check("qty is stored as an exact decimal", String(lvl?.qty) === "25.5", String(lvl?.qty));
}

// ── 3. tenths only — 0.12 is refused, not rounded ───────────────────────────
section("Tenths only (0.12 is refused, never rounded)");
{
  const twoDp = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST 2dp ${RUN}`,
    p_parts: [{ part_id: kilo.id, qty: 0.12, unit_cost_centavos: 100 }],
    p_engines: [],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("receiving 0.12 kg is refused", /too many decimals/i.test(twoDp.error?.message ?? ""),
    twoDp.error?.message ?? "it was ACCEPTED");

  // The dangerous failure is the silent one: if it were accepted, the cast to
  // numeric(12,1) would have stored 0.1 and nobody would ever see the error.
  const { data: lvl } = await owner.from("stock_levels")
    .select("qty").eq("part_id", kilo.id).is("shop_id", null).single();
  check("the refused 0.12 changed nothing", Number(lvl?.qty) === 25.5, String(lvl?.qty));

  const threeDp = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST 3dp ${RUN}`,
    p_parts: [{ part_id: kilo.id, qty: 1.005, unit_cost_centavos: 100 }],
    p_engines: [],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("receiving 1.005 kg is refused", /too many decimals/i.test(threeDp.error?.message ?? ""),
    threeDp.error?.message);
}

// ── 4. the UNIT decides, not the caller ─────────────────────────────────────
section("The unit decides which products may be split");
{
  const half = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST pc half ${RUN}`,
    p_parts: [{ part_id: piece.id, qty: 2.5, unit_cost_centavos: 5000 }],
    p_engines: [],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("a `pc` product refuses 2.5", /whole numbers only/i.test(half.error?.message ?? ""),
    half.error?.message ?? "it was ACCEPTED");
  check("the refusal names the product and its unit",
    /ZZ-TEST Plug/.test(half.error?.message ?? "") && /\bpc\b/.test(half.error?.message ?? ""),
    half.error?.message);

  // Same number, fractional unit → fine. The rule is the unit's, not the qty's.
  const okHalf = await receive({
    supplier_id: supplier.id,
    parts: [{ part_id: kilo.id, qty: 2.5, unit_cost_centavos: 100 }],
    note: `ZZ-TEST kg half ${RUN}`,
  });
  check("a `kg` product accepts the same 2.5", !!okHalf);

  // Flipping the unit flips the rule with no code change — that is the point
  // of keeping it as data (0114).
  await admin.from("parts").update({ unit: "kg" }).eq("id", piece.id);
  const nowOk = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST flip ${RUN}`,
    p_parts: [{ part_id: piece.id, qty: 2.5, unit_cost_centavos: 5000 }],
    p_engines: [],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("changing the unit to kg makes 2.5 legal", !nowOk.error, nowOk.error?.message);
  await admin.from("parts").update({ unit: "pc" }).eq("id", piece.id);
}

// ── 5. delivery, confirmation and the ledger invariant at a tenth ────────────
section("Stock moves in tenths and the ledger still reconciles");
{
  // The `pc` product rides along so the till tests below hit the QUANTITY rule
  // and not the "not delivered to your shop" one that would mask it.
  await deliverAndConfirm(shop, {
    parts: [{ part_id: kilo.id, qty: 10.5 }, { part_id: piece.id, qty: 2 }],
  });

  const { data: atShop } = await owner.from("stock_levels")
    .select("qty").eq("part_id", kilo.id).eq("shop_id", shop.id).single();
  check("the shop holds 10.5", Number(atShop?.qty) === 10.5, String(atShop?.qty));

  const { data: atMaster } = await owner.from("stock_levels")
    .select("qty").eq("part_id", kilo.id).is("shop_id", null).single();
  check("master is 28 − 10.5 = 17.5", Number(atMaster?.qty) === 17.5, String(atMaster?.qty));

  // THE invariant: Σ movements(product, location) = stock_levels(product, location).
  // A float column would fail this at the third or fourth fractional move.
  const { data: movs } = await owner.from("stock_movements")
    .select("qty_change, shop_id").eq("part_id", kilo.id);
  const sumAt = (sid) => (movs ?? [])
    .filter((m) => (sid === null ? m.shop_id === null : m.shop_id === sid))
    .reduce((s, m) => s + Number(m.qty_change), 0);
  check("Σ movements at master = master shelf", sumAt(null) === Number(atMaster?.qty),
    `${sumAt(null)} vs ${atMaster?.qty}`);
  check("Σ movements at the shop = shop shelf", sumAt(shop.id) === Number(atShop?.qty),
    `${sumAt(shop.id)} vs ${atShop?.qty}`);

  // A shop's safe view must report the same decimal, not a truncated one.
  const { data: ss } = await shop.client.from("shop_stock")
    .select("qty, unit").eq("part_id", kilo.id).single();
  check("shop_stock reports 10.5", Number(ss?.qty) === 10.5, String(ss?.qty));
  check("shop_stock carries the unit for display", ss?.unit === "kg", ss?.unit);
}

// ── 6. selling a tingi — and the money that comes with it ───────────────────
section("Selling a part-kilo (money rounds per line)");
{
  // ₱15.50 × 2.3 = ₱35.65 exactly. Stored, not re-derived — the receipt and
  // the report must read the same number.
  const sale = await shop.client.rpc("fn_record_sale", {
    p_customer_id: cust.id,
    p_part_lines: [{ part_id: kilo.id, qty: 2.3, unit_price_centavos: 1550 }],
    p_engine_lines: [],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
  });
  check("a 2.3 kg sale records", !sale.error && !!sale.data, sale.error?.message);

  const { data: line } = await owner.from("sale_lines")
    .select("qty, unit_price_centavos, line_total_centavos").eq("sale_id", sale.data).single();
  check("the line keeps qty 2.3", Number(line?.qty) === 2.3, String(line?.qty));
  check("line total is ₱35.65, rounded once and stored",
    line?.line_total_centavos === 3565, String(line?.line_total_centavos));

  const { data: sHead } = await owner.from("sales")
    .select("total_centavos").eq("id", sale.data).single();
  check("the sale total matches the line", sHead?.total_centavos === 3565, String(sHead?.total_centavos));

  // A `pc` product still cannot be split at the till.
  const bad = await shop.client.rpc("fn_record_sale", {
    p_customer_id: cust.id,
    p_part_lines: [{ part_id: piece.id, qty: 0.5, unit_price_centavos: 9000 }],
    p_engine_lines: [],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
  });
  check("selling half a `pc` product is refused",
    /whole numbers only/i.test(bad.error?.message ?? ""), bad.error?.message ?? "it was ACCEPTED");

  const twoDp = await shop.client.rpc("fn_record_sale", {
    p_customer_id: cust.id,
    p_part_lines: [{ part_id: kilo.id, qty: 0.25, unit_price_centavos: 1550 }],
    p_engine_lines: [],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
  });
  check("selling 0.25 kg is refused", /too many decimals/i.test(twoDp.error?.message ?? ""),
    twoDp.error?.message ?? "it was ACCEPTED");

  // Zero and negative are still not quantities.
  const zero = await shop.client.rpc("fn_record_sale", {
    p_customer_id: cust.id,
    p_part_lines: [{ part_id: kilo.id, qty: 0, unit_price_centavos: 1550 }],
    p_engine_lines: [],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
  });
  // fn_record_sale keeps its own pre-0114 `qty <= 0` guard, which fires before
  // fn_assert_qty — either refusal is correct, silence is not.
  check("qty 0 is refused",
    /more than zero|Invalid sale line/i.test(zero.error?.message ?? ""), zero.error?.message);

  const neg = await shop.client.rpc("fn_record_sale", {
    p_customer_id: cust.id,
    p_part_lines: [{ part_id: kilo.id, qty: -0.5, unit_price_centavos: 1550 }],
    p_engine_lines: [],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
  });
  check("a negative qty is refused",
    /more than zero|Invalid sale line/i.test(neg.error?.message ?? ""), neg.error?.message);
}

// ── 7. the smallest sellable amount ─────────────────────────────────────────
section("0.1 is the floor Gerry asked for");
{
  const tenth = await shop.client.rpc("fn_record_sale", {
    p_customer_id: cust.id,
    p_part_lines: [{ part_id: kilo.id, qty: 0.1, unit_price_centavos: 1550 }],
    p_engine_lines: [],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
  });
  check("0.1 kg sells", !tenth.error && !!tenth.data, tenth.error?.message);

  const { data: l } = await owner.from("sale_lines")
    .select("qty, line_total_centavos").eq("sale_id", tenth.data).single();
  check("0.1 survives the round trip", Number(l?.qty) === 0.1, String(l?.qty));
  // ₱15.50 × 0.1 = ₱1.55 — round() at the line, so no half-centavo anywhere.
  check("₱15.50 × 0.1 = ₱1.55", l?.line_total_centavos === 155, String(l?.line_total_centavos));
}

// ── 8. a loss can be a part-kilo too ────────────────────────────────────────
section("Losses and counts take tenths");
{
  const loss = await shop.client.rpc("fn_record_loss", {
    p_part_id: kilo.id, p_engine_id: null, p_qty: 1.5,
    p_reason: "nasira", p_note: `ZZ-TEST natapon ${RUN}`,
  });
  check("writing off 1.5 kg records", !loss.error && !!loss.data, loss.error?.message);
  const { data: lr } = await owner.from("losses").select("qty").eq("id", loss.data).single();
  check("the loss keeps 1.5", Number(lr?.qty) === 1.5, String(lr?.qty));

  const badLoss = await shop.client.rpc("fn_record_loss", {
    p_part_id: piece.id, p_engine_id: null, p_qty: 0.5,
    p_reason: "nasira", p_note: `ZZ-TEST bad ${RUN}`,
  });
  check("writing off half a `pc` product is refused",
    /whole numbers only/i.test(badLoss.error?.message ?? ""), badLoss.error?.message ?? "it was ACCEPTED");
}

// ── 9. engines are always exactly one ───────────────────────────────────────
section("An engine is never a fraction");
{
  const model = await seedEngineModel({ brand: "ZZ-TEST", model: "Frac" });
  await receive({
    supplier_id: supplier.id,
    parts: [],
    engines: [{ serial_number: `FRAC-${RUN}`, engine_model_id: model.id, cost_centavos: 800000, price_centavos: 1000000 }],
    note: `ZZ-TEST eng ${RUN}`,
  });
  const { data: eng } = await owner.from("engines").select("id").eq("serial_number", `FRAC-${RUN}`).single();
  trackEngine(eng.id);
  await deliverAndConfirm(shop, { engine_ids: [eng.id] });

  const sale = await shop.client.rpc("fn_record_sale", {
    p_customer_id: cust.id,
    p_part_lines: [],
    p_engine_lines: [{ engine_id: eng.id, unit_price_centavos: 1000000 }],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
  });
  check("an engine sale records", !sale.error && !!sale.data, sale.error?.message);
  const { data: el } = await owner.from("sale_lines")
    .select("qty").eq("sale_id", sale.data).eq("engine_id", eng.id).single();
  check("the engine line is qty 1", Number(el?.qty) === 1, String(el?.qty));
}

// ── 10. reorder levels stay whole numbers (Gerry was explicit) ──────────────
section("Reorder levels are whole numbers");
{
  const { error } = await owner.from("parts")
    .update({ reorder_level: 2.5 }).eq("id", kilo.id);
  const { data: after } = await owner.from("parts")
    .select("reorder_level").eq("id", kilo.id).single();
  check("a fractional reorder level does not stick",
    Number.isInteger(Number(after?.reorder_level)), `${error?.message ?? ""} → ${after?.reorder_level}`);
}

// ── 10. the columns and the summary text 0116/0123 did not reach ───────────
//
//    Everything above passed 41/41 while THREE defects were live, because a
//    quantity does not only live on the stock tables:
//
//      delivery_discrepancies.qty        still int  (0125)
//      delivery_request_lines.qty_requested still int  (0125)
//      reviewed_items.summary            built with `|| qty` and `> 1`  (0126)
//
//    Each was found by driving the UI, not the RPCs — this section closes that
//    gap so the next quantity column cannot be missed the same way. Grep the
//    schema for quantity columns; do not reason about which tables "carry stock".
section("Quantities OFF the stock tables (0125 / 0126)");
{
  // ── delivery_discrepancies.qty — a shortfall the owner must be able to resolve
  const { data: delId } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: shop.id, p_note: `ZZ-TEST short ${RUN}`,
    p_parts: [{ part_id: kilo.id, qty: 2.0 }], p_engine_ids: [],
  });
  const { data: dLines } = await owner
    .from("delivery_lines").select("id").eq("delivery_id", delId);
  const lineId = dLines[0].id;

  // 1.6 of 2.0 arrives → 0.4 outstanding. An int `v_short` rounded that to 0
  // and marked the delivery CONFIRMED, breaking the invariant silently (0119).
  await shop.client.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: [{ line_id: lineId, qty_received: 1.6, shop_note: null }],
    p_note: null,
  });
  const { data: dHead } = await owner
    .from("deliveries").select("status").eq("id", delId).single();
  check("a 0.4 shortfall raises a discrepancy", dHead?.status === "discrepancy", dHead?.status);

  // THE 0125 CASE: qty < 0.5 rounded to 0 and tripped `check (qty > 0)`, so the
  // whole resolve rolled back and the stock was stranded in transit forever.
  const res = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: lineId, p_qty: 0.4,
    p_resolution: "written_off", p_reason: `ZZ-TEST lost ${RUN}`,
  });
  check("resolving a 0.4 shortfall succeeds", !res.error, res.error?.message);

  const { data: disc } = await owner
    .from("delivery_discrepancies").select("qty").eq("delivery_line_id", lineId);
  check("delivery_discrepancies.qty stores 0.4, not a rounded 0 or 1",
    Number(disc?.[0]?.qty) === 0.4, String(disc?.[0]?.qty));

  // and the ledger agrees with the audit row
  const { data: wo } = await owner.from("stock_movements")
    .select("qty_change").eq("part_id", kilo.id).eq("movement_type", "transit_writeoff");
  check("the write-off movement is −0.4",
    (wo ?? []).some((m) => Number(m.qty_change) === -0.4),
    JSON.stringify((wo ?? []).map((m) => m.qty_change)));

  // ── delivery_request_lines.qty_requested — 2.5 silently became 3
  const req = await shop.client.rpc("fn_create_delivery_request", {
    p_note: `ZZ-TEST tingi ${RUN}`,
    p_lines: [{ part_id: kilo.id, engine_model_id: null, qty_requested: 2.5,
                note: null, custom_name: null }],
  });
  check("a 2.5 kg request is accepted", !req.error, req.error?.message);
  const { data: reqLines } = await owner
    .from("delivery_request_lines").select("qty_requested")
    .eq("delivery_request_id", req.data);
  check("qty_requested stores 2.5, not a rounded 3",
    Number(reqLines?.[0]?.qty_requested) === 2.5, String(reqLines?.[0]?.qty_requested));
}

// ── 11. the reviewed history has to SAY the quantity ───────────────────────
section("reviewed_items prints a fractional quantity (0126)");
{
  // A sale BELOW 1 is the case `case when sl.qty > 1` silently swallowed: the
  // line rendered its product name and no quantity at all, on the one screen
  // the owner uses to review what a shop already did.
  const sale = await shop.client.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: kilo.id, qty: 0.5, unit_price_centavos: 1550 }],
    p_engine_lines: [], p_payment_type: "full",
    p_amount_paid_centavos: null, p_payment_method: "cash",
  });
  check("a 0.5 kg sale records", !sale.error, sale.error?.message);

  // A sale is born `recorded` (0016) and fn_approve_sale takes only
  // pending/questioned — the batch has to be submitted first. That IS the
  // pipeline: nothing is approvable until the shop hands it over.
  const sub = await shop.client.rpc("fn_submit_shop_batch");
  check("the shop submits the batch", !sub.error, sub.error?.message);

  const appr = await owner.rpc("fn_approve_sale", { p_sale_id: sale.data, p_note: null });
  check("it approves", !appr.error, appr.error?.message);

  const { data: rev } = await owner
    .from("reviewed_items").select("summary").eq("id", sale.data).single();
  check("the summary PRINTS the 0.5 (a `> 1` test drops it entirely)",
    /×\s*0\.5/.test(rev?.summary ?? ""), rev?.summary);
  check("and a whole quantity reads '2', never '2.0'",
    !/\b\d+\.0\b/.test(rev?.summary ?? ""), rev?.summary);
}

await cleanup();
summary();
