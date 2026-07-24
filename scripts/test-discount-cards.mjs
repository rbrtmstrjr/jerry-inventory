/**
 * Suki discount cards (0072) — the loyalty discount at POS.
 *
 * What this proves:
 *   • Cards are OWNER-ONLY: only the owner issues/deactivates; a shop cannot
 *     create one, and RLS hides the table from a shop session entirely.
 *   • One ACTIVE card per customer; the number is OWNER-ENTERED (printed by an
 *     external system, 0082) — required, unique across cards, no minted prefix;
 *     a lost card is deactivated and replaced with the new printed card.
 *   • fn_lookup_discount_card is the shop's ONLY window: active card → the
 *     customer + the two live percentages, nothing else; inactive/unknown →
 *     zero rows.
 *   • fn_record_sale with a card re-derives prices SERVER-SIDE:
 *       – part lines get suki_part_discount_pct off catalog,
 *       – engine lines get suki_engine_discount_pct off catalog,
 *       – capped at cost+1 on thin margins (strict > cost floor survives),
 *       – the client's price is CLAMPED to the card price (guaranteed
 *         minimum: lower ok, higher never), at/below cost still raises,
 *       – the card's customer IS the sale customer,
 *       – sales.card_discount_centavos records what the program gave.
 *   • An inactive card neither looks up nor records.
 *
 * Run: node scripts/test-discount-cards.mjs
 */
import {
  RUN, admin, owner, check, section, summary,
  provisionShop, seedCustomer, seedPart, seedEngineModel,
  receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

// ── preflight: refuse to run against a DB without 0072 + 0082 ───────────────
{
  const probe = await admin.from("discount_cards").select("id").limit(1);
  if (probe.error) {
    console.error(
      "\nMigration 0072 is not applied — run supabase/migrations/0072_suki_discount_cards.sql first.\n"
    );
    process.exit(2);
  }
  // 0082 replaced fn_create_discount_card(uuid,text) with (uuid,text,text) —
  // an owner-entered p_card_no. If it's absent, PostgREST can't find the new
  // overload (PGRST202); a plain validation error means it IS applied.
  const sig = await owner.rpc("fn_create_discount_card", {
    p_customer_id: null,
    p_card_no: "",
  });
  if (sig.error && /PGRST202|find the function|does not exist/i.test(sig.error.message)) {
    console.error(
      "\nMigration 0082 is not applied — run supabase/migrations/0082_suki_external_barcode.sql first.\n"
    );
    process.exit(2);
  }
}

const cardIds = [];

// mirrors the server: pct off catalog, never at/below cost
const cardPrice = (catalog, cost, pct) =>
  Math.max(Math.round((catalog * (100 - pct)) / 100), cost + 1);

let shop;
try {
  shop = await provisionShop("Suki");
  const customer = await seedCustomer({ label: "Suki" });

  const { data: dials } = await owner
    .from("settings")
    .select("suki_engine_discount_pct, suki_part_discount_pct")
    .eq("id", 1)
    .single();
  const E = dials.suki_engine_discount_pct;
  const P5 = dials.suki_part_discount_pct;

  // ── issuing ───────────────────────────────────────────────────────────────
  section("Issuing — owner-only, one active per customer, owner-entered number");

  const CARD1 = `ZZ-${RUN}-A`.toUpperCase();
  const CARD2 = `ZZ-${RUN}-B`.toUpperCase();

  const { data: made, error: mkErr } = await owner.rpc("fn_create_discount_card", {
    p_customer_id: customer.id, p_card_no: CARD1, p_note: `ZZ-TEST ${RUN}`,
  });
  check("owner records a card", !mkErr, mkErr?.message);
  const card = made ?? {};
  if (card.id) cardIds.push(card.id);
  check("card number is stored as entered (upper+trimmed)",
    card.card_no === CARD1, card.card_no);

  const { error: emptyErr } = await owner.rpc("fn_create_discount_card", {
    p_customer_id: customer.id, p_card_no: "   ",
  });
  check("an empty card number is refused",
    !!emptyErr && /card number is required/i.test(emptyErr.message), emptyErr?.message);

  // a DIFFERENT customer reusing the same number → the uniqueness guard fires
  const customer2 = await seedCustomer({ label: "Suki2" });
  const { error: dupNoErr } = await owner.rpc("fn_create_discount_card", {
    p_customer_id: customer2.id, p_card_no: CARD1,
  });
  check("a duplicate card number is refused",
    !!dupNoErr && /already on file/i.test(dupNoErr.message), dupNoErr?.message);

  const { error: dupErr } = await owner.rpc("fn_create_discount_card", {
    p_customer_id: customer.id, p_card_no: CARD2,
  });
  check("second active card for the same customer is refused",
    !!dupErr && /already has an active card/i.test(dupErr.message), dupErr?.message);

  const { error: shopMkErr } = await shop.client.rpc("fn_create_discount_card", {
    p_customer_id: customer.id, p_card_no: CARD2,
  });
  check("a SHOP cannot issue a card", !!shopMkErr, "shop rpc succeeded");

  const { data: shopRead } = await shop.client.from("discount_cards").select("id");
  check("RLS hides discount_cards from a shop session", (shopRead ?? []).length === 0);

  // ── lookup ────────────────────────────────────────────────────────────────
  section("Lookup — POS essentials only, active cards only");

  const { data: found, error: lkErr } = await shop.client.rpc("fn_lookup_discount_card", {
    p_card_no: card.card_no,
  });
  check("shop resolves an active card", !lkErr && (found ?? []).length === 1, lkErr?.message);
  const info = (found ?? [])[0] ?? {};
  check("lookup names the suki customer", info.customer_id === customer.id);
  check("lookup carries the live percentages",
    info.engine_pct === E && info.part_pct === P5,
    `got ${info.engine_pct}/${info.part_pct}, dials ${E}/${P5}`);
  check("lookup returns no cost fields",
    !("cost_centavos" in info) && !("price_centavos" in info));

  const { data: ghost } = await shop.client.rpc("fn_lookup_discount_card", {
    p_card_no: `ZZ-${RUN}-UNKNOWN`,
  });
  check("unknown card → zero rows", (ghost ?? []).length === 0);

  // ── POS math: parts ───────────────────────────────────────────────────────
  section("Record sale — part gets the card price, server-derived");

  const part = await seedPart({ label: "SukiPart", cost: 100000, price: 200000 });
  const thin = await seedPart({ label: "SukiThin", cost: 190000, price: 200000 });
  await receive({ parts: [
    { part_id: part.id, qty: 20, unit_cost_centavos: 100000 },
    { part_id: thin.id, qty: 5, unit_cost_centavos: 190000 },
  ]});
  await deliverAndConfirm(shop, { parts: [
    { part_id: part.id, qty: 10 }, { part_id: thin.id, qty: 3 },
  ]});

  const expectPart = cardPrice(200000, 100000, P5);

  const { data: sale1, error: s1Err } = await shop.client.rpc("fn_record_sale", {
    p_part_lines: [{ part_id: part.id, qty: 2 }], // no client price → card price
    p_discount_card_id: card.id,
  });
  check("sale with card records (no client price)", !s1Err, s1Err?.message);

  const { data: s1 } = await owner.from("sales")
    .select("customer_id, discount_card_id, card_discount_centavos, total_centavos, sale_lines(unit_price_centavos, list_reference_centavos, discount_centavos)")
    .eq("id", sale1).single();
  check("line price = the card price", s1?.sale_lines?.[0]?.unit_price_centavos === expectPart,
    `got ${s1?.sale_lines?.[0]?.unit_price_centavos}, want ${expectPart}`);
  check("the card's customer IS the sale customer", s1?.customer_id === customer.id);
  check("sale carries the card", s1?.discount_card_id === card.id);
  check("card_discount = (catalog − card price) × qty",
    s1?.card_discount_centavos === (200000 - expectPart) * 2,
    `got ${s1?.card_discount_centavos}`);

  // ── clamp: guaranteed minimum ─────────────────────────────────────────────
  section("Clamp — lower ok, higher never, at/below cost still raises");

  const { data: sale2 } = await shop.client.rpc("fn_record_sale", {
    p_part_lines: [{ part_id: part.id, qty: 1, unit_price_centavos: 200000 }], // catalog, above card
    p_discount_card_id: card.id,
  });
  const { data: s2 } = await owner.from("sales")
    .select("sale_lines(unit_price_centavos)").eq("id", sale2).single();
  check("a price ABOVE the card price is clamped down to it",
    s2?.sale_lines?.[0]?.unit_price_centavos === expectPart,
    `got ${s2?.sale_lines?.[0]?.unit_price_centavos}`);

  const lower = expectPart - 5000;
  const { data: sale3 } = await shop.client.rpc("fn_record_sale", {
    p_part_lines: [{ part_id: part.id, qty: 1, unit_price_centavos: lower }],
    p_discount_card_id: card.id,
  });
  const { data: s3 } = await owner.from("sales")
    .select("sale_lines(unit_price_centavos)").eq("id", sale3).single();
  check("a LOWER negotiated price is kept",
    s3?.sale_lines?.[0]?.unit_price_centavos === lower);

  const { error: floorErr } = await shop.client.rpc("fn_record_sale", {
    p_part_lines: [{ part_id: part.id, qty: 1, unit_price_centavos: 100000 }], // = cost
    p_discount_card_id: card.id,
  });
  check("at-cost with a card still raises", !!floorErr && /below cost/i.test(floorErr.message),
    floorErr?.message);

  // ── thin margin: cap at cost+1 ────────────────────────────────────────────
  const expectThin = cardPrice(200000, 190000, P5); // pct would go ≤ cost → 190001
  check("thin-margin card price is capped at cost+1 (precheck)", expectThin === 190001,
    `computed ${expectThin}`);
  const { data: sale4, error: s4Err } = await shop.client.rpc("fn_record_sale", {
    p_part_lines: [{ part_id: thin.id, qty: 1 }],
    p_discount_card_id: card.id,
  });
  check("thin-margin sale records above cost", !s4Err, s4Err?.message);
  const { data: s4 } = await owner.from("sales")
    .select("sale_lines(unit_price_centavos)").eq("id", sale4).single();
  check("stored thin-margin price = cost+1",
    s4?.sale_lines?.[0]?.unit_price_centavos === 190001,
    `got ${s4?.sale_lines?.[0]?.unit_price_centavos}`);

  // ── engines: 10% path ─────────────────────────────────────────────────────
  section("Engines — engine percentage, serial flow intact");

  const model = await seedEngineModel({ brand: "ZZ-TEST", model: "SUKI" });
  await receive({ engines: [{
    serial_number: `SUKI-${RUN}`, engine_model_id: model.id,
    cost_centavos: 800000, price_centavos: 1000000,
  }]});
  const { data: eng } = await owner.from("engines")
    .select("id").eq("serial_number", `SUKI-${RUN}`).single();
  await deliverAndConfirm(shop, { engine_ids: [eng.id] });

  const expectEngine = cardPrice(1000000, 800000, E);
  const { data: sale5, error: s5Err } = await shop.client.rpc("fn_record_sale", {
    p_engine_lines: [{ engine_id: eng.id }],
    p_discount_card_id: card.id,
  });
  check("engine sale with card records", !s5Err, s5Err?.message);
  const { data: s5 } = await owner.from("sales")
    .select("card_discount_centavos, sale_lines(unit_price_centavos, agreed_price_centavos)")
    .eq("id", sale5).single();
  check("engine agreed = engine card price",
    s5?.sale_lines?.[0]?.agreed_price_centavos === expectEngine,
    `got ${s5?.sale_lines?.[0]?.agreed_price_centavos}, want ${expectEngine}`);
  check("engine card_discount recorded",
    s5?.card_discount_centavos === 1000000 - expectEngine);

  // ── deactivation ──────────────────────────────────────────────────────────
  section("Deactivation — a dead card neither looks up nor records");

  const { error: shopStatusErr } = await shop.client.rpc("fn_set_discount_card_status", {
    p_card_id: card.id, p_status: "inactive",
  });
  check("a SHOP cannot deactivate a card", !!shopStatusErr);

  const { error: offErr } = await owner.rpc("fn_set_discount_card_status", {
    p_card_id: card.id, p_status: "inactive",
  });
  check("owner deactivates", !offErr, offErr?.message);

  const { data: deadLk } = await shop.client.rpc("fn_lookup_discount_card", {
    p_card_no: card.card_no,
  });
  check("inactive card no longer resolves", (deadLk ?? []).length === 0);

  const { error: deadErr } = await shop.client.rpc("fn_record_sale", {
    p_part_lines: [{ part_id: part.id, qty: 1 }],
    p_discount_card_id: card.id,
  });
  check("inactive card cannot be used on a sale",
    !!deadErr && /not active/i.test(deadErr.message), deadErr?.message);

  // sale WITHOUT a card is byte-identical to before (regression)
  const { data: plain, error: plainErr } = await shop.client.rpc("fn_record_sale", {
    p_part_lines: [{ part_id: part.id, qty: 1 }],
  });
  check("card-less sale still works at catalog price", !plainErr, plainErr?.message);
  const { data: sp } = await owner.from("sales")
    .select("discount_card_id, card_discount_centavos, sale_lines(unit_price_centavos)")
    .eq("id", plain).single();
  check("card-less sale: catalog price, no card fields",
    sp?.sale_lines?.[0]?.unit_price_centavos === 200000 &&
    sp?.discount_card_id === null && sp?.card_discount_centavos === 0);
} finally {
  // FK order: sales reference the card, the card references the customer —
  // detach sales from cards, drop the cards, then the normal sweep.
  if (shop) {
    await admin.from("sales").update({ discount_card_id: null }).eq("shop_id", shop.id);
  }
  if (cardIds.length) {
    await admin.from("discount_cards").delete().in("id", cardIds);
  }
  await cleanup();
}

summary();
