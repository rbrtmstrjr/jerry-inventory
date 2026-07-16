/**
 * Receiving verification — stock into master, the append-only ledger, receiving
 * lines + costs, owner-only guards, internal barcodes.
 *
 * Also pins the payment default: a receiving with no payment args is `paid`, so
 * plain stock intake can never invent supplier debt. (Deep payables coverage
 * lives in test-supplier-payables.mjs.)
 *
 * Provisions its own shop + employee — the employee exists only to prove the
 * owner-only guards — and hard-cleans everything it made.
 *
 * Run: node scripts/test-receiving.mjs
 */
import {
  owner, RUN, P, check, section, summary,
  provisionShop, seedPart, seedEngineModel, seedSupplier, receive, cleanup,
} from "./_harness.mjs";

const SHOP = await provisionShop("Receiving");
const emp = SHOP.client;
const SERIAL = `ZZ-TEST-RCV-${RUN}`;

const masterQty = async (partId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId)
    .is("shop_id", null).maybeSingle()).data?.qty ?? 0;

section("Setup (as owner):");
const part = await seedPart({ label: "Fuel Hose", cost: 5000, price: 9000 });
check("test part created", !!part.id);
const model = await seedEngineModel({ brand: "RCV", model: "DT15AS", hp: 15 });
check("engine model created", !!model.id);
const supplier = await seedSupplier({ label: "Marine Supply Co", contact: "0917-000-0000" });
check("supplier created", !!supplier.id);

section("Supplier + receiving:");
// Received at ₱48 while the catalog cost is ₱50 — the gap is what proves below
// that receiving records its own line cost and does NOT rewrite the catalog.
const rcvId = await receive({
  supplier_id: supplier.id,
  parts: [{ part_id: part.id, qty: 24, unit_cost_centavos: 4800 }],
  engines: [{
    serial_number: SERIAL,
    engine_model_id: model.id,
    condition: "brand_new",
    cost_centavos: 4_500_000,
    price_centavos: 5_600_000,
    warranty_months: null,
  }],
});
check("fn_receive_stock succeeded", !!rcvId);
check("master stock = 24", (await masterQty(part.id)) === 24);

const { data: eng } = await owner
  .from("engines").select("id, status, cost_centavos").eq("serial_number", SERIAL).single();
check("engine created in_master", eng?.status === "in_master");

{
  const { data: moves } = await owner
    .from("stock_movements")
    .select("movement_type, part_id, engine_id, qty_change, shop_id")
    .eq("receiving_id", rcvId);
  check("ledger: 2 movement rows", moves?.length === 2, `got ${moves?.length}`);
  const pm = moves?.find((m) => m.part_id === part.id);
  const em = moves?.find((m) => m.engine_id === eng?.id);
  check("ledger: part +24 into master",
    pm?.qty_change === 24 && pm?.shop_id === null && pm?.movement_type === "received");
  check("ledger: engine +1 into master",
    em?.qty_change === 1 && em?.shop_id === null && em?.movement_type === "received");
}
{
  const { data: lines } = await owner
    .from("receiving_lines").select("part_id, engine_id, qty, unit_cost_centavos")
    .eq("receiving_id", rcvId);
  check("receiving has 2 lines", lines?.length === 2, `got ${lines?.length}`);
  const pl = lines?.find((l) => l.part_id === part.id);
  check("line carries what this batch actually cost (₱48)", pl?.unit_cost_centavos === 4800,
    `got ${pl?.unit_cost_centavos}`);
  const el = lines?.find((l) => l.engine_id === eng?.id);
  check("engine line: qty 1 at its own cost", el?.qty === 1 && el?.unit_cost_centavos === 4_500_000);
}
{
  // A cheaper batch must not silently reprice the catalog — cost_centavos is the
  // owner's standing figure, receiving_lines is the per-batch history.
  const { data } = await owner.from("parts").select("cost_centavos").eq("id", part.id).single();
  check("receiving does NOT mutate parts.cost_centavos", data?.cost_centavos === 5000,
    `got ${data?.cost_centavos}`);
}

section("Payment defaults — intake creates no phantom debt:");
{
  const { data: r } = await owner
    .from("receivings").select("total_amount, amount_paid, payment_status, due_date, settled_at")
    .eq("id", rcvId).single();
  const expected = 24 * 4800 + 4_500_000;
  check("total = 24×₱48 + engine ₱45,000", Number(r?.total_amount) === expected,
    `got ${P(Number(r?.total_amount))}`);
  check("defaults to paid in full", r?.payment_status === "paid" && Number(r?.amount_paid) === expected);
  check("nothing owed → no due date, settled", r?.due_date === null && !!r?.settled_at);
  const { data: out } = await owner.rpc("fn_supplier_outstanding", { p_supplier_id: supplier.id });
  check("supplier is owed 0", Number(out) === 0, `owed ${P(Number(out))}`);
}

section("Second receiving accumulates:");
{
  const id2 = await receive({
    parts: [{ part_id: part.id, qty: 6, unit_cost_centavos: 5000 }],
  });
  check("second receiving ok", !!id2);
  check("master stock = 30", (await masterQty(part.id)) === 30);
}

section("Validation & security:");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `ZZ-TEST bad ${RUN}`,
    p_parts: [{ part_id: part.id, qty: -5, unit_cost_centavos: 0 }], p_engines: [],
  });
  check("negative qty rejected", !!error, error?.message);
}
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `ZZ-TEST empty ${RUN}`, p_parts: [], p_engines: [],
  });
  check("empty receiving rejected", !!error, error?.message);
}
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `ZZ-TEST noserial ${RUN}`, p_parts: [],
    p_engines: [{ serial_number: "  ", engine_model_id: model.id }],
  });
  check("engine without a serial rejected", !!error, error?.message);
}
{
  // a rejected receiving must leave stock exactly where it was
  check("failed receivings changed nothing (master still 30)", (await masterQty(part.id)) === 30);
}
{
  const { error } = await emp.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: "sneaky",
    p_parts: [{ part_id: part.id, qty: 5, unit_cost_centavos: 0 }], p_engines: [],
  });
  check("EMPLOYEE cannot receive stock", !!error && /owner/i.test(error.message), error?.message);
}
{
  const { error } = await emp.rpc("fn_generate_internal_barcode", { p_part_id: part.id });
  check("EMPLOYEE cannot generate barcodes", !!error && /owner/i.test(error.message), error?.message);
}

section("Internal barcode:");
{
  const { data: code, error } = await owner.rpc("fn_generate_internal_barcode", { p_part_id: part.id });
  check("barcode generated (JM########)", !error && /^JM\d{8}$/.test(code),
    error?.message ?? `got ${code}`);
  const { data: again } = await owner.rpc("fn_generate_internal_barcode", { p_part_id: part.id });
  check("idempotent: same code returned", again === code, `${again} vs ${code}`);
  const { data: p } = await owner.from("parts").select("barcode").eq("id", part.id).single();
  check("barcode persisted on the part", p?.barcode === code);
}

section("Cleanup:");
await cleanup();
summary();
