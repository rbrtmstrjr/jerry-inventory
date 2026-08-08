/**
 * 0128–0129 — engine models with no per-unit serial.
 *
 * Gerry buys five identical small engines that share one product code and have
 * no plates. Serialization is a property of the MODEL (0114's
 * units.allows_fractional pattern), so a non-serialized model's receiving line
 * may carry a quantity and the units are numbered UNIT-########.
 *
 * Engines stay ONE ROW PER UNIT — five units are five rows, five
 * receiving_lines at qty 1, and five +1 ledger rows. Warranties and the five
 * qty=1 constraints are untouched, and this suite proves it.
 *
 * Provisions its own fixtures; never touches a real branch.
 */
import {
  owner, admin, check, section, summary, cleanup,
  seedSupplier, seedEngineModel, trackEngine, trackEngineModel, RUN,
} from "./_harness.mjs";

// gate: 0128 must be applied
{
  const { error } = await owner
    .from("engine_models").select("is_serialized").limit(1);
  if (error) {
    console.error(
      "test-engine-nonserial: 0128_engine_model_serialization.sql is not applied — apply 0128–0129 first."
    );
    process.exit(2);
  }
}

const supplier = await seedSupplier({ label: "EngineVendor" });

// a model with no plates, and a normal serialized one as the control
const loose = await seedEngineModel({ brand: "ZZ-TEST Hon", model: "GX35" });
await admin.from("engine_models")
  .update({ is_serialized: false, sku: `ZZ-CODE-${RUN}` }).eq("id", loose.id);
const plated = await seedEngineModel({ brand: "ZZ-TEST Yam", model: "F40" });

section("A non-serialized model takes a quantity");
{
  const { data: rcvId, error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST loose ${RUN}`,
    p_parts: [],
    p_engines: [{
      engine_model_id: loose.id, qty: 5,
      cost_centavos: 500000, price_centavos: 650000,
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("receiving 5 units succeeds", !error && !!rcvId, error?.message);

  const { data: units } = await owner
    .from("engines")
    .select("id, serial_number, status, cost_centavos")
    .eq("engine_model_id", loose.id);
  (units ?? []).forEach((u) => trackEngine(u.id));

  check("five engine ROWS exist, not one row of five",
    units?.length === 5, String(units?.length));
  check("every unit is in_master",
    (units ?? []).every((u) => u.status === "in_master"));
  check("every unit carries the line's cost",
    (units ?? []).every((u) => u.cost_centavos === 500000));

  const nos = (units ?? []).map((u) => u.serial_number);
  check("each is numbered UNIT-########",
    nos.every((s) => /^UNIT-\d{8}$/.test(s)), JSON.stringify(nos));
  check("the five numbers are DISTINCT",
    new Set(nos).size === 5, JSON.stringify(nos));

  // the engine qty=1 CHECK is untouched: one line per unit
  const { data: lines } = await owner
    .from("receiving_lines")
    .select("engine_id, qty, unit_cost_centavos").eq("receiving_id", rcvId);
  check("five receiving lines, each qty 1",
    lines?.length === 5 && lines.every((l) => Number(l.qty) === 1),
    JSON.stringify(lines?.map((l) => l.qty)));

  const ids = (units ?? []).map((u) => u.id);
  const { data: movs } = await owner
    .from("stock_movements").select("engine_id, qty_change").in("engine_id", ids);
  check("five 'received' movements of +1",
    movs?.length === 5 && movs.every((m) => Number(m.qty_change) === 1),
    JSON.stringify(movs?.map((m) => m.qty_change)));

  // v_total must accumulate PER UNIT, not per line — 5 x 500000 = 2500000
  const { data: rcv } = await owner
    .from("receivings").select("total_amount").eq("id", rcvId).maybeSingle();
  check("receiving total is 5 x cost, not 1x",
    Number(rcv?.total_amount) === 2500000, String(rcv?.total_amount));

  const lineSum = (lines ?? [])
    .reduce((s, l) => s + Number(l.qty) * Number(l.unit_cost_centavos), 0);
  check("sum of receiving_lines qty*unit_cost also equals 2500000",
    lineSum === 2500000, String(lineSum));
}

section("A serialized model still refuses a quantity");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST plated qty ${RUN}`,
    p_parts: [],
    p_engines: [{
      engine_model_id: plated.id, qty: 3,
      cost_centavos: 900000, price_centavos: 1200000,
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("qty>1 on a serialized model is refused",
    /serial/i.test(error?.message ?? ""), error?.message ?? "it was ACCEPTED");
  check("the refusal names the model so the office knows which",
    /ZZ-TEST Yam|F40/.test(error?.message ?? ""), error?.message);
}

section("A serialized model still needs a serial per unit");
{
  const serial = `ZZ-TEST-SN-${RUN}`;
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST plated ${RUN}`,
    p_parts: [],
    p_engines: [{
      engine_model_id: plated.id, serial_number: serial,
      cost_centavos: 900000, price_centavos: 1200000,
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("a typed-serial receiving still works", !error, error?.message);

  const { data: u } = await owner
    .from("engines").select("id, serial_number").eq("serial_number", serial).maybeSingle();
  trackEngine(u?.id);
  check("the typed serial is stored verbatim", u?.serial_number === serial);

  const missing = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST plated blank ${RUN}`,
    p_parts: [],
    p_engines: [{ engine_model_id: plated.id, cost_centavos: 1, price_centavos: 2 }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("a serialized model with NO serial is refused",
    /serial/i.test(missing.error?.message ?? ""),
    missing.error?.message ?? "it was ACCEPTED");
}

section("A serial and a quantity together are refused");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST both ${RUN}`,
    p_parts: [],
    p_engines: [{
      engine_model_id: loose.id, serial_number: `ZZ-TEST-X-${RUN}`, qty: 3,
      cost_centavos: 1000, price_centavos: 2000,
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("serial + qty>1 is refused",
    /one serial|cannot describe/i.test(error?.message ?? ""),
    error?.message ?? "it was ACCEPTED");
}

section("A quantity below 1 is refused");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST zero ${RUN}`,
    p_parts: [],
    p_engines: [{ engine_model_id: loose.id, qty: 0, cost_centavos: 1000, price_centavos: 2000 }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("qty 0 is refused",
    /at least one|must be|positive/i.test(error?.message ?? ""),
    error?.message ?? "it was ACCEPTED");
}

section("A quantity over the 500-unit cap is refused");
{
  const { count: before } = await owner
    .from("engines").select("id", { count: "exact", head: true })
    .eq("engine_model_id", loose.id);

  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST typo ${RUN}`,
    p_parts: [],
    p_engines: [{ engine_model_id: loose.id, qty: 501, cost_centavos: 1000, price_centavos: 2000 }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("qty 501 (a typo for 5) is refused",
    /500|cannot receive more/i.test(error?.message ?? ""),
    error?.message ?? "it was ACCEPTED");

  const { count: after } = await owner
    .from("engines").select("id", { count: "exact", head: true })
    .eq("engine_model_id", loose.id);
  check("nothing was created by the refused line",
    after === before, `before=${before} after=${after}`);
}

section("A fractional engine quantity does not silently round");
{
  const { count: before } = await owner
    .from("engines").select("id", { count: "exact", head: true })
    .eq("engine_model_id", loose.id);

  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST fractional ${RUN}`,
    p_parts: [],
    p_engines: [{ engine_model_id: loose.id, qty: 2.6, cost_centavos: 1000, price_centavos: 2000 }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("qty 2.6 is refused, not silently rounded to 2 or 3",
    !!error, error ? error.message : "it was ACCEPTED — engine qty must be int, never numeric");

  const { count: after } = await owner
    .from("engines").select("id", { count: "exact", head: true })
    .eq("engine_model_id", loose.id);
  check("no units were created from a fractional qty",
    after === before, `before=${before} after=${after}`);
}

section("An inline new model can be created non-serialized");
{
  const code = `ZZ-INLINE-${RUN}`;
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST inline ${RUN}`,
    p_parts: [],
    p_engines: [{
      qty: 2, cost_centavos: 300000, price_centavos: 400000,
      new_model: {
        brand: "ZZ-TEST Inline", model: `NS-${RUN}`,
        is_serialized: false, sku: code, default_warranty_months: 6,
      },
    }],
    p_payment_status: "unpaid",
    p_amount_paid: 0,
  });
  check("an inline non-serialized model + 2 units succeeds", !error, error?.message);

  const { data: m } = await owner
    .from("engine_models").select("id, is_serialized, sku")
    .eq("model", `NS-${RUN}`).maybeSingle();
  // fn_receive_stock, not a seed helper, created this model — nothing else
  // tracks it, so track it here or cleanup() strands it in staging.
  if (m?.id) trackEngineModel(m.id);

  if (!m) {
    check("the inline model exists to inspect (receiving above must have failed)",
      false, "no engine_models row found for NS-" + RUN + " — skipping the rest of this section");
  } else {
    check("the model was created non-serialized", m.is_serialized === false);
    check("and carries the shared code", m.sku === code, m.sku);

    const { data: units } = await owner
      .from("engines").select("id").eq("engine_model_id", m.id);
    (units ?? []).forEach((u) => trackEngine(u.id));
    check("two units were created", units?.length === 2, String(units?.length));
  }
}

section("A non-serialized unit sells and warrants like any other");
{
  const { provisionShop, deliverAndConfirm } = await import("./_harness.mjs");
  const shop = await provisionShop("NonSerial");

  const { data: avail } = await owner
    .from("engines").select("id").eq("engine_model_id", loose.id)
    .eq("status", "in_master").limit(1);

  if (!avail?.length) {
    check("an in_master unit of the loose model exists to sell (section 1 above must have failed)",
      false, "no in_master engine found for the loose model — skipping the rest of this section");
    await cleanup();
    summary();
  }
  const unit = avail[0].id;

  await deliverAndConfirm(shop, { engine_ids: [unit] });

  const sale = await shop.client.rpc("fn_record_sale", {
    p_customer_id: null,
    p_customer: { name: `ZZ-TEST Buyer ${RUN}` },
    p_part_lines: [],
    p_engine_lines: [{ engine_id: unit }],
    p_payment_type: "full",
    p_amount_paid_centavos: null,
    p_payment_method: "cash",
  });
  check("a non-serialized unit records as a sale", !sale.error && !!sale.data,
    sale.error?.message);

  const appr = await owner.rpc("fn_approve_sale", { p_sale_id: sale.data, p_note: null });
  check("it approves", !appr.error, appr.error?.message);

  const { data: w } = await owner
    .from("warranties").select("id, engine_id").eq("engine_id", unit).maybeSingle();
  check("a warranty was created for THAT unit", !!w,
    "one row per unit is what makes this possible");
}

await cleanup();
summary();
