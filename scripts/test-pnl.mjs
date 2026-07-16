/**
 * Consolidated P&L / net income.
 *
 * This suite imports `lib/pnl.ts` DIRECTLY and asserts against the very code
 * /reports?tab=pnl and /shops/reports both run. That is the point: the two
 * pages must never disagree, and a test that re-derived the arithmetic itself
 * would be a third implementation proving nothing about the first two.
 *
 * WHAT IS ASSERTED EXACTLY vs BY DELTA
 * This runs against the live database, which has real sales, real staff and
 * real overhead in it. So:
 *   • per-shop figures are asserted EXACTLY, scoped to a throwaway shop;
 *   • business-wide figures are asserted as a DELTA around the fixture;
 *   • the reconciliation identity is asserted EXACTLY and globally — it holds
 *     no matter what else is in the database, which is what makes it an
 *     identity rather than a coincidence.
 *
 * THE HEADLINE RULE
 *   Σ shop net contribution − company overhead − shrinkage = net income
 * The spec asked for this without the shrinkage term, which is arithmetically
 * impossible: a shop's contribution excludes losses on purpose, the business's
 * net income cannot. The two sides differ by exactly the shrinkage.
 *
 * Run: node scripts/test-pnl.mjs
 */
import {
  owner, admin, RUN, P, check, section, summary,
  provisionShop, seedPart, seedEngineModel, seedSupplier, seedExpenseCategory,
  receive, deliverAndConfirm, trackEngine, cleanup,
} from "./_harness.mjs";
import { computePnl, computeCashPosition } from "../lib/pnl.ts";

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila" }).format(new Date());
const RANGE = { from: today, to: today };

// ── fixture money (chosen so every expected figure is exact) ────────────────
const PART_COST = 10_000;      // ₱100
const PART_PRICE = 25_000;     // ₱250
// price = round(cost × (1 + margin/100)) — fn_compute_tier_price.
const ENG_A_COST = 2_000_000;  // ₱20,000 … asking ₱35,000 at 75%. Gets damaged.
const ENG_B_COST = 8_000_000;  // ₱80,000 … asking ₱100,000 at 25%. Gets sold.
const ENG_B_ASKING = 10_000_000;
const ENG_B_AGREED = 9_500_000;   // ₱95,000 — ₱5,000 negotiated away
const ENG_B_DOWN = 3_000_000;     // ₱30,000 down, ₱65,000 on utang

const EXP_SHOP = 50_000;       // ₱500

const shop = await provisionShop("PnL");
const emp = shop.client;

section("Fixture");
const part = await seedPart({ label: "PnL Part", cost: PART_COST, price: PART_PRICE });
const model = await seedEngineModel({ brand: "ZZ-TEST", model: `P${RUN}` });

await receive({ parts: [{ part_id: part.id, qty: 12, unit_cost_centavos: PART_COST }] });
await receive({
  engines: [
    {
      serial_number: `ZZ-PNL-A-${RUN}`, engine_model_id: model.id, condition: "brand_new",
      cost_centavos: ENG_A_COST, price_centavos: 0, warranty_months: 12,
      margin_floor_pct: 10, margin_mid_pct: 50, margin_asking_pct: 75,
    },
    {
      serial_number: `ZZ-PNL-B-${RUN}`, engine_model_id: model.id, condition: "brand_new",
      cost_centavos: ENG_B_COST, price_centavos: 0, warranty_months: 12,
      margin_floor_pct: 10, margin_mid_pct: 18, margin_asking_pct: 25,
    },
  ],
});

const { data: engs } = await owner
  .from("engines")
  .select("id, serial_number, price_asking_centavos, price_floor_centavos")
  .like("serial_number", `ZZ-PNL-%-${RUN}`);
const engA = engs.find((e) => e.serial_number.includes("-A-"));
const engB = engs.find((e) => e.serial_number.includes("-B-"));
check(
  `engine A asks ${P(3_500_000)} on a ${P(ENG_A_COST)} cost (the spec's case)`,
  engA?.price_asking_centavos === 3_500_000,
  String(engA?.price_asking_centavos)
);
check(
  `engine B asks ${P(ENG_B_ASKING)}`,
  engB?.price_asking_centavos === ENG_B_ASKING,
  String(engB?.price_asking_centavos)
);

await deliverAndConfirm(shop, {
  parts: [{ part_id: part.id, qty: 10 }],
  engine_ids: [engA.id, engB.id],
});

// Baseline for every business-wide delta below.
const before = await computePnl(owner, RANGE);
const cashBefore = await computeCashPosition(owner, RANGE);

// ── the approved batch ─────────────────────────────────────────────────────
{
  const { error: e1 } = await emp.rpc("fn_record_sale", {
    p_customer: { name: `ZZ-TEST Cash Buyer ${RUN}` },
    p_part_lines: [{ part_id: part.id, qty: 4, unit_price_centavos: PART_PRICE }],
  });
  check("4 parts recorded", !e1, e1?.message);

  const { error: e2 } = await emp.rpc("fn_record_sale", {
    p_customer: { name: `ZZ-TEST Utang Buyer ${RUN}`, phone: "0917-000-3333" },
    p_engine_lines: [{ engine_id: engB.id, agreed_price_centavos: ENG_B_AGREED }],
    p_payment_type: "partial",
    p_amount_paid_centavos: ENG_B_DOWN,
  });
  check(`engine B sold at ${P(ENG_B_AGREED)} with ${P(ENG_B_DOWN)} down`, !e2, e2?.message);

  const { error: e3 } = await emp.rpc("fn_record_loss", {
    p_engine_id: engA.id, p_qty: 1, p_reason: "nasira",
    p_note: `ZZ-TEST damaged ${RUN}`,
  });
  check("engine A written off as nasira", !e3, e3?.message);

  const { data: b, error: e4 } = await emp.rpc("fn_submit_shop_batch");
  check("batch submitted", !e4 && !!b?.batch_id, e4?.message);
  const { error: e5 } = await owner.rpc("fn_approve_batch", { p_batch_id: b.batch_id });
  check("batch approved", !e5, e5?.message);
}

// ── sales that must NEVER count as revenue ─────────────────────────────────
{
  // Submitted but not approved.
  await emp.rpc("fn_record_sale", {
    p_customer: { name: `ZZ-TEST Pending ${RUN}` },
    p_part_lines: [{ part_id: part.id, qty: 1, unit_price_centavos: PART_PRICE }],
  });
  await emp.rpc("fn_submit_shop_batch");
  // Recorded and never submitted — invisible to the owner entirely.
  await emp.rpc("fn_record_sale", {
    p_customer: { name: `ZZ-TEST Recorded ${RUN}` },
    p_part_lines: [{ part_id: part.id, qty: 2, unit_price_centavos: PART_PRICE }],
  });
}

// ── a return: stock moving back, NOT a loss ───────────────────────────────
{
  const { error } = await owner.rpc("fn_return_stock", {
    p_shop_id: shop.id, p_reason: `ZZ-TEST return ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 2 }], p_engine_ids: [],
  });
  check("2 parts returned to master", !error, error?.message);
}

// ── a transit write-off: stock lost between master and shop ────────────────
{
  const { data: delId } = await owner.rpc("fn_deliver_stock", {
    p_shop_id: shop.id, p_note: `ZZ-TEST transit ${RUN}`,
    p_parts: [{ part_id: part.id, qty: 1 }], p_engine_ids: [],
  });
  const { data: lines } = await owner
    .from("delivery_lines").select("id, qty").eq("delivery_id", delId);
  // The shop counts what arrived: nothing.
  await emp.rpc("fn_confirm_delivery", {
    p_delivery_id: delId,
    p_lines: lines.map((l) => ({ line_id: l.id, qty_received: 0, shop_note: "never arrived" })),
    p_note: null,
  });
  const { error } = await owner.rpc("fn_resolve_delivery_discrepancy", {
    p_delivery_line_id: lines[0].id, p_qty: 1,
    p_resolution: "written_off", p_reason: `ZZ-TEST lost in transit ${RUN}`,
  });
  check("1 part written off in transit", !error, error?.message);
}

// ── expenses + payroll ─────────────────────────────────────────────────────
const cat = await seedExpenseCategory({ label: "PnL Cat" });
await owner.from("expenses").insert({
  category_id: cat.id, scope: "shop", shop_id: shop.id,
  amount: EXP_SHOP, description: `ZZ-TEST shop expense ${RUN}`, expense_date: today,
});

let periodId = null;
{
  const { data: staff } = await owner.from("staff").insert({
    shop_id: shop.id, full_name: `ZZ-TEST Mechanic ${RUN}`,
    pay_type: "monthly", pay_rate: 2_000_000, contributions_enabled: true,
  }).select().single();
  check("staff seeded", !!staff);

  const { data: pid, error } = await owner.rpc("fn_create_pay_period", {
    p_label: `ZZ-TEST ${RUN}`, p_start: today, p_end: today, p_frequency: "monthly",
  });
  check("pay period created", !error && !!pid, error?.message);
  periodId = pid;
}

// ===========================================================================
const pnl = await computePnl(owner, RANGE);
const mine = (await computePnl(owner, { ...RANGE, shopId: shop.id })).perShop.find(
  (r) => r.shop_id === shop.id
);

// ── 1. Revenue: approved only ─────────────────────────────────────────────
section("Revenue counts approved sales only");
{
  const EXPECTED = 4 * PART_PRICE + ENG_B_AGREED; // ₱1,000 + ₱95,000
  check(
    `shop revenue = ${P(EXPECTED)} — the recorded + pending sales are excluded`,
    mine?.revenue === EXPECTED,
    `got ${mine?.revenue}`
  );
  // Proof the excluded sales are real and simply not counted.
  const { count: openCount } = await owner
    .from("sales").select("id", { count: "exact", head: true })
    .eq("shop_id", shop.id).in("status", ["recorded", "pending"]).is("deleted_at", null);
  check("…and those 2 unapproved sales DO exist", (openCount ?? 0) === 2, `got ${openCount}`);
}

// ── 2. COGS: the actual cost of what sold ─────────────────────────────────
section("COGS is the real cost of the goods sold");
{
  const EXPECTED = 4 * PART_COST + ENG_B_COST; // ₱400 + ₱80,000
  check(
    `shop COGS = ${P(EXPECTED)} — per-item cost, not an estimate`,
    mine?.cogs === EXPECTED,
    `got ${mine?.cogs}`
  );
  check(
    `gross profit = ${P(4 * PART_PRICE + ENG_B_AGREED - (4 * PART_COST + ENG_B_COST))}`,
    mine?.gross_profit === 4 * PART_PRICE + ENG_B_AGREED - (4 * PART_COST + ENG_B_COST)
  );

  // The frozen basis: editing cost now must not move past profit.
  await admin.from("parts").update({ cost_centavos: 99_999 }).eq("id", part.id);
  const after = (await computePnl(owner, { ...RANGE, shopId: shop.id })).perShop[0];
  check(
    "raising the part's cost does NOT rewrite COGS already booked",
    after?.cogs === EXPECTED,
    `got ${after?.cogs}`
  );
  await admin.from("parts").update({ cost_centavos: PART_COST }).eq("id", part.id);
}

// ── 3. Losses at COST, never selling price ────────────────────────────────
section("Shrinkage is valued at cost");
{
  check(
    `damaged engine deducts its ${P(ENG_A_COST)} COST, not its ${P(3_500_000)} asking price`,
    mine?.losses === ENG_A_COST,
    `got ${mine?.losses}`
  );
  check(
    "…and the loss row itself stores cost",
    (await owner.from("losses").select("value_centavos").eq("shop_id", shop.id)
      .eq("status", "approved").single()).data?.value_centavos === ENG_A_COST
  );

  const transitDelta = pnl.transitWriteoffs - before.transitWriteoffs;
  check(
    `transit write-off adds exactly ${P(PART_COST)} — 1 part at cost`,
    transitDelta === PART_COST,
    `got ${transitDelta}`
  );
  const shrinkDelta = pnl.shrinkage - before.shrinkage;
  check(
    `shrinkage = shop losses + transit = ${P(ENG_A_COST + PART_COST)}`,
    shrinkDelta === ENG_A_COST + PART_COST,
    `got ${shrinkDelta}`
  );
}

// ── 4. Returns are not losses ────────────────────────────────────────────
section("A return is not a loss");
{
  check(
    "returning 2 parts adds NOTHING to this shop's losses",
    mine?.losses === ENG_A_COST,
    `got ${mine?.losses}`
  );
  const { data: types } = await owner
    .from("stock_movements").select("movement_type").eq("shop_id", shop.id);
  const set = new Set((types ?? []).map((t) => t.movement_type));
  check("the ledger tagged it `return`", set.has("return"));
  check(
    "…and the three-way separation holds: return ≠ loss ≠ transit_writeoff",
    set.has("return") && set.has("loss")
  );
}

// ── 5. Payroll = gross + employer share ──────────────────────────────────
section("Payroll costs gross + the employer's share");
{
  const { data: entries } = await owner
    .from("payroll_entries")
    .select("gross_pay, net_pay, payroll_entry_contributions(er_amount_centavos)")
    .eq("shop_id", shop.id).eq("pay_period_id", periodId);
  const gross = (entries ?? []).reduce((s, e) => s + e.gross_pay, 0);
  const er = (entries ?? []).reduce(
    (s, e) => s + (e.payroll_entry_contributions ?? []).reduce((t, c) => t + c.er_amount_centavos, 0),
    0
  );
  const net = (entries ?? []).reduce((s, e) => s + e.net_pay, 0);

  check("the employer share is non-zero (so this test can tell)", er > 0, `got ${er}`);
  check("net pay is genuinely below gross", net < gross, `net ${net} vs gross ${gross}`);
  check(
    `labor cost = gross + employer share = ${P(gross + er)}`,
    mine?.labor_cost === gross + er,
    `got ${mine?.labor_cost}`
  );
  check(
    "labor cost is NOT net pay — that would understate the shop",
    mine?.labor_cost !== net
  );
  check("employer share reported separately", mine?.payroll_er === er);
}

// ── 6. THE IDENTITY ──────────────────────────────────────────────────────
section("Reconciliation");
{
  // Exact, and global: true whatever else is in the database.
  check(
    "Σ shop net − company overhead − shrinkage = NET INCOME (exactly)",
    pnl.shopNetTotal - pnl.companyOverhead - pnl.shrinkage === pnl.netIncome,
    `${pnl.shopNetTotal} − ${pnl.companyOverhead} − ${pnl.shrinkage} ≠ ${pnl.netIncome}`
  );
  check(
    "net income also equals gross profit − shrinkage − opex − payroll",
    pnl.grossProfit - pnl.shrinkage - pnl.shopOpex - pnl.companyOverhead - pnl.laborCost ===
      pnl.netIncome
  );
  check(
    "gross profit = revenue − COGS",
    pnl.grossProfit === pnl.revenue - pnl.cogs
  );
  check(
    "company overhead is never allocated into a shop",
    pnl.perShop.every((r) => r.net_contribution === r.gross_profit - r.opex - r.labor_cost)
  );
  // The spec's identity, shown to be short by exactly the shrinkage.
  check(
    "…and WITHOUT the shrinkage term the identity is off by exactly the shrinkage",
    pnl.shopNetTotal - pnl.companyOverhead - pnl.netIncome === pnl.shrinkage
  );
}

// ── 7. The two pages share one computation ───────────────────────────────
section("/reports P&L and /shops/reports cannot disagree");
{
  // /shops/reports calls computePnl with a shopId; the P&L calls it without.
  // The same shop's row must come out identical either way — that is what
  // "shared computation" has to mean.
  const scoped = (await computePnl(owner, { ...RANGE, shopId: shop.id })).perShop.find(
    (r) => r.shop_id === shop.id
  );
  const unscoped = pnl.perShop.find((r) => r.shop_id === shop.id);
  for (const k of [
    "revenue", "cogs", "gross_profit", "gross_margin_pct", "losses", "opex",
    "payroll_gross", "payroll_er", "labor_cost", "net_contribution", "net_margin_pct",
  ]) {
    check(`${k} identical scoped vs consolidated`, scoped?.[k] === unscoped?.[k],
      `${scoped?.[k]} vs ${unscoped?.[k]}`);
  }
}

// ── 8. Cost vs selling ───────────────────────────────────────────────────
section("Cost vs selling");
{
  const engRevDelta = pnl.engineRevenue - before.engineRevenue;
  const engCogsDelta = pnl.engineCogs - before.engineCogs;
  const partRevDelta = pnl.partRevenue - before.partRevenue;
  const partCogsDelta = pnl.partCogs - before.partCogs;

  check(`engine revenue +${P(ENG_B_AGREED)}`, engRevDelta === ENG_B_AGREED, `got ${engRevDelta}`);
  check(`engine COGS +${P(ENG_B_COST)}`, engCogsDelta === ENG_B_COST, `got ${engCogsDelta}`);
  check(`part revenue +${P(4 * PART_PRICE)}`, partRevDelta === 4 * PART_PRICE, `got ${partRevDelta}`);
  check(`part COGS +${P(4 * PART_COST)}`, partCogsDelta === 4 * PART_COST, `got ${partCogsDelta}`);

  const discDelta = pnl.engineDiscount - before.engineDiscount;
  check(
    `discount given = asking ${P(ENG_B_ASKING)} − agreed ${P(ENG_B_AGREED)} = ${P(500_000)}`,
    discDelta === ENG_B_ASKING - ENG_B_AGREED,
    `got ${discDelta}`
  );
  check("…and it is attributed to the shop that gave it", mine?.engine_discount === 500_000,
    `got ${mine?.engine_discount}`);
}

// ── 9. Cash vs accrual ───────────────────────────────────────────────────
section("Cash is not the same as earned");
{
  const cash = await computeCashPosition(owner, RANGE);
  const earnedDelta = cash.earned - cashBefore.earned;
  const collectedDelta = cash.collected - cashBefore.collected;
  const outstandingDelta = cash.outstanding - cashBefore.outstanding;

  check(
    `earned +${P(4 * PART_PRICE + ENG_B_AGREED)} (accrual — utang counts on approval)`,
    earnedDelta === 4 * PART_PRICE + ENG_B_AGREED,
    `got ${earnedDelta}`
  );
  check(
    `collected +${P(4 * PART_PRICE + ENG_B_DOWN)} — the cash sale plus the downpayment only`,
    collectedDelta === 4 * PART_PRICE + ENG_B_DOWN,
    `got ${collectedDelta}`
  );
  check(
    "earned ≠ collected while there is utang — the whole point of the block",
    earnedDelta !== collectedDelta
  );
  check(
    `still owed +${P(ENG_B_AGREED - ENG_B_DOWN)}`,
    outstandingDelta === ENG_B_AGREED - ENG_B_DOWN,
    `got ${outstandingDelta}`
  );
  check(
    "collected + still owed = earned",
    collectedDelta + outstandingDelta === earnedDelta,
    `${collectedDelta} + ${outstandingDelta} ≠ ${earnedDelta}`
  );

  // Collecting utang moves cash without earning a peso more.
  const { data: sale } = await owner
    .from("receivables").select("sale_id").eq("shop_id", shop.id).gt("balance_centavos", 0).single();
  await emp.rpc("fn_record_utang_payment", {
    p_sale_id: sale.sale_id, p_amount_centavos: 1_000_000, p_note: `ZZ-TEST ${RUN}`,
  });
  const after = await computeCashPosition(owner, RANGE);
  check(
    "a ₱10,000 utang payment raises collected but not earned",
    after.collected - cash.collected === 1_000_000 && after.earned === cash.earned,
    `collected +${after.collected - cash.collected}, earned +${after.earned - cash.earned}`
  );
  const pnlAfter = await computePnl(owner, RANGE);
  check(
    "…and it does not move net income by a centavo",
    pnlAfter.netIncome === pnl.netIncome
  );
}

// ── 10. Supplier payments are COGS, never opex ───────────────────────────
section("Supplier payments stay out of operating expenses");
{
  const sup = await seedSupplier({ label: "PnL Sup", credit_limit: 100_000_00 });
  const rid = await receive({
    supplier_id: sup.id,
    parts: [{ part_id: part.id, qty: 1, unit_cost_centavos: PART_COST }],
    payment_status: "unpaid",
  });
  await owner.rpc("fn_record_supplier_payment", {
    p_supplier_id: sup.id, p_receiving_id: rid, p_amount: PART_COST,
    p_note: `ZZ-TEST ${RUN}`, p_receipt_path: null,
  });
  const { data: leaked } = await owner
    .from("expenses").select("id").like("description", `%${RUN}%`).eq("scope", "company");
  check("paying a supplier created no company expense", (leaked ?? []).length === 0);

  const opexNow = (await computePnl(owner, RANGE)).shopOpex;
  check(
    `shop opex is still just the ${P(EXP_SHOP)} expense`,
    opexNow - before.shopOpex === EXP_SHOP,
    `got ${opexNow - before.shopOpex}`
  );
}

// ── 11. None of this is reachable from a shop ────────────────────────────
section("No shop-side access");
{
  // The P&L must REFUSE a shop, not quietly return less.
  //
  // This assertion started life as "employee sees ₱0 revenue" and failed: it
  // returned ₱96,000. RLS lets a shop read its own sales (it must, to submit
  // them) while hiding cost, expenses and payroll — so every query succeeded
  // and the arithmetic reported gross profit = revenue and a net income made
  // entirely of revenue. A believable wrong number is worse than an error, so
  // the module now refuses outright.
  let refused = null;
  try {
    await computePnl(emp, RANGE);
  } catch (e) {
    refused = e.message;
  }
  check("computePnl REFUSES an employee", !!refused && /owner/i.test(refused), String(refused));

  let cashRefused = null;
  try {
    await computeCashPosition(emp, RANGE);
  } catch (e) {
    cashRefused = e.message;
  }
  check(
    "computeCashPosition refuses an employee too",
    !!cashRefused && /owner/i.test(cashRefused),
    String(cashRefused)
  );

  // And the reason it must refuse rather than return zeroes: the inputs a P&L
  // needs are invisible to a shop, but the revenue is not.
  const { data: ownSales } = await emp
    .from("sales").select("total_centavos").eq("shop_id", shop.id).eq("status", "approved");
  check(
    "…because a shop CAN see its own sales — it just cannot see any cost",
    (ownSales ?? []).length > 0
  );

  for (const t of ["sale_line_costs", "expenses", "payroll_entries", "stock_movements"]) {
    const { data } = await emp.from(t).select("*").limit(3);
    check(`employee reads nothing from ${t}`, (data ?? []).length === 0, `got ${data?.length}`);
  }
  const shopStock = await emp.from("shop_stock").select("*").limit(1);
  check(
    "the safe view still strips cost",
    !shopStock.data?.[0] || !("cost_centavos" in shopStock.data[0])
  );
}

section("Cleanup");
await admin.from("pay_periods").delete().eq("id", periodId);
await cleanup();
summary();
