/**
 * 0053 — Unified pricing: one selling price for every product, editable at
 * sale, floored at COST (strictly greater). Replaces the engine 3-tier margin
 * suite. Also proves cost is now visible-but-read-only to a shop for its OWN
 * on-hand stock, and that no engine tier remains.
 */
import {
  owner, admin, check, section, summary, cleanup,
  provisionShop, seedSupplier, seedPart, seedEngineModel,
  seedCustomer, receive, deliverAndConfirm, trackEngine, RUN,
} from "./_harness.mjs";

const shop = await provisionShop("Pricing");
const supplier = await seedSupplier({ label: "PriceVendor" });

// ── part: cost ₱150, catalog price ₱250 → floor is ₱150 ──────────────────────
const part = await seedPart({ label: "Impeller", cost: 15000, price: 25000 });
await receive({ supplier_id: supplier.id, parts: [{ part_id: part.id, qty: 10, unit_cost_centavos: 15000 }], note: `ZZ-TEST rcv ${RUN}` });
await deliverAndConfirm(shop, { parts: [{ part_id: part.id, qty: 6 }] });

// ── engine: cost ₱8,000, price ₱10,000 ───────────────────────────────────────
const model = await seedEngineModel({ brand: "ZZ-TEST", model: "Price" });
await receive({
  supplier_id: supplier.id,
  parts: [],
  engines: [{ serial_number: `PRICE-${RUN}`, engine_model_id: model.id, cost_centavos: 800000, price_centavos: 1000000 }],
  note: `ZZ-TEST eng ${RUN}`,
});
const { data: eng } = await owner.from("engines").select("id").eq("serial_number", `PRICE-${RUN}`).single();
trackEngine(eng.id);
await deliverAndConfirm(shop, { engine_ids: [eng.id] });

// ── 1. no engine tier remains ────────────────────────────────────────────────
section("Tiers are gone");
{
  const { data: e } = await owner.from("engines").select("*").eq("id", eng.id).single();
  check("engines has no margin_*_pct columns", !("margin_floor_pct" in e) && !("margin_asking_pct" in e));
  check("engines has no price_floor/mid/asking columns",
    !("price_floor_centavos" in e) && !("price_mid_centavos" in e) && !("price_asking_centavos" in e));
  check("engine keeps a single price_centavos + cost_centavos",
    e.price_centavos === 1000000 && e.cost_centavos === 800000);
}

// ── 2. shop sees its OWN on-hand cost (read-only) ────────────────────────────
section("Cost is visible to the shop (read-only)");
{
  const { data: st } = await shop.client.from("shop_stock").select("*").eq("part_id", part.id).single();
  check("shop_stock exposes own-shop part cost", st?.cost_centavos === 15000);
  check("shop_stock still shows selling price", st?.price_centavos === 25000);

  const { data: se } = await shop.client.from("shop_engines").select("*").eq("engine_id", eng.id).single();
  check("shop_engines exposes own-shop engine cost", se?.cost_centavos === 800000);
  check("shop_engines has a single price, no tiers",
    se?.price_centavos === 1000000 && !("price_floor_centavos" in se));

  // read-only: the shop cannot write cost (base-table RLS)
  await shop.client.from("parts").update({ cost_centavos: 1 }).eq("id", part.id);
  const { data: after } = await owner.from("parts").select("cost_centavos").eq("id", part.id).single();
  check("shop cannot edit cost", after?.cost_centavos === 15000);
}

// ── 3. the sale floor is COST, strictly greater — parts AND engines ─────────
section("Sale floor = cost (strict)");
const cust = await seedCustomer({ label: "PriceBuyer" });
const sell = (parts, engines, payType = "full", paid = null) =>
  shop.client.rpc("fn_record_sale", {
    p_customer_id: cust.id,
    p_part_lines: parts,
    p_engine_lines: engines,
    p_payment_type: payType,
    p_amount_paid_centavos: paid,
  });

{
  // PART: at-cost rejected, below-cost rejected, +1 accepted
  const atCost = await sell([{ part_id: part.id, qty: 1, unit_price_centavos: 15000 }], []);
  check("part at cost is rejected", /at or below cost/i.test(atCost.error?.message ?? ""), atCost.error?.message);
  const below = await sell([{ part_id: part.id, qty: 1, unit_price_centavos: 14999 }], []);
  check("part below cost is rejected", /at or below cost/i.test(below.error?.message ?? ""));
  const plus1 = await sell([{ part_id: part.id, qty: 1, unit_price_centavos: 15001 }], []);
  check("part at cost + 1 centavo succeeds", !plus1.error && !!plus1.data, plus1.error?.message);

  // the line stored the negotiated price + discount vs catalog
  const { data: line } = await owner
    .from("sale_lines").select("unit_price_centavos, line_total_centavos, list_reference_centavos, discount_centavos")
    .eq("sale_id", plus1.data).single();
  check("part line stores the agreed unit price", line?.unit_price_centavos === 15001);
  check("part line snapshots catalog price as list reference", line?.list_reference_centavos === 25000);
  check("part discount = catalog − agreed", line?.discount_centavos === 25000 - 15001);
}

{
  // omitted price → catalog price (must exceed cost, which the owner ensures)
  const dflt = await sell([{ part_id: part.id, qty: 1 }], []);
  check("omitted part price defaults to catalog price and sells", !dflt.error && !!dflt.data, dflt.error?.message);
  const { data: line } = await owner
    .from("sale_lines").select("unit_price_centavos").eq("sale_id", dflt.data).single();
  check("defaulted line uses catalog ₱250", line?.unit_price_centavos === 25000);
}

{
  // ENGINE: at-cost rejected, +1 accepted
  const atCost = await sell([], [{ engine_id: eng.id, agreed_price_centavos: 800000 }]);
  check("engine at cost is rejected", /at or below cost/i.test(atCost.error?.message ?? ""));
  const ok = await sell([], [{ engine_id: eng.id, agreed_price_centavos: 800001 }]);
  check("engine at cost + 1 centavo succeeds", !ok.error && !!ok.data, ok.error?.message);
  const { data: line } = await owner
    .from("sale_lines").select("agreed_price_centavos, unit_price_centavos, list_reference_centavos, discount_centavos")
    .eq("sale_id", ok.data).single();
  check("engine agreed stays in sync with unit price", line?.agreed_price_centavos === 800001 && line?.unit_price_centavos === 800001);
  check("engine discount vs catalog price", line?.list_reference_centavos === 1000000 && line?.discount_centavos === 1000000 - 800001);
}

// ── 4. owner sets catalog price; the floor is > cost ─────────────────────────
section("Owner catalog price > cost");
{
  const { error } = await owner.from("parts").update({ price_centavos: 30000 }).eq("id", part.id);
  check("owner can set a catalog price above cost", !error, error?.message);
}

await cleanup();
summary();
