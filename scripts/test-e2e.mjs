/**
 * END-TO-END: one continuous story, admin → shop → admin.
 *
 * The other suites each prove one feature in isolation. This one walks the
 * whole business the way it actually runs, in order, checking that the handoffs
 * between features hold:
 *
 *   supplier debt → receive → deliver → shop confirms → shop sells (part +
 *   engine, partial payment) → shop records a loss → shop submits ONE batch →
 *   admin approves the batch → stock deducts → warranty auto-created → COGS
 *   frozen → utang collected (posts immediately) → receivable settles →
 *   low stock alerts → shop requests a delivery → admin pays the supplier →
 *   profitability adds up.
 *
 * Provisions its own shop — never touches a real branch.
 *
 * Run: node scripts/test-e2e.mjs
 */
import {
  owner, RUN, P, check, section, summary,
  provisionShop, seedPart, seedEngineModel, seedSupplier,
  receive, cleanup,
} from "./_harness.mjs";

const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

const COST = 10000;   // ₱100 per part
const PRICE = 25000;  // ₱250 per part
const ENG_COST = 3_000_000;   // ₱30,000
const ENG_PRICE = 4_500_000;  // ₱45,000

const shop = await provisionShop("E2E");
const emp = shop.client;

// ── 1. Admin buys stock on credit ────────────────────────────────────────────
section("1. Admin receives stock from a supplier, unpaid (net-30):");
const supplier = await seedSupplier({
  label: "Marine Supply", credit_limit: 100_000_00, payment_terms_days: 30,
});
const part = await seedPart({ label: "Impeller", cost: COST, price: PRICE, reorder_level: 3 });
const model = await seedEngineModel({ brand: "E2E", model: "Enduro", hp: 40 });

const rcvId = await receive({
  supplier_id: supplier.id,
  parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: COST }],
  engines: [{
    serial_number: `E2E-${RUN}-ENG1`, engine_model_id: model.id,
    condition: "brand_new", cost_centavos: ENG_COST, price_centavos: ENG_PRICE,
    warranty_months: 12,
  }],
  payment_status: "unpaid",
});
const OWED = 10 * COST + ENG_COST; // ₱31,000
{
  const { data } = await owner.rpc("fn_supplier_outstanding", { p_supplier_id: supplier.id });
  check(`we now owe the supplier ${P(OWED)}`, Number(data) === OWED, String(data));
}
{
  const { data } = await owner
    .from("receivings").select("due_date, payment_status").eq("id", rcvId).single();
  check("due date auto-set from net-30 terms", !!data.due_date && data.due_date > today);
  check("receiving is unpaid", data.payment_status === "unpaid");
}
{
  const { data } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).single();
  check("10 parts sitting in master", data?.qty === 10);
}

// ── 2. Admin delivers; stock does NOT land until the shop confirms ───────────
section("2. Admin delivers to the shop — into transit, not landed:");
const { data: eng } = await owner
  .from("engines").select("id").eq("serial_number", `E2E-${RUN}-ENG1`).single();
const { data: delId, error: dErr } = await owner.rpc("fn_deliver_stock", {
  p_shop_id: shop.id, p_note: `ZZ-TEST dlv ${RUN}`,
  p_parts: [{ part_id: part.id, qty: 8 }], p_engine_ids: [eng.id],
});
check("delivery sent", !dErr, dErr?.message);
{
  const { data } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).single();
  check("master drew down to 2", data?.qty === 2);
}
{
  const { data } = await emp.from("shop_stock").select("qty").eq("part_id", part.id);
  check("shop has NOTHING yet — it must confirm first", (data ?? []).length === 0);
}
{
  const { data } = await owner.from("stock_in_transit").select("qty").eq("delivery_id", delId);
  const inTransit = (data ?? []).reduce((s, r) => s + r.qty, 0);
  check("8 parts + 1 engine are in transit", inTransit === 9, String(inTransit));
}

section("3. Shop confirms 7 of 8 — the missing one stays with the admin:");
{
  const { data: lines } = await owner
    .from("delivery_lines").select("id, part_id, qty").eq("delivery_id", delId);
  const { data, error } = await emp.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: lines.map((l) => ({
      line_id: l.id,
      qty_received: l.part_id ? 7 : 1, // one impeller never arrived
      shop_note: l.part_id ? "1 kulang sa dating" : null,
    })),
    p_note: null,
  });
  check("confirm accepted: 8 landed, 1 short", !error && data?.landed === 8 && data?.short === 1,
    error?.message ?? JSON.stringify(data));
}
{
  const { data } = await owner.from("deliveries").select("status").eq("id", delId).single();
  check("delivery flagged `discrepancy`", data?.status === "discrepancy");
}
{
  const { data } = await emp.from("shop_stock").select("qty").eq("part_id", part.id).single();
  check("shop now holds 7 parts", data?.qty === 7);
}
{
  // The shop must have no way to resolve a shortfall itself.
  const { error } = await emp.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: (await owner.from("delivery_lines").select("id")
      .eq("delivery_id", delId).not("part_id", "is", null).single()).data.id,
    p_qty: 1, p_resolution: "returned_to_master", p_reason: "shop tried to self-resolve",
  });
  check("shop CANNOT resolve the shortfall — only the admin can", !!error, "shop resolved it!");
}
section("4. Admin resolves the shortfall as a transit write-off:");
{
  const { data: line } = await owner.from("delivery_lines").select("id")
    .eq("delivery_id", delId).not("part_id", "is", null).single();
  const { error } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: line.id, p_qty: 1,
    p_resolution: "written_off", p_reason: `ZZ-TEST nawala sa biyahe ${RUN}`,
  });
  check("admin writes off the lost unit", !error, error?.message);
}
{
  const { data } = await owner.from("stock_in_transit").select("qty").eq("delivery_id", delId);
  check("transit is now empty", (data ?? []).length === 0);
}
{
  const { data } = await owner.from("stock_movements").select("movement_type")
    .eq("part_id", part.id).eq("movement_type", "transit_writeoff");
  check("write-off logged as `transit_writeoff`, NOT a shop loss", (data ?? []).length === 1);
}

// ── 5. Shop sells ────────────────────────────────────────────────────────────
section("5. Shop records the day's work (invisible to the admin):");
const { data: partSale, error: psErr } = await emp.rpc("fn_record_sale", {
  p_customer: { name: `ZZ-TEST Walk-in ${RUN}` },
  p_part_lines: [{ part_id: part.id, qty: 2, unit_price_centavos: PRICE }],
});
check("cash sale of 2 impellers recorded", !psErr, psErr?.message);

const { data: engSale, error: esErr } = await emp.rpc("fn_record_sale", {
  p_customer: { name: `ZZ-TEST Engine Buyer ${RUN}`, phone: "0917-000-1111" },
  p_engine_lines: [{ engine_id: eng.id, agreed_price_centavos: ENG_PRICE }],
  p_payment_type: "partial",
  p_amount_paid_centavos: 1_000_000, // ₱10,000 down
});
check("engine sale on utang recorded (₱10,000 down)", !esErr, esErr?.message);

const { error: lossErr } = await emp.rpc("fn_record_loss", {
  p_part_id: part.id, p_qty: 1, p_reason: "nasira", p_note: `ZZ-TEST basag ${RUN}`,
});
check("a broken impeller recorded as a loss", !lossErr, lossErr?.message);

{
  // `.every()` on an empty array is true, so assert the count as well.
  const { data } = await owner.from("sales").select("id, status").eq("shop_id", shop.id);
  check(
    "both sales sit at `recorded`",
    data?.length === 2 && data.every((s) => s.status === "recorded"),
    JSON.stringify(data?.map((s) => s.status))
  );
}
{
  const { data } = await emp.from("shop_stock").select("qty").eq("part_id", part.id).single();
  check("shop still shows 7 — recording does not deduct", data?.qty === 7);
}

// ── 6. Submit + approve as ONE batch ─────────────────────────────────────────
section("6. Shop submits ONE batch; admin approves it in one go:");
{
  const { data, error } = await emp.rpc("fn_submit_shop_batch");
  check("batch submitted", !error, error?.message);
  check("2 sales + 1 loss went in together", data?.sales === 2 && data?.losses === 1, JSON.stringify(data));
}
const { data: batch } = await owner
  .from("submission_batches").select("id").eq("shop_id", shop.id).single();
{
  const { error } = await owner.rpc("fn_approve_batch", { p_batch_id: batch.id });
  check("admin approves the whole batch at once", !error, error?.message);
}
{
  // 7 − 2 sold − 1 broken = 4
  const { data } = await emp.from("shop_stock").select("qty").eq("part_id", part.id).single();
  check("stock deducts ONLY on approval: 7 → 4", data?.qty === 4, String(data?.qty));
}
{
  const { data } = await owner.from("engines").select("status").eq("id", eng.id).single();
  check("engine marked sold", data?.status === "sold");
}
{
  const { data } = await owner.from("warranties").select("months, expires_on").eq("sale_id", engSale).single();
  check("warranty auto-created on approval (12 months)", data?.months === 12 && !!data.expires_on);
}
{
  const { data } = await owner.from("sale_line_costs").select("line_cost_centavos").eq("sale_id", partSale);
  check(`COGS frozen at ${P(2 * COST)} for the part sale`, data?.[0]?.line_cost_centavos === 2 * COST);
}

// ── 7. Utang collected — posts immediately, no approval ──────────────────────
section("7. Customer pays down the utang (posts immediately):");
{
  const { data } = await owner.from("receivables").select("balance_centavos").eq("sale_id", engSale).single();
  check(`balance is ${P(ENG_PRICE - 1_000_000)}`, data?.balance_centavos === ENG_PRICE - 1_000_000);
}
const { data: payId, error: payErr } = await emp.rpc("fn_record_utang_payment", {
  p_sale_id: engSale, p_amount_centavos: 2_000_000, p_note: `ZZ-TEST bayad ${RUN}`,
  p_payer_name: `ZZ-TEST Payer ${RUN}`,
});
check("shop records a ₱20,000 payment", !payErr, payErr?.message);
{
  const { data } = await owner.from("receivables").select("balance_centavos").eq("sale_id", engSale).single();
  check(
    "balance drops WITHOUT any approval step",
    data?.balance_centavos === ENG_PRICE - 3_000_000,
    String(data?.balance_centavos)
  );
}
{
  const { data } = await owner.from("submission_batches").select("id").eq("shop_id", shop.id);
  check("the payment never entered the approval queue", data?.length === 1);
}
section("8. A mistaken payment is voided, not deleted:");
{
  const { error } = await emp.rpc("fn_void_utang_payment", { p_id: payId, p_reason: `ZZ-TEST typo ${RUN}` });
  check("payment voided", !error, error?.message);
}
{
  const { data } = await owner.from("receivables").select("balance_centavos").eq("sale_id", engSale).single();
  check("balance restored", data?.balance_centavos === ENG_PRICE - 1_000_000);
}
{
  const { data } = await owner.from("utang_payments").select("id, deleted_at").eq("id", payId).single();
  check("the entry stays in history (soft-deleted)", !!data?.deleted_at);
}
section("9. Settling the balance:");
{
  const { error } = await emp.rpc("fn_record_utang_payment", {
    p_sale_id: engSale, p_amount_centavos: ENG_PRICE - 1_000_000, p_note: `ZZ-TEST full ${RUN}`,
    p_payer_name: `ZZ-TEST Payer ${RUN}`,
  });
  check("customer pays the rest", !error, error?.message);
}
{
  const { data } = await owner.from("sales").select("settled_at").eq("id", engSale).single();
  check("sale marked settled at zero balance", !!data?.settled_at);
}
{
  const { error } = await emp.rpc("fn_record_utang_payment", {
    p_sale_id: engSale, p_amount_centavos: 100, p_payer_name: `ZZ-TEST Payer ${RUN}`,
  });
  check("cannot overpay a settled sale", !!error, "overpayment accepted!");
}

// ── 10. Low stock → shop asks, admin is told ─────────────────────────────────
section("10. Stock runs low → the shop asks for more:");
{
  // `data ?? []` would make a BROKEN query look like "not low", so assert on
  // the error too — an empty result must mean empty, not failed.
  const { data, error } = await emp
    .from("shop_low_stock_safe").select("product_id, on_hand").eq("product_id", part.id);
  check("4 on hand vs reorder level 3 — not low yet", !error && data.length === 0, error?.message);
}
{
  // sell 2 more → 2 on hand, below the level of 3
  const { data: s } = await emp.rpc("fn_record_sale", {
    p_customer: { name: `ZZ-TEST Walk-in2 ${RUN}` },
    p_part_lines: [{ part_id: part.id, qty: 2, unit_price_centavos: PRICE }],
  });
  await emp.rpc("fn_submit_shop_batch");
  const { data: b } = await owner
    .from("submission_batches").select("id").eq("shop_id", shop.id)
    .order("submitted_at", { ascending: false }).limit(1).single();
  await owner.rpc("fn_approve_batch", { p_batch_id: b.id });
  const { data, error } = await emp
    .from("shop_low_stock_safe").select("product_id, on_hand, threshold").eq("product_id", part.id);
  check(
    "now flagged low (2 ≤ 3)",
    !error && data.length === 1 && data[0].on_hand === 2 && data[0].threshold === 3,
    error?.message ?? JSON.stringify(data)
  );
}
{
  const { error } = await emp.rpc("fn_create_delivery_request", {
    p_lines: [{ part_id: part.id, qty_requested: 20 }],
    p_note: `ZZ-TEST paki-deliver ${RUN}`,
  });
  check("shop requests a delivery", !error, error?.message);
}
{
  const { data } = await owner
    .from("delivery_requests").select("status").eq("shop_id", shop.id).single();
  check("request is open for the admin", data?.status === "open");
}
{
  const { data } = await owner
    .from("notifications").select("type").eq("shop_id", shop.id).eq("type", "delivery_request");
  check("admin was notified of the request", (data ?? []).length >= 1);
}

// ── 11. Admin pays the supplier ──────────────────────────────────────────────
section("11. Admin pays the supplier back:");
{
  const { error } = await owner.rpc("fn_record_supplier_payment", {
    p_supplier_id: supplier.id, p_amount: OWED, p_receiving_id: null,
    p_paid_at: null, p_method: "cash", p_reference_no: null,
    p_note: `ZZ-TEST bayad ${RUN}`, p_receipt_image_path: null,
  });
  check("full payment recorded (FIFO)", !error, error?.message);
}
{
  const { data } = await owner.rpc("fn_supplier_outstanding", { p_supplier_id: supplier.id });
  check("supplier debt cleared", Number(data) === 0, String(data));
}
{
  const { data } = await owner.from("receivings").select("payment_status").eq("id", rcvId).single();
  check("receiving marked paid", data?.payment_status === "paid");
}
{
  const { data } = await owner.from("expenses").select("id").ilike("description", `%${RUN}%`);
  check("supplier payment did NOT leak into expenses (it's COGS)", (data ?? []).length === 0);
}

// ── 12. The numbers add up ───────────────────────────────────────────────────
section("12. Profitability reconciles:");
{
  const { data: sales } = await owner
    .from("sales").select("total_centavos").eq("shop_id", shop.id)
    .eq("status", "approved").is("deleted_at", null);
  const revenue = sales.reduce((s, r) => s + r.total_centavos, 0);
  const expected = 2 * PRICE + ENG_PRICE + 2 * PRICE; // 2 part sales + the engine
  check(`revenue = ${P(expected)}`, revenue === expected, String(revenue));

  const { data: costs } = await owner
    .from("sale_line_costs").select("line_cost_centavos, sales!inner(shop_id, status)")
    .eq("sales.shop_id", shop.id).eq("sales.status", "approved");
  const cogs = costs.reduce((s, c) => s + c.line_cost_centavos, 0);
  const expectedCogs = 4 * COST + ENG_COST;
  check(`COGS = ${P(expectedCogs)}`, cogs === expectedCogs, String(cogs));
  check(`gross profit = ${P(expected - expectedCogs)}`, revenue - cogs === expected - expectedCogs);
}
{
  // The loss is NOT part of COGS — it's stock that never sold.
  const { data } = await owner
    .from("losses").select("value_centavos").eq("shop_id", shop.id).eq("status", "approved");
  check(
    `the broken impeller is a ${P(COST)} loss, tracked apart from COGS`,
    data?.length === 1 && data[0].value_centavos === COST
  );
}

section("Cleanup:");
await cleanup();
summary();
