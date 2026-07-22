/**
 * Custom product / engine with an OPTIONAL supplier (0059).
 *
 * A supplier-less "Add product" is a supplier-less receiving: catalog row +
 * stock + a `received` ledger movement, but NO supplier, NO debt, NO payable.
 * The 0049 lockdown is intact (proved in test-catalog-lock) — creation still
 * only via fn_receive_stock. Proves: no-debt path, > cost rule, opening qty 0,
 * preferred-supplier attribution (no debt), engines, and reconciliation.
 *
 * Run: node scripts/test-custom-product.mjs
 */
import {
  owner, admin, check, section, summary, cleanup,
  seedSupplier, firstCategoryId, trackPart, trackEngine, trackEngineModel, RUN,
} from "./_harness.mjs";

const catId = await firstCategoryId();
const supplier = await seedSupplier({ label: "CustAttr" });

const masterQty = async (partId) =>
  (await owner.from("stock_levels").select("qty").eq("part_id", partId)
    .is("shop_id", null).maybeSingle()).data?.qty ?? 0;
const movementSum = async (partId) =>
  ((await owner.from("stock_movements").select("qty_change").eq("part_id", partId)).data ?? [])
    .reduce((s, m) => s + m.qty_change, 0);

// ── 1. Custom part, NO supplier, real opening stock ─────────────────────────
section("Custom part with no supplier — stock enters, no debt");
{
  const { data: rid, error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null,
    p_note: `ZZ-TEST custom ${RUN}`,
    p_parts: [{
      qty: 5,
      unit_cost_centavos: 1200,
      new_part: {
        name: `ZZ-TEST Custom Part ${RUN}`,
        category_id: catId,
        price_centavos: 2000,
        unit: "pc",
        generate_barcode: true,
      },
    }],
  });
  check("supplier-less receiving succeeds", !error, error?.message);

  const { data: part } = await owner
    .from("parts")
    .select("id, cost_centavos, price_centavos, category_id, preferred_supplier_id, barcode")
    .eq("name", `ZZ-TEST Custom Part ${RUN}`).maybeSingle();
  trackPart(part?.id);
  check("catalog row created with owner cost + price", part?.cost_centavos === 1200 && part?.price_centavos === 2000);
  check("category applied", part?.category_id === catId);
  check("no preferred supplier (No supplier picked)", part?.preferred_supplier_id === null);
  check("internal barcode minted (GT…)", /^GT\d{8}$/.test(part?.barcode ?? ""));

  check("5 units landed in master stock", (await masterQty(part.id)) === 5);
  const { data: mv } = await owner
    .from("stock_movements").select("movement_type, qty_change").eq("part_id", part.id);
  check("one `received` movement of +5", mv?.length === 1 && mv[0].movement_type === "received" && mv[0].qty_change === 5);
  check("RECONCILES: Σ movements = master stock", (await movementSum(part.id)) === (await masterQty(part.id)));

  const { data: rcv } = await owner
    .from("receivings").select("supplier_id, total_amount, amount_paid, payment_status").eq("id", rid).single();
  check("receiving: no supplier, total 0, settled (no debt)",
    rcv?.supplier_id === null && rcv?.total_amount === 0 && rcv?.payment_status === "paid", JSON.stringify(rcv));
}

// ── 2. Opening quantity 0 — register the catalog only ───────────────────────
section("Opening qty 0 registers the catalog, no stock, no movement");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `ZZ-TEST zero ${RUN}`,
    p_parts: [{ qty: 0, unit_cost_centavos: 800,
      new_part: { name: `ZZ-TEST Zero Part ${RUN}`, price_centavos: 1500 } }],
  });
  check("qty 0 accepted", !error, error?.message);
  const { data: part } = await owner
    .from("parts").select("id").eq("name", `ZZ-TEST Zero Part ${RUN}`).maybeSingle();
  trackPart(part?.id);
  check("catalog row exists with 0 opening stock", !!part && (await masterQty(part.id)) === 0);
  const { data: mv } = await owner.from("stock_movements").select("id").eq("part_id", part.id);
  check("no ledger movement for a 0-qty add", (mv ?? []).length === 0);
}

// ── 3. Selling price must be > cost ─────────────────────────────────────────
section("Unified pricing: selling price must exceed cost");
{
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `ZZ-TEST atcost ${RUN}`,
    p_parts: [{ qty: 1, unit_cost_centavos: 2000,
      new_part: { name: `ZZ-TEST AtCost ${RUN}`, price_centavos: 2000 } }],
  });
  check("price = cost rejected", !!error && /above cost/i.test(error.message), error?.message);
}

// ── 4. Attribution supplier: preferred only, never a payable ────────────────
section("Picking a supplier = attribution (preferred), no debt");
{
  const before = await owner.rpc("fn_supplier_outstanding", { p_supplier_id: supplier.id });
  const { data: rid } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null,  // still supplier-LESS receiving (no debt)
    p_note: `ZZ-TEST attr ${RUN}`,
    p_parts: [{ qty: 2, unit_cost_centavos: 1000,
      new_part: { name: `ZZ-TEST Attr Part ${RUN}`, price_centavos: 1800,
        preferred_supplier_id: supplier.id } }],
  });
  const { data: part } = await owner
    .from("parts").select("id, preferred_supplier_id").eq("name", `ZZ-TEST Attr Part ${RUN}`).maybeSingle();
  trackPart(part?.id);
  check("attribution supplier stamped as PREFERRED", part?.preferred_supplier_id === supplier.id);
  const { data: rcv } = await owner.from("receivings").select("supplier_id").eq("id", rid).single();
  check("the receiving still has NO supplier (no invoice)", rcv?.supplier_id === null);
  const after = await owner.rpc("fn_supplier_outstanding", { p_supplier_id: supplier.id });
  check("supplier outstanding UNCHANGED — no payable created", (after.data ?? 0) === (before.data ?? 0));
  const { data: pays } = await owner
    .from("supplier_payments").select("id").eq("supplier_id", supplier.id);
  check("no supplier_payments row for the attribution supplier", (pays ?? []).length === 0);
}

// ── 5. Custom engine, no supplier ───────────────────────────────────────────
section("Custom engine with no supplier — one serial in master, no debt");
{
  const serial = `ZZ-TEST-CUST-${RUN}`;
  const { data: rid, error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: null, p_note: `ZZ-TEST cust-eng ${RUN}`,
    p_engines: [{
      serial_number: serial, condition: "second_hand",
      cost_centavos: 300000, price_centavos: 420000, warranty_months: 6,
      new_model: { brand: "ZZ-TEST", model: `Cust-${RUN}`, horsepower: 15, default_warranty_months: 12 },
    }],
  });
  check("supplier-less engine receiving succeeds", !error, error?.message);
  const { data: eng } = await owner
    .from("engines").select("id, engine_model_id, status, condition, cost_centavos, price_centavos, warranty_months")
    .eq("serial_number", serial).maybeSingle();
  trackEngine(eng?.id);
  trackEngineModel(eng?.engine_model_id);
  check("engine born in master, second-hand, cost/price/warranty set",
    eng?.status === "in_master" && eng?.condition === "second_hand" &&
    eng?.cost_centavos === 300000 && eng?.price_centavos === 420000 && eng?.warranty_months === 6);
  const { data: mv } = await owner
    .from("stock_movements").select("movement_type, qty_change").eq("engine_id", eng.id);
  check("one `received` movement of +1", mv?.length === 1 && mv[0].qty_change === 1);
  const { data: rcv } = await owner.from("receivings").select("supplier_id, total_amount").eq("id", rid).single();
  check("engine receiving: no supplier, total 0", rcv?.supplier_id === null && rcv?.total_amount === 0);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────
section("Cleanup:");
await cleanup();
summary();
