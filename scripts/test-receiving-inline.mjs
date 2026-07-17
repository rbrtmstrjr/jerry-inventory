/**
 * 0048 — Receiving as the single entry point.
 *
 * Verifies fn_receive_stock's inline product creation: a brand-new part or
 * engine model is created AND stocked in one atomic call, with the existing
 * payment / due-date / credit-limit behavior intact, and cost data still
 * unreachable from a shop session.
 */
import {
  owner, admin, check, section, summary, cleanup,
  provisionShop, seedSupplier, seedPart, firstCategoryId,
  trackPart, trackEngine, trackEngineModel, RUN,
} from "./_harness.mjs";

const shop = await provisionShop("RcvInline");
const supplier = await seedSupplier({
  label: "RcvInline",
  credit_limit: 100000, // ₱1,000
  payment_terms_days: 30,
});
const categoryId = await firstCategoryId();

const rcvLines = (id) =>
  owner.from("receiving_lines").select("part_id, engine_id, qty, unit_cost_centavos").eq("receiving_id", id);

// ── 1. brand-new part: created + stocked in ONE call ─────────────────────────
section("Inline new part");
{
  const name = `ZZ-TEST Inline Filter ${RUN}`;
  const { data: rcvId, error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST inline ${RUN}`,
    p_parts: [{
      qty: 7,
      unit_cost_centavos: 5000,
      new_part: {
        name,
        category_id: categoryId,
        unit: "pc",
        generate_barcode: true,
        price_centavos: 9000,
        reorder_level: 3,
      },
    }],
    p_engines: [],
  });
  check("receiving with a new_part line succeeds", !error, error?.message);

  const { data: part } = await owner
    .from("parts").select("*").eq("name", name).maybeSingle();
  trackPart(part?.id);
  check("part was created", !!part);
  check("catalog cost = first purchase cost", part?.cost_centavos === 5000);
  check("selling price stored", part?.price_centavos === 9000);
  check("reorder level stored", part?.reorder_level === 3);
  check("generated barcode is JM-sequence", /^JM\d{8}$/.test(part?.barcode ?? ""));
  check(
    "preferred supplier defaults to the receiving's supplier",
    part?.preferred_supplier_id === supplier.id
  );

  const { data: lvl } = await owner
    .from("stock_levels").select("qty").eq("part_id", part.id).is("shop_id", null).maybeSingle();
  check("master stock = received qty", lvl?.qty === 7);

  const { data: mv } = await owner
    .from("stock_movements").select("movement_type, qty_change, shop_id").eq("part_id", part.id);
  check(
    "one 'received' ledger row at master",
    mv?.length === 1 && mv[0].movement_type === "received" &&
      mv[0].qty_change === 7 && mv[0].shop_id === null
  );

  const { data: lines } = await rcvLines(rcvId);
  check("receiving line written", lines?.length === 1 && lines[0].qty === 7);

  const { data: hist } = await owner
    .from("supplier_product_prices_history")
    .select("unit_cost_centavos").eq("part_id", part.id).eq("supplier_id", supplier.id).maybeSingle();
  check("last-paid history exists for supplier × new part", hist?.unit_cost_centavos === 5000);
}

// ── 2. inline new engine model + serials ─────────────────────────────────────
section("Inline new engine model");
{
  const newModel = {
    brand: "ZZ-TEST",
    model: `Inline-EM-${RUN}`,
    horsepower: 15,
    default_warranty_months: 12,
  };
  const { data: rcvId, error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST inline-eng ${RUN}`,
    p_parts: [],
    p_engines: [
      { serial_number: `ZZ-${RUN}-A1`, cost_centavos: 40000, price_centavos: 52000, new_model: newModel },
      { serial_number: `ZZ-${RUN}-A2`, cost_centavos: 40000, price_centavos: 52000, new_model: newModel },
    ],
  });
  check("receiving with new_model engine lines succeeds", !error, error?.message);

  const { data: models } = await owner
    .from("engine_models").select("id").eq("brand", "ZZ-TEST").eq("model", newModel.model);
  (models ?? []).forEach((m) => trackEngineModel(m.id));
  check("two serials of one new model create exactly ONE model", models?.length === 1);

  const { data: engines } = await owner
    .from("engines").select("id, status, engine_model_id").like("serial_number", `ZZ-${RUN}-A%`);
  (engines ?? []).forEach((e) => trackEngine(e.id));
  check(
    "both serials exist in master",
    engines?.length === 2 && engines.every((e) => e.status === "in_master")
  );
  const { data: lines } = await rcvLines(rcvId);
  check("one receiving line per serial", lines?.length === 2);
}

// ── 3. atomicity: one bad line rolls back EVERYTHING ─────────────────────────
section("Atomicity");
{
  const name = `ZZ-TEST Ghost Part ${RUN}`;
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST atomic ${RUN}`,
    p_parts: [{
      qty: 5, unit_cost_centavos: 1000,
      new_part: { name, category_id: categoryId, price_centavos: 2000 },
    }],
    // missing serial → must abort the whole call
    p_engines: [{ serial_number: "  ", cost_centavos: 1000 }],
  });
  check("missing serial rejects the receiving", !!error, "expected an error");

  const { data: ghost } = await owner.from("parts").select("id").eq("name", name);
  check("NO product was created by the failed receiving", (ghost ?? []).length === 0);
  const { data: rcv } = await owner
    .from("receivings").select("id").like("note", `%atomic ${RUN}%`);
  check("NO receiving row survives the failed call", (rcv ?? []).length === 0);
}

// ── 4. duplicate barcode / duplicate serial → clean error + rollback ─────────
section("Uniqueness errors");
{
  const existing = await seedPart({ label: "BarcodeOwner" });
  const { data: withBarcode } = await owner
    .from("parts").update({ barcode: `ZZBC-${RUN}` }).eq("id", existing.id).select().single();
  check("fixture barcode set", withBarcode?.barcode === `ZZBC-${RUN}`);

  const name = `ZZ-TEST Dup Barcode ${RUN}`;
  const { error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST dup-bc ${RUN}`,
    p_parts: [{
      qty: 1, unit_cost_centavos: 100,
      new_part: { name, barcode: `ZZBC-${RUN}`, price_centavos: 200 },
    }],
    p_engines: [],
  });
  check("duplicate barcode raises the friendly error", /already in use/.test(error?.message ?? ""));
  const { data: ghost } = await owner.from("parts").select("id").eq("name", name);
  check("duplicate-barcode receiving fully rolled back", (ghost ?? []).length === 0);

  const { error: dupSerial } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST dup-sn ${RUN}`,
    p_parts: [],
    p_engines: [{
      serial_number: `ZZ-${RUN}-A1`, cost_centavos: 100, price_centavos: 200,
      new_model: { brand: "ZZ-TEST", model: `Inline-EM-${RUN}` },
    }],
  });
  check("duplicate serial raises the friendly error", /already exists/.test(dupSerial?.message ?? ""));
}

// ── 5. payment: the PICKED due date wins over supplier terms ─────────────────
section("Payment & due date");
{
  const picked = "2027-03-31"; // nothing like today+30
  const { data: rcvId, error } = await owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST due ${RUN}`,
    p_parts: [{
      qty: 2, unit_cost_centavos: 10000,
      new_part: { name: `ZZ-TEST Due Part ${RUN}`, price_centavos: 15000 },
    }],
    p_engines: [],
    p_payment_status: "partial",
    p_amount_paid: 5000,
    p_due_date: picked,
  });
  check("partial receiving succeeds", !error, error?.message);
  const { data: p } = await owner
    .from("parts").select("id").eq("name", `ZZ-TEST Due Part ${RUN}`).maybeSingle();
  trackPart(p?.id);

  const { data: rcv } = await owner
    .from("receivings")
    .select("total_amount, amount_paid, payment_status, due_date, settled_at")
    .eq("id", rcvId).single();
  check("total computed", rcv?.total_amount === 20000);
  check("amount paid recorded", rcv?.amount_paid === 5000);
  check("status = partial", rcv?.payment_status === "partial");
  check("due date is the PICKED date, not terms-derived", rcv?.due_date === picked);
  check("not settled while a balance remains", rcv?.settled_at === null);

  const { data: bal } = await owner.rpc("fn_receiving_balance", { p_receiving_id: rcvId });
  check("computed balance = total − paid", bal === 15000);
}

// ── 6. credit limit: warn + audited override, never a silent block ───────────
section("Credit limit");
{
  const mk = (over, reason) => owner.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST limit ${RUN}`,
    p_parts: [{
      qty: 1, unit_cost_centavos: 500000, // ₱5,000 unpaid vs ₱1,000 limit
      new_part: { name: `ZZ-TEST Limit Part ${RUN}-${over}-${!!reason}`, price_centavos: 600000 },
    }],
    p_engines: [],
    p_payment_status: "unpaid",
    p_due_date: "2027-01-31",
    p_override: over,
    p_override_reason: reason,
  });

  const { error: blocked } = await mk(false, null);
  check("over-limit without override raises CREDIT_LIMIT_EXCEEDED",
    /CREDIT_LIMIT_EXCEEDED/.test(blocked?.message ?? ""));

  const { error: noReason } = await mk(true, "  ");
  check("override without a reason is rejected", /needs a reason/.test(noReason?.message ?? ""));

  const { data: okId, error: allowed } = await mk(true, "Peak season restock — approved by phone");
  check("override with a reason proceeds", !allowed, allowed?.message);
  const { data: aud } = await owner
    .from("receivings")
    .select("limit_override, limit_override_reason, limit_override_by, limit_override_at")
    .eq("id", okId).single();
  check("override audited (flag/reason/by/at)",
    aud?.limit_override === true && !!aud?.limit_override_reason &&
      !!aud?.limit_override_by && !!aud?.limit_override_at);

  const { data: made } = await owner
    .from("parts").select("id").like("name", `ZZ-TEST Limit Part ${RUN}%`);
  (made ?? []).forEach((x) => trackPart(x.id));
  check("only the allowed attempt created its product", (made ?? []).length === 1);
}

// ── 7. reconciliation invariant over this run's parts ────────────────────────
section("Reconciliation invariant");
{
  const { data: runParts } = await owner
    .from("parts").select("id").like("name", `%${RUN}%`);
  const ids = (runParts ?? []).map((p) => p.id);
  const { data: lvls } = await owner
    .from("stock_levels").select("qty").in("part_id", ids);
  const { data: transit } = await owner
    .from("stock_in_transit").select("qty").in("part_id", ids);
  const onHand = (lvls ?? []).reduce((s, l) => s + l.qty, 0);
  const inTransit = (transit ?? []).reduce((s, l) => s + l.qty, 0);
  // owned = everything received in this run and never sold/lost/written off:
  // 7 (inline part) + 2 (due-date part) + 1 (allowed over-limit part) = 10.
  // The atomicity part's 5 must NOT be here — its receiving rolled back.
  check("stock_levels + in_transit = total owned (7 + 2 + 1 = 10)", onHand + inTransit === 10,
    `on-hand ${onHand} + transit ${inTransit}`);
}

// ── 8. RLS: a shop session gets NOTHING here ─────────────────────────────────
section("RLS");
{
  const { error } = await shop.client.rpc("fn_receive_stock", {
    p_supplier_id: supplier.id,
    p_note: `ZZ-TEST rls ${RUN}`,
    p_parts: [{ qty: 1, unit_cost_centavos: 100, new_part: { name: `ZZ-TEST RLS ${RUN}` } }],
    p_engines: [],
  });
  check("employee cannot receive stock", /owner/i.test(error?.message ?? ""), error?.message);

  const { data: hist } = await shop.client
    .from("supplier_product_prices_history").select("*").limit(5);
  check("employee sees ZERO last-paid history rows", (hist ?? []).length === 0);
  const { data: cmp } = await shop.client
    .from("supplier_price_comparison").select("*").limit(5);
  check("employee sees ZERO price-comparison rows", (cmp ?? []).length === 0);
  const { data: base } = await shop.client.from("parts").select("cost_centavos").limit(5);
  check("employee cannot read parts (base table)", (base ?? []).length === 0);
}

await cleanup();
summary();
