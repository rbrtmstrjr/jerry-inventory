/**
 * Shop recording — employees RECORD; they never MOVE stock.
 *
 * Verifies:
 *   • fn_record_sale / fn_record_loss save as `recorded` — invisible to the
 *     owner until the shop submits its batch
 *   • part prices are catalog-authoritative (a client-sent price is ignored)
 *   • recording deducts NO stock and does not mark the engine sold
 *   • shop scoping: a shop cannot sell/write off another shop's stock, and the
 *     owner is not a recording role
 *   • a shop can cancel its own recorded items; another shop cannot
 *
 * Provisions its own two shops — it must never write into a real branch.
 *
 * Run: node scripts/test-shop-recording.mjs
 */
import {
  owner, RUN, P, check, section, summary,
  provisionShop, seedPart, seedEngineModel, receive, deliverAndConfirm,
  trackCustomer, cleanup,
} from "./_harness.mjs";

const A = await provisionShop("Recording A");
const B = await provisionShop("Recording B");
const emp1 = A.client;
const emp2 = B.client;

const PART_PRICE = 25_000;      // ₱250
const ENGINE_PRICE = 3_800_000; // ₱38,000
const SERIAL = `ZZ-SALE-${RUN}`;

section("Setup (as owner):");
const part = await seedPart({ label: "Spark Plug", cost: 12_000, price: PART_PRICE });
// Never received/delivered anywhere — the "not at your shop" fixture.
const undelivered = await seedPart({ label: "Undelivered", cost: 100, price: 200 });
const model = await seedEngineModel({ brand: "ZZ-TEST", model: "15MH", hp: 15 });

await receive({
  parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: 12_000 }],
  engines: [{
    serial_number: SERIAL, engine_model_id: model.id, condition: "brand_new",
    cost_centavos: 3_000_000, price_centavos: ENGINE_PRICE, warranty_months: null,
  }],
});
const { data: engine } = await owner
  .from("engines").select("id").eq("serial_number", SERIAL).single();
check("engine received into master", !!engine?.id);

await deliverAndConfirm(A, { parts: [{ part_id: part.id, qty: 6 }], engine_ids: [engine.id] });
{
  const { data } = await emp1.from("shop_stock").select("qty").eq("part_id", part.id).single();
  check("6 pcs + engine delivered to shop A and confirmed", data?.qty === 6, `got ${data?.qty}`);
}

section("Record a sale (employee, shop A):");
const { data: saleId, error: saleErr } = await emp1.rpc("fn_record_sale", {
  p_customer_id: null,
  p_customer: { name: `ZZ-TEST Mang Kanor ${RUN}`, phone: "0917-111-2222" },
  // unit_price_centavos is deliberate noise: the RPC reads only {part_id, qty}
  // and resolves the price from the catalog, so this ₱0.01 must be ignored.
  p_part_lines: [{ part_id: part.id, qty: 2, unit_price_centavos: 1 }],
  p_engine_lines: [{ engine_id: engine.id, agreed_price_centavos: ENGINE_PRICE }],
});
check("fn_record_sale succeeded", !saleErr, saleErr?.message);
{
  const { data: s } = await emp1
    .from("sales")
    .select("status, total_centavos, customer_id, sale_lines(part_id, engine_id, description, qty, unit_price_centavos, line_total_centavos)")
    .eq("id", saleId).single();
  // fn_record_sale creates the customer inline; track it so cleanup reaches it.
  trackCustomer(s?.customer_id);

  check("sale is RECORDED (not yet with the owner)", s?.status === "recorded", s?.status);
  check(
    `total = 2×${P(PART_PRICE)} + ${P(ENGINE_PRICE)} (catalog prices)`,
    s?.total_centavos === 2 * PART_PRICE + ENGINE_PRICE,
    `got ${s?.total_centavos}`
  );
  check("customer captured", !!s?.customer_id);

  const partLine = s?.sale_lines.find((l) => l.part_id === part.id);
  const engLine = s?.sale_lines.find((l) => l.engine_id === engine.id);
  check(
    "client-sent unit price ignored — catalog price wins",
    partLine?.unit_price_centavos === PART_PRICE && partLine?.line_total_centavos === 2 * PART_PRICE,
    `got ${partLine?.unit_price_centavos}`
  );
  check(
    "line descriptions snapshotted",
    !!partLine?.description && /SN/.test(engLine?.description ?? "")
  );
}
{
  const { data } = await emp1.from("shop_stock").select("qty").eq("part_id", part.id).single();
  check("stock NOT deducted (still 6 on hand)", data?.qty === 6, `got ${data?.qty}`);
}
{
  const { data: e } = await owner.from("engines").select("status").eq("id", engine.id).single();
  check("engine still 'delivered' (not sold)", e?.status === "delivered", e?.status);
}

section("Validation:");
{
  const { error } = await emp1.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [], p_engine_lines: [{ engine_id: engine.id }],
  });
  check("engine sale without customer rejected", !!error && /customer/i.test(error.message), error?.message);
}
{
  // The inline customer here is rolled back with the raise — no fixture leaks.
  const { error } = await emp1.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: { name: `ZZ-TEST Dup ${RUN}` },
    p_part_lines: [], p_engine_lines: [{ engine_id: engine.id }],
  });
  check("engine already in an open sale rejected", !!error && /open sale/i.test(error.message), error?.message);
}
{
  const { error } = await emp1.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: undelivered.id, qty: 1 }], p_engine_lines: [],
  });
  check("undelivered item rejected", !!error && /not been delivered/i.test(error.message), error?.message);
}
{
  const { error } = await emp2.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: part.id, qty: 1 }], p_engine_lines: [],
  });
  check("shop B can't sell shop A's stock", !!error && /not been delivered/i.test(error.message), error?.message);
}
{
  const { error } = await emp2.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: { name: `ZZ-TEST Poacher ${RUN}` },
    p_part_lines: [], p_engine_lines: [{ engine_id: engine.id }],
  });
  check("shop B can't sell shop A's engine", !!error && /not at your shop/i.test(error.message), error?.message);
}
{
  const { error } = await owner.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null,
    p_part_lines: [{ part_id: part.id, qty: 1 }], p_engine_lines: [],
  });
  check("owner is not a recording role", !!error && /employee/i.test(error.message), error?.message);
}

section("Record a loss:");
const { data: lossId, error: lossErr } = await emp1.rpc("fn_record_loss", {
  p_part_id: part.id, p_engine_id: null, p_qty: 1,
  p_reason: "nasira", p_note: `ZZ-TEST nabasag ${RUN}`,
});
check("fn_record_loss succeeded", !lossErr, lossErr?.message);
{
  const { data: l } = await emp1
    .from("losses").select("status, reason, description").eq("id", lossId).single();
  check(
    "loss RECORDED, reason nasira, described",
    l?.status === "recorded" && l?.reason === "nasira" && !!l?.description,
    l?.status
  );
}
{
  const { data } = await emp1.from("shop_stock").select("qty").eq("part_id", part.id).single();
  check("recording a loss deducts nothing either (still 6)", data?.qty === 6, `got ${data?.qty}`);
}
{
  const { error } = await emp2.rpc("fn_record_loss", {
    p_part_id: part.id, p_engine_id: null, p_qty: 1, p_reason: "nawala", p_note: "x",
  });
  check("shop B can't report shop A's item", !!error, error?.message);
}

section("Cancel before submitting:");
{
  const { data, error } = await emp1.from("losses").delete().eq("id", lossId).select("id");
  check("employee can cancel own recorded loss", !error && data?.length === 1, error?.message);
}
{
  const { data, error } = await emp2.from("sales").delete().eq("id", saleId).select("id");
  check("other shop cannot cancel the sale", (data ?? []).length === 0 || !!error);
}
{
  const { data, error } = await emp1.from("sales").delete().eq("id", saleId).select("id");
  check("employee can cancel own recorded sale", !error && data?.length === 1, error?.message);
}

section("Cleanup:");
await cleanup();
summary();
