/**
 * The approval engine — stock moves ONLY when the owner approves.
 *
 * Verifies:
 *   • only the owner can approve; approving deducts shop stock
 *   • an approved engine sale marks the serial sold and auto-creates its warranty
 *   • approval freezes the COGS basis into the owner-only sale_line_costs
 *   • losses deduct and are valued at cost
 *   • the negative-stock guard blocks an over-sale, atomically (nothing partial)
 *   • question → the shop sees the note → reject; neither moves stock
 *   • a decided item cannot be re-reviewed
 *   • sales/losses are published over Realtime to the owner's queue
 *
 * Provisions its own shop — it must never write into a real branch.
 *
 * Run: node scripts/test-approvals.mjs
 */
import {
  owner, RUN, P, check, section, summary,
  provisionShop, seedPart, seedEngineModel, receive, deliverAndConfirm,
  trackCustomer, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("Approvals");
const emp1 = A.client;

const COST = 9_000;             // ₱90 per gasket
const PRICE = 18_000;           // ₱180 per gasket
const ENGINE_COST = 6_000_000;  // ₱60,000
const ENGINE_PRICE = 7_500_000; // ₱75,000
const SERIAL = `ZZ-APR-${RUN}`;

const shopQty = async (partId) =>
  (await owner.from("stock_levels").select("qty")
    .eq("part_id", partId).eq("shop_id", A.id).maybeSingle()).data?.qty ?? 0;

section("Setup (as owner):");
const part = await seedPart({ label: "Gasket", cost: COST, price: PRICE });
const model = await seedEngineModel({ brand: "ZZ-TEST", model: "BF20DK2", hp: 20 });

await receive({
  parts: [{ part_id: part.id, qty: 5, unit_cost_centavos: COST }],
  engines: [{
    serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new",
    cost_centavos: ENGINE_COST, price_centavos: ENGINE_PRICE, warranty_months: null,
  }],
});
const { data: engine } = await owner
  .from("engines").select("id").eq("serial_number", SERIAL).single();

await deliverAndConfirm(A, { parts: [{ part_id: part.id, qty: 5 }], engine_ids: [engine.id] });
check("fixtures at the shop (5 pcs + engine)", (await shopQty(part.id)) === 5, `got ${await shopQty(part.id)}`);

section("Employee records: sale (2 gaskets + engine), loss (1 nasira), over-sale (4):");
const { data: saleId } = await emp1.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: { name: `ZZ-TEST Aling Nena ${RUN}` },
  p_part_lines: [{ part_id: part.id, qty: 2 }],
  p_engine_lines: [{ engine_id: engine.id, agreed_price_centavos: ENGINE_PRICE }],
});
const { data: lossId } = await emp1.rpc("fn_record_loss", {
  p_part_id: part.id, p_engine_id: null, p_qty: 1,
  p_reason: "nasira", p_note: `ZZ-TEST basag ${RUN}`,
});
// Recording never checks stock — only approval does. This is the guard fixture.
const { data: overSaleId } = await emp1.rpc("fn_record_sale", {
  p_customer_id: null, p_customer: null,
  p_part_lines: [{ part_id: part.id, qty: 4 }], p_engine_lines: [],
});
check("three submissions recorded", !!saleId && !!lossId && !!overSaleId);
{
  const { data: s } = await owner.from("sales").select("customer_id").eq("id", saleId).single();
  trackCustomer(s?.customer_id);
}
{
  // Since 0016/0017 recorded items are invisible to the owner until submitted.
  const { data, error } = await emp1.rpc("fn_submit_shop_batch");
  check(
    "batch submitted to the owner (2 sales + 1 loss)",
    !error && data?.sales === 2 && data?.losses === 1,
    error?.message ?? JSON.stringify(data)
  );
}

section("Security — employee cannot approve:");
{
  const { error } = await emp1.rpc("fn_approve_sale", { p_sale_id: saleId, p_note: null });
  check("employee approve rejected", !!error && /owner/i.test(error.message), error?.message);
}

section("Approve the sale (2 gaskets + engine):");
{
  const { error } = await owner.rpc("fn_approve_sale", { p_sale_id: saleId, p_note: null });
  check("fn_approve_sale succeeded", !error, error?.message);
}
check("shop stock 5 → 3", (await shopQty(part.id)) === 3, `got ${await shopQty(part.id)}`);
{
  const { data: s } = await owner.from("sales").select("status, reviewed_at").eq("id", saleId).single();
  check("sale status approved + reviewed_at set", s?.status === "approved" && !!s?.reviewed_at);
}
{
  const { data: e } = await owner
    .from("engines").select("status, customer_id, sold_at").eq("id", engine.id).single();
  check("engine sold + customer + sold_at", e?.status === "sold" && !!e?.customer_id && !!e?.sold_at);
}
{
  const { data: w } = await owner.from("warranties")
    .select("months, sold_on, expires_on, customer_id, sale_id").eq("engine_id", engine.id).single();
  check("warranty auto-created", !!w);
  check(`warranty months = model default (${model.default_warranty_months})`,
    w?.months === model.default_warranty_months, `got ${w?.months}`);
  if (w) {
    const expected = new Date(w.sold_on + "T00:00:00Z");
    expected.setUTCMonth(expected.getUTCMonth() + w.months);
    const expectedStr = expected.toISOString().slice(0, 10);
    check(`warranty expires ${expectedStr}`, w.expires_on === expectedStr, `got ${w.expires_on}`);
    check("warranty linked to sale + customer", w.sale_id === saleId && !!w.customer_id);
  }
}
{
  const { data: moves } = await owner.from("stock_movements").select("*").eq("sale_id", saleId);
  check(
    "ledger: 2 sale rows (part −2, engine −1) at the shop",
    moves?.length === 2 && moves.every((m) => m.shop_id === A.id && m.movement_type === "sale"),
    `got ${moves?.length}`
  );
}
{
  // Cost is mutable, so approval freezes it (0038: owner-only table, never on
  // sale_lines — employees can read their own lines).
  const { data: costs } = await owner.from("sale_line_costs")
    .select("sale_line_id, unit_cost_centavos, line_cost_centavos").eq("sale_id", saleId);
  const total = (costs ?? []).reduce((t, c) => t + c.line_cost_centavos, 0);
  check("COGS frozen for both lines at approval", costs?.length === 2, `got ${costs?.length}`);
  check(
    `COGS total = ${P(2 * COST + ENGINE_COST)} (2×${P(COST)} + ${P(ENGINE_COST)})`,
    total === 2 * COST + ENGINE_COST,
    `got ${total}`
  );
}
{
  const { error } = await owner.rpc("fn_approve_sale", { p_sale_id: saleId, p_note: null });
  check("double-approve rejected", !!error && /already reviewed/i.test(error.message), error?.message);
}

section("Approve the loss (1 nasira):");
{
  const { error } = await owner.rpc("fn_approve_loss", { p_loss_id: lossId, p_note: null });
  check("fn_approve_loss succeeded", !error, error?.message);
}
check("shop stock 3 → 2", (await shopQty(part.id)) === 2, `got ${await shopQty(part.id)}`);
{
  const { data: l } = await owner.from("losses").select("status, value_centavos").eq("id", lossId).single();
  check(
    `loss approved, valued at cost (${P(COST)})`,
    l?.status === "approved" && l?.value_centavos === COST,
    `got ${l?.value_centavos}`
  );
}

section("Negative-stock guard (approve 4 when only 2 left):");
{
  const { error } = await owner.rpc("fn_approve_sale", { p_sale_id: overSaleId, p_note: null });
  check("guard blocks approval", !!error && /negative/i.test(error.message), error?.message);
  const { data: s } = await owner.from("sales").select("status").eq("id", overSaleId).single();
  check("over-sale still pending (nothing partial)", s?.status === "pending", s?.status);
  check("stock unchanged (still 2)", (await shopQty(part.id)) === 2);
  const { data: costs } = await owner.from("sale_line_costs").select("sale_line_id").eq("sale_id", overSaleId);
  check("a blocked approval stamps no COGS", (costs ?? []).length === 0, `got ${costs?.length}`);
}

section("Question → employee sees the note → reject:");
{
  const { error } = await owner.rpc("fn_review_submission", {
    p_kind: "sale", p_id: overSaleId, p_action: "question",
    p_note: `ZZ-TEST Bakit apat? Dalawa na lang natira. ${RUN}`,
  });
  check("question sent", !error, error?.message);
  const { data: s } = await emp1.from("sales").select("status, owner_note").eq("id", overSaleId).single();
  check("employee sees questioned + note", s?.status === "questioned" && /Bakit/.test(s?.owner_note ?? ""));
}
{
  const { error } = await owner.rpc("fn_review_submission", {
    p_kind: "sale", p_id: overSaleId, p_action: "question", p_note: "   ",
  });
  check("a question with no note is rejected", !!error && /note/i.test(error.message), error?.message);
}
{
  const { error } = await owner.rpc("fn_review_submission", {
    p_kind: "sale", p_id: overSaleId, p_action: "reject", p_note: `ZZ-TEST Hindi tama ang bilang. ${RUN}`,
  });
  check("reject after question works", !error, error?.message);
  const { data: s } = await owner.from("sales").select("status, reviewed_at").eq("id", overSaleId).single();
  check("sale rejected + reviewed_at", s?.status === "rejected" && !!s?.reviewed_at);
  check("stock still 2 (rejection moves nothing)", (await shopQty(part.id)) === 2);
}
{
  const { error } = await owner.rpc("fn_review_submission", {
    p_kind: "sale", p_id: overSaleId, p_action: "question", p_note: "too late",
  });
  check("cannot question a rejected sale", !!error && /already reviewed/i.test(error.message), error?.message);
}

section("Realtime publication:");
{
  // Node must set realtime auth explicitly (browsers do it from the session).
  const { data: { session } } = await owner.auth.getSession();
  await owner.realtime.setAuth(session.access_token);

  const received = new Promise((resolve) => {
    const ch = owner
      .channel(`zz-approvals-rt-${RUN}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "losses" }, (payload) => {
        resolve(payload.new?.note ?? true);
        owner.removeChannel(ch);
      })
      .subscribe();
  });
  await new Promise((r) => setTimeout(r, 2500)); // let the socket settle

  await emp1.rpc("fn_record_loss", {
    p_part_id: part.id, p_engine_id: null, p_qty: 1,
    p_reason: "correction", p_note: `ZZ-TEST realtime ping ${RUN}`,
  });
  const result = await Promise.race([
    received,
    new Promise((r) => setTimeout(() => r(null), 10_000)),
  ]);
  check("owner receives INSERT push over Realtime", result !== null, "no event within 10s");
}

section("Cleanup:");
await cleanup();
summary();
