/**
 * Warranties — the OWNER side: the serial registry, warranty auto-creation on
 * approval, the months-resolution chain, the claim log, fitment, the serial's
 * ledger journey, and the certificate query.
 *
 * Verifies:
 *   • approving an ENGINE sale auto-creates the warranty (nothing else does)
 *   • months resolve engine override → model default → settings → 12
 *   • expires_on = sold_on + months, in PH time
 *   • an engine sale cannot be recorded without a customer (no warranty owner)
 *   • the registry/certificate joins render complete with serial + customer + shop
 *   • owner logs claims; employees can neither read warranties nor file claims
 *   • the serial's journey is master-out → shop-in → sale (transit-aware)
 *
 * The SHOP-side view (shop_warranties scoping, near-expiry alerts) belongs to
 * test-shop-warranties.mjs and is deliberately not repeated here.
 *
 * Provisions its own shop — it must never write into a real branch.
 *
 * Run: node scripts/test-warranties.mjs
 */
import {
  owner, RUN, check, section, summary,
  provisionShop, seedPart, seedEngineModel, seedCustomer,
  receive, deliverAndConfirm, cleanup,
} from "./_harness.mjs";

const S = await provisionShop("Warranty");
const emp = S.client;

/** Postgres `date + interval 'n months'` clamps to the month's last day. */
const addMonths = (iso, m) => {
  const [y, mo, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, mo - 1 + m, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
};

section("Setup: two engines sold end-to-end (model default = 12 months):");
const model = await seedEngineModel({ brand: "WTY", model: "Enduro", hp: 40 });
const model2 = await seedEngineModel({ brand: "WTY", model: "Alt", hp: 15 });
const customer = await seedCustomer({ label: "Ka Pedro" });

const SERIAL_OVERRIDE = `WTY-${RUN}-SN1`;
const SERIAL_DEFAULT = `WTY-${RUN}-SN2`;
const COST = 2_000_000;
const AGREED = 4_000_000;
const margins = { margin_floor_pct: 50, margin_mid_pct: 75, margin_asking_pct: 100 };

await receive({
  engines: [
    // engine-level override — must beat the model's 12
    { serial_number: SERIAL_OVERRIDE, engine_model_id: model.id, condition: "brand_new",
      cost_centavos: COST, price_centavos: 0, warranty_months: 6, ...margins },
    // no override — must fall through to the model's default
    { serial_number: SERIAL_DEFAULT, engine_model_id: model.id, condition: "brand_new",
      cost_centavos: COST, price_centavos: 0, warranty_months: null, ...margins },
  ],
});
const { data: engs } = await owner
  .from("engines").select("id, serial_number").in("serial_number", [SERIAL_OVERRIDE, SERIAL_DEFAULT]);
const engOverride = engs.find((e) => e.serial_number === SERIAL_OVERRIDE);
const engDefault = engs.find((e) => e.serial_number === SERIAL_DEFAULT);
check("two engines received into master", !!engOverride && !!engDefault);

await deliverAndConfirm(S, { engine_ids: [engOverride.id, engDefault.id] });

{
  // The warranty needs an owner, so the customer is demanded at RECORD time —
  // the check in fn_approve_sale is only a backstop for hand-built sales.
  const { error } = await emp.rpc("fn_record_sale", {
    p_customer_id: null, p_customer: null, p_part_lines: [],
    p_engine_lines: [{ engine_id: engOverride.id, agreed_price_centavos: AGREED }],
  });
  check("engine sale WITHOUT a customer is rejected", !!error && /customer/i.test(error.message), error?.message);
}

const { data: saleA } = await emp.rpc("fn_record_sale", {
  p_customer_id: customer.id, p_customer: null, p_part_lines: [],
  p_engine_lines: [{ engine_id: engOverride.id, agreed_price_centavos: AGREED }],
});
const { data: saleB } = await emp.rpc("fn_record_sale", {
  p_customer_id: customer.id, p_customer: null, p_part_lines: [],
  p_engine_lines: [{ engine_id: engDefault.id, agreed_price_centavos: AGREED }],
});

section("A warranty exists ONLY once the owner approves:");
{
  const { data } = await owner.from("warranties").select("id").eq("engine_id", engOverride.id);
  check("no warranty while the sale is only recorded", (data ?? []).length === 0);
}
// Shops may only insert `recorded` (0016) — the batch submit is what makes a
// sale reviewable. The old script approved straight from record; that path is gone.
const { error: subErr } = await emp.rpc("fn_submit_shop_batch");
check("batch submitted (recorded → pending)", !subErr, subErr?.message);
{
  const { error: e1 } = await owner.rpc("fn_approve_sale", { p_sale_id: saleA, p_note: null });
  const { error: e2 } = await owner.rpc("fn_approve_sale", { p_sale_id: saleB, p_note: null });
  check("both engine sales approved", !e1 && !e2, e1?.message ?? e2?.message);
}

section("Warranty registry joins:");
const { data: w, error: wErr } = await owner
  .from("warranties")
  .select(
    `id, engine_id, sold_on, months, expires_on,
     engines(serial_number, engine_models(brand, model, horsepower)),
     customers(name, phone),
     sales(shops(name)),
     warranty_claims(id)`
  )
  .eq("engine_id", engOverride.id)
  .single();
check("warranty row with all joins", !!w && !wErr, wErr?.message);
check("serial + customer + shop joined",
  w?.engines?.serial_number === SERIAL_OVERRIDE &&
  /Ka Pedro/.test(w?.customers?.name ?? "") &&
  w?.sales?.shops?.name === S.name);
check("warranty is linked to its originating sale (how shop scoping works)",
  !!(await owner.from("warranties").select("sale_id").eq("id", w.id).single()).data?.sale_id);

section("Months resolution (engine override → model default → settings → 12):");
check("engine override honored (6 months, not the model's 12)", w?.months === 6, `(got ${w?.months})`);
{
  const { data: wb } = await owner
    .from("warranties").select("months, sold_on, expires_on").eq("engine_id", engDefault.id).single();
  check("no override falls through to the model default (12)", wb?.months === 12, `(got ${wb?.months})`);
  check("expires_on = sold_on + 12 months",
    wb?.expires_on === addMonths(wb.sold_on, 12), `(got ${wb?.expires_on})`);
}
check("expires_on = sold_on + 6 months",
  w?.expires_on === addMonths(w.sold_on, 6), `(got ${w?.expires_on})`);

section("Claim log:");
{
  const { error } = await owner.from("warranty_claims").insert({
    warranty_id: w.id, claim_date: w.sold_on,
    issue: `WTY-TEST hindi umaandar ${RUN}`, action_taken: "checked carburetor",
  });
  check("owner can log a claim", !error, error?.message);
  const { data: claims } = await owner.from("warranty_claims").select("*").eq("warranty_id", w.id);
  check("claim readable with action", claims?.length === 1 && claims[0].action_taken === "checked carburetor");
}
{
  const { data } = await emp.from("warranties").select("*");
  check("employee cannot read the warranties base table", (data ?? []).length === 0);
  const { error } = await emp.from("warranty_claims").insert({
    warranty_id: w.id, claim_date: w.sold_on, issue: "sneaky claim",
  });
  check("employee cannot log claims", !!error);
}

section("Serial journey (ledger for one engine):");
{
  const { data: moves } = await owner
    .from("stock_movements")
    .select("movement_type, qty_change, shop_id")
    .eq("engine_id", engOverride.id)
    .order("created_at");
  const kinds = (moves ?? []).map((m) => m.movement_type);
  check("journey: received → delivery ×2 → sale",
    kinds.join(",") === "received,delivery,delivery,sale", `(got ${kinds.join(",")})`);
  // Since 0028/0029 the two `delivery` rows are master-out and shop-in (the
  // second only lands when the shop CONFIRMS) — not one auto-landing hop.
  check("delivery leaves master (shop_id null, -1) then lands at the shop (+1)",
    moves?.[1]?.shop_id === null && moves[1].qty_change === -1 &&
    moves?.[2]?.shop_id === S.id && moves[2].qty_change === 1);
  check("sale deducts the serial from the selling shop",
    moves?.[3]?.qty_change === -1 && moves[3].shop_id === S.id);
}

section("Fitment:");
const part = await seedPart({ label: "Impeller", cost: 10000, price: 20000 });
{
  const { error } = await owner.from("part_fitments").insert([
    { part_id: part.id, engine_model_id: model.id },
    { part_id: part.id, engine_model_id: model2.id },
  ]);
  check("owner sets fitment (2 models)", !error, error?.message);
}
{
  const { data } = await emp.from("part_fitments").select("engine_model_id").eq("part_id", part.id);
  check("employee can read fitment (sale-time hint)", data?.length === 2);
  const { data: em } = await emp.from("engine_models").select("brand, model").eq("id", model.id).single();
  check("employee can read model names for the hint", !!em?.brand);
  const { error } = await emp.from("part_fitments").insert({ part_id: part.id, engine_model_id: model2.id });
  check("employee cannot edit fitment", !!error);
}
{
  // replace-all pattern used by the action
  await owner.from("part_fitments").delete().eq("part_id", part.id);
  const { error } = await owner.from("part_fitments").insert([{ part_id: part.id, engine_model_id: model2.id }]);
  const { data } = await owner.from("part_fitments").select("*").eq("part_id", part.id);
  check("fitment replace works (now 1 model)", !error && data?.length === 1);
}

section("Certificate data joins:");
{
  const { data: c, error } = await owner
    .from("warranties")
    .select(
      `id, sold_on, months, expires_on,
       engines(serial_number, condition, engine_models(brand, model, horsepower, stroke)),
       customers(name, phone, address),
       sales(shops(name, location))`
    )
    .eq("id", w.id)
    .single();
  check("certificate query renders complete",
    !error && !!c?.engines?.serial_number && !!c?.customers?.name, error?.message);
  check("certificate carries the selling shop", c?.sales?.shops?.name === S.name);
}

section("Cleanup:");
await cleanup();
summary();
