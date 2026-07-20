/**
 * Supplier price comparison — quotes, derived history, provenance.
 *
 * The rules under test:
 *  • History derives from EXISTING receivings with zero data entry — what was
 *    actually paid, per supplier × product, engines grouped by MODEL.
 *  • A quote is a claim. Past its valid_until or older than
 *    settings.quote_stale_days it is FLAGGED stale (never hidden) and stops
 *    being the effective compare price, which falls back to last-paid.
 *  • provenance: effective_source/effective_as_of always say which number won
 *    and when it's from — a bare ₱165 vs ₱180 comparing a stale quote to a
 *    fresh payment is worse than no comparison.
 *  • is_cheapest and the preferred supplier's own price are stamped per row,
 *    so "Preferred is ₱X more" is one read.
 *  • Cost NEVER reaches a shop session — the 0042 lesson, tested directly.
 *
 * This suite flips settings.quote_stale_days to prove it drives behaviour;
 * capture/restore in try/finally (an exit handler cannot await).
 *
 * Run: node scripts/test-supplier-comparison.mjs
 */
import {
  owner, admin, RUN, P, check, section, summary,
  provisionShop, seedPart, seedEngineModel, seedSupplier, receive, cleanup,
} from "./_harness.mjs";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const daysAgo = (n) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const { data: origSettings, error: sErr } = await owner
  .from("settings").select("quote_stale_days").eq("id", 1).single();
if (sErr || origSettings?.quote_stale_days == null) {
  console.error(`Cannot read settings.quote_stale_days — is 0046 applied? ${sErr?.message ?? ""}`);
  process.exit(1);
}

let restored = false;
async function restoreSettings() {
  if (restored) return;
  restored = true;
  await admin.from("settings").update(origSettings).eq("id", 1);
}
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => void restoreSettings().then(() => process.exit(130)));
}

const shop = await provisionShop("Cmp");
const emp = shop.client;
const supA = await seedSupplier({ label: "Cmp A" });
const supB = await seedSupplier({ label: "Cmp B" });
const supC = await seedSupplier({ label: "Cmp C" });
const part = await seedPart({ label: "Cmp Part", cost: 10_000, price: 25_000 });
const model = await seedEngineModel({ brand: "ZZ-TEST", model: `C${RUN}` });

const bySupplier = (rows, id) => (rows ?? []).find((r) => r.supplier_id === id);
const partRows = async () =>
  (await owner.from("supplier_price_comparison").select("*").eq("part_id", part.id)).data;

try {

// ── 1. History derives from receivings — zero data entry ──────────────────
section("Last-paid history derives from existing receivings");
{
  await receive({ supplier_id: supA.id, parts: [{ part_id: part.id, qty: 5, unit_cost_centavos: 10_000 }] });
  await receive({ supplier_id: supA.id, parts: [{ part_id: part.id, qty: 5, unit_cost_centavos: 11_000 }] });
  await receive({ supplier_id: supB.id, parts: [{ part_id: part.id, qty: 5, unit_cost_centavos: 9_000 }] });

  const { data: hist } = await owner
    .from("supplier_product_prices_history").select("*").eq("part_id", part.id);
  check("one history row per supplier", hist?.length === 2, `got ${hist?.length}`);
  check(
    `supplier A shows its LATEST paid price ${P(11_000)}, not the first`,
    bySupplier(hist, supA.id)?.unit_cost_centavos === 11_000
  );
  check(`supplier B shows ${P(9_000)}`, bySupplier(hist, supB.id)?.unit_cost_centavos === 9_000);
  check("every history row carries its receiving ref", (hist ?? []).every((h) => !!h.receiving_id));
}

// ── 2. Quotes, and the XOR/range constraints ───────────────────────────────
section("Quotes");
{
  const { error: bothErr } = await owner.from("supplier_quotes").insert({
    supplier_id: supA.id, part_id: part.id, engine_model_id: model.id,
    unit_cost_centavos: 1, quoted_at: today,
  });
  check("a quote for BOTH a part and a model is rejected", !!bothErr);
  const { error: neitherErr } = await owner.from("supplier_quotes").insert({
    supplier_id: supA.id, unit_cost_centavos: 1, quoted_at: today,
  });
  check("a quote for NEITHER is rejected", !!neitherErr);
  const { error: rangeErr } = await owner.from("supplier_quotes").insert({
    supplier_id: supA.id, part_id: part.id, unit_cost_centavos: 1,
    quoted_at: today, valid_until: daysAgo(5),
  });
  check("valid_until before quoted_at is rejected", !!rangeErr);

  const { error } = await owner.from("supplier_quotes").insert({
    supplier_id: supA.id, part_id: part.id, unit_cost_centavos: 8_000, quoted_at: today,
  });
  check("a fresh quote records", !error, error?.message);

  const rows = await partRows();
  const a = bySupplier(rows, supA.id);
  const b = bySupplier(rows, supB.id);
  check(
    `A's compare price is the fresh quote ${P(8_000)}, beating its own paid ${P(11_000)}`,
    a?.effective_centavos === 8_000 && a?.effective_source === "quote"
  );
  check("A still SHOWS what it last charged (provenance, both numbers visible)",
    a?.last_paid_centavos === 11_000);
  check(`B's compare price stays its paid ${P(9_000)}`,
    b?.effective_centavos === 9_000 && b?.effective_source === "paid");
  check("A is cheapest", a?.is_cheapest === true && b?.is_cheapest === false);
  check("every row says when its price is from", (rows ?? []).every((r) => !!r.effective_as_of));
}

// ── 3. Staleness — flagged, falls back, driven by the setting ─────────────
section("Stale quotes");
{
  // 90 days old vs the 60-day default.
  await owner.from("supplier_quotes").insert({
    supplier_id: supB.id, part_id: part.id, unit_cost_centavos: 7_000, quoted_at: daysAgo(90),
  });
  let b = bySupplier(await partRows(), supB.id);
  check("a 90-day-old quote is flagged stale (default window 60)", b?.quote_stale === true);
  check(
    `…and the compare price FALLS BACK to last-paid ${P(9_000)}, labelled as paid`,
    b?.effective_centavos === 9_000 && b?.effective_source === "paid"
  );
  check("the stale quote is still SHOWN, not hidden", b?.quote_centavos === 7_000);

  // Supplier C: never bought from, only a stale quote — the last resort.
  await owner.from("supplier_quotes").insert({
    supplier_id: supC.id, part_id: part.id, unit_cost_centavos: 6_000, quoted_at: daysAgo(90),
  });
  const c = bySupplier(await partRows(), supC.id);
  check(
    "with no paid history, a stale quote is used but LABELLED stale_quote",
    c?.effective_centavos === 6_000 && c?.effective_source === "stale_quote"
  );

  // The dial drives it: widen to 120 days and the same quote is fresh again.
  await owner.from("settings").update({ quote_stale_days: 120 }).eq("id", 1);
  b = bySupplier(await partRows(), supB.id);
  check(
    "widening quote_stale_days to 120 makes the SAME 90-day quote effective",
    b?.quote_stale === false && b?.effective_centavos === 7_000 && b?.effective_source === "quote"
  );
  await admin.from("settings").update(origSettings).eq("id", 1);

  // valid_until beats age: fresh by date (10 days < 60), expired by its own
  // terms. On supplier C, where it genuinely becomes the LATEST quote — the
  // first version of this test put it on A, whose today-dated quote outranks
  // anything older, so the view (correctly) never looked at it.
  await owner.from("supplier_quotes").insert({
    supplier_id: supC.id, part_id: part.id, unit_cost_centavos: 7_500,
    quoted_at: daysAgo(10), valid_until: daysAgo(2),
  });
  const cAfter = bySupplier(await partRows(), supC.id);
  check(
    "a quote past its OWN valid_until is stale regardless of age",
    cAfter?.quote_stale === true && cAfter?.quote_centavos === 7_500,
    JSON.stringify({ stale: cAfter?.quote_stale, q: cAfter?.quote_centavos })
  );
  check(
    "…and with no paid history it is still used, labelled stale_quote",
    cAfter?.effective_source === "stale_quote" && cAfter?.effective_centavos === 7_500
  );
}

// ── 4. Preferred supplier: the badge's arithmetic ──────────────────────────
section("Preferred vs cheapest");
{
  await owner.from("parts").update({ preferred_supplier_id: supA.id }).eq("id", part.id);
  const rows = await partRows();
  const a = bySupplier(rows, supA.id);
  check("A is marked preferred", a?.is_preferred === true);
  check(
    "every row of the product carries the preferred supplier's own price",
    (rows ?? []).every((r) => r.preferred_effective_centavos === a?.effective_centavos)
  );
  const cheapest = (rows ?? []).find((r) => r.is_cheapest);
  check(
    `the badge's delta is computable: preferred ${P(a?.preferred_effective_centavos ?? 0)} − cheapest ${P(cheapest?.effective_centavos ?? 0)} > 0`,
    (a?.preferred_effective_centavos ?? 0) - (cheapest?.effective_centavos ?? 0) > 0
  );
  await owner.from("parts").update({ preferred_supplier_id: null }).eq("id", part.id);
}

// ── 5. Engine models compare by MODEL ──────────────────────────────────────
section("Engine models");
{
  await receive({
    supplier_id: supA.id,
    engines: [{
      serial_number: `ZZ-CMP-${RUN}`, engine_model_id: model.id, condition: "brand_new",
      cost_centavos: 2_000_000, price_centavos: 0, warranty_months: 12,
      margin_floor_pct: 10, margin_mid_pct: 20, margin_asking_pct: 30,
    }],
  });
  await owner.from("supplier_quotes").insert({
    supplier_id: supB.id, engine_model_id: model.id, unit_cost_centavos: 1_900_000, quoted_at: today,
  });

  const { data: rows } = await owner
    .from("supplier_price_comparison").select("*").eq("engine_model_id", model.id);
  check("engine rows exist for both suppliers", rows?.length === 2, `got ${rows?.length}`);
  check("kind is engine_model", (rows ?? []).every((r) => r.kind === "engine_model"));
  check(
    `A's engine price is the ${P(2_000_000)} it was actually paid (grouped by model, not serial)`,
    bySupplier(rows, supA.id)?.effective_centavos === 2_000_000 &&
      bySupplier(rows, supA.id)?.effective_source === "paid"
  );
  check(
    `B's fresh ${P(1_900_000)} quote is cheapest`,
    bySupplier(rows, supB.id)?.is_cheapest === true
  );
}

// ── 5b. supplier_count + duplicate folding (0052) ──────────────────────────
section("supplier_count and merged-duplicate folding");
{
  // (iii) a product bought from ONE supplier reports supplier_count = 1.
  const solo = await seedPart({ label: "Cmp Solo", cost: 5_000, price: 12_000 });
  await receive({ supplier_id: supA.id, parts: [{ part_id: solo.id, qty: 3, unit_cost_centavos: 5_000 }] });
  let soloRows = (await owner.from("supplier_price_comparison").select("*").eq("part_id", solo.id)).data;
  check(
    "a single-supplier product reports supplier_count = 1",
    soloRows?.length === 1 && soloRows[0]?.supplier_count === 1,
    `rows ${soloRows?.length}, count ${soloRows?.[0]?.supplier_count}`
  );

  // (i) supplier_count reflects DISTINCT suppliers — a quote from a second one lifts it to 2.
  await owner.from("supplier_quotes").insert({
    supplier_id: supB.id, part_id: solo.id, unit_cost_centavos: 4_500, quoted_at: today,
  });
  soloRows = (await owner.from("supplier_price_comparison").select("*").eq("part_id", solo.id)).data;
  check(
    "a second supplier's quote lifts supplier_count to 2 on every row",
    soloRows?.length === 2 && (soloRows ?? []).every((r) => r.supplier_count === 2),
    `rows ${soloRows?.length}, count ${soloRows?.[0]?.supplier_count}`
  );

  // (ii) merge two DISTINCT parts → the view folds them to ONE canonical product
  // carrying BOTH suppliers. The SOURCE must be stockless (merge precondition),
  // so it is seeded with a quote only — never received.
  const keep = await seedPart({ label: "Cmp Dup Keep", cost: 6_000, price: 15_000 });
  const retire = await seedPart({ label: "Cmp Dup Retire", cost: 6_000, price: 15_000 });
  await receive({ supplier_id: supA.id, parts: [{ part_id: keep.id, qty: 2, unit_cost_centavos: 6_000 }] });
  await owner.from("supplier_quotes").insert({
    supplier_id: supB.id, part_id: retire.id, unit_cost_centavos: 5_800, quoted_at: today,
  });

  const before = (await owner.from("supplier_price_comparison").select("*").eq("part_id", keep.id)).data;
  check(
    "pre-merge the survivor shows only its own 1 supplier",
    before?.length === 1 && before[0]?.supplier_count === 1,
    `rows ${before?.length}, count ${before?.[0]?.supplier_count}`
  );

  const { error: mErr } = await owner.rpc("fn_merge_parts", {
    p_source_id: retire.id, p_target_id: keep.id, p_note: `ZZ-TEST merge ${RUN}`,
  });
  check("fn_merge_parts folds the stockless duplicate into the survivor", !mErr, mErr?.message);

  const after = (await owner.from("supplier_price_comparison").select("*").eq("part_id", keep.id)).data;
  check(
    "post-merge the view returns ONE product carrying BOTH suppliers, supplier_count = 2",
    after?.length === 2 && (after ?? []).every((r) => r.supplier_count === 2),
    `rows ${after?.length}, count ${after?.[0]?.supplier_count}`
  );
  check(
    "the retired duplicate no longer surfaces as its own product",
    ((await owner.from("supplier_price_comparison").select("*").eq("part_id", retire.id)).data ?? []).length === 0
  );

  // Clean the merge record we created (harness also sweeps part_merges by tracked parts).
  await admin.from("part_merges").delete().eq("source_part_id", retire.id);
}

// ── 6. Cost never reaches a shop ────────────────────────────────────────────
section("Owner-only (the 0042 lesson)");
{
  for (const t of ["supplier_quotes", "supplier_product_prices_history", "supplier_price_comparison"]) {
    const { data } = await emp.from(t).select("*").limit(5);
    check(`employee reads NOTHING from ${t}`, (data ?? []).length === 0, `got ${data?.length}`);
  }
  const { error: insErr } = await emp.from("supplier_quotes").insert({
    supplier_id: supA.id, part_id: part.id, unit_cost_centavos: 1, quoted_at: today,
  });
  check("employee cannot record a quote", !!insErr);
}

} finally {
  await restoreSettings();
  const { data: back } = await owner
    .from("settings").select("quote_stale_days").eq("id", 1).single();
  check("quote_stale_days restored", back?.quote_stale_days === origSettings.quote_stale_days,
    `left as ${back?.quote_stale_days}`);
  // Quotes FK the suppliers the harness is about to delete.
  await admin.from("supplier_quotes").delete().in("supplier_id", [supA.id, supB.id, supC.id]);
  await cleanup();
  summary();
}
